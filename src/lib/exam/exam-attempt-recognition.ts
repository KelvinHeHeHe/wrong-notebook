import 'server-only';

import type { Prisma, User } from '@prisma/client';

import { getAIService } from '@/lib/ai';
import { parseErrorCode } from '@/lib/ai/error-classification';
import type { AIService } from '@/lib/ai/types';
import { consumeAiQuota } from '@/lib/ai-quota';
import { conflict, createErrorResponse, ErrorCode, notFound, validationError } from '@/lib/api-errors';
import type { ApiErrorResponse } from '@/lib/api-errors';
import {
    buildAttemptPageRecognition, matchExamAnswerCandidates, parseAttemptPageRecognition,
    readAttemptRegionPageOrder, requiresExamAnswerReview, resolveExamAnswerCandidateTargets, serializeAttemptPageRecognition, suggestExamAnswerScore,
} from '@/lib/exam/exam-attempt';
import type { ExamAttemptAnswerCandidate, ExamAttemptMatchQuestion, ExamAttemptPageRecognition } from '@/lib/exam/exam-attempt';
import { buildExamPrintLayout } from '@/lib/exam/exam-sections';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { normalizeQuestionType } from '@/lib/question/question-type';

const logger = createLogger('exam-attempt-recognition');
const attemptInclude = {
    pages: { orderBy: { order: 'asc' as const } },
    answers: true,
    paper: { include: { questions: { orderBy: { order: 'asc' as const }, include: { errorItem: { select: { questionType: true } } } } } },
} satisfies Prisma.ExamAttemptInclude;
type Attempt = Prisma.ExamAttemptGetPayload<{ include: typeof attemptInclude }>;
const currentSelect = {
    userId: true, status: true, updatedAt: true,
    pages: { select: { id: true, checksum: true } },
    answers: { select: { id: true, examQuestionId: true, reviewStatus: true, gradingSource: true, regionJson: true } },
} satisfies Prisma.ExamAttemptSelect;
type CurrentAttempt = Prisma.ExamAttemptGetPayload<{ select: typeof currentSelect }>;
type Question = Attempt['paper']['questions'][number];
type Page = Attempt['pages'][number];
type AnswerDraft = Omit<Prisma.ExamAttemptAnswerUncheckedCreateInput, 'attemptId' | 'examQuestionId'>;

export class ExamAttemptRecognitionError extends Error {
    constructor(public readonly response: Response) {
        super('EXAM_ATTEMPT_RECOGNITION_REJECTED');
    }
}

class StaleRecognitionError extends Error {}

export interface RecognizeExamAttemptPagesInput {
    attemptId: string;
    user: User;
    pageOrders: number[];
    language: 'zh' | 'en';
    expectedUpdatedAt: string;
    replaceReviewed?: boolean;
}

function reject(message: string, status: number): never {
    const response = status === 404 ? notFound(message) : status === 409 ? conflict(message) : validationError(message);
    throw new ExamAttemptRecognitionError(response);
}

function nextVersion(previous: Date): Date {
    return new Date(Math.max(Date.now(), previous.getTime() + 1));
}

/** 失败时合并同一图片的旧材料与本轮候选；稳定 ID 去重，来源引用保持有效。 */
function buildFailureRecognition(page: Page, recognition: ExamAttemptPageRecognition, errorCode: string): ExamAttemptPageRecognition {
    const previous = page.recognitionResult ? parseAttemptPageRecognition(page.recognitionResult) : null;
    const candidates = new Map<string, ExamAttemptAnswerCandidate>();
    for (const candidate of [...(previous?.candidates ?? []), ...recognition.candidates]) {
        candidates.set(candidate.candidateId, {
            ...candidate, regions: candidate.regions.filter((region) => region.width > 0 && region.height > 0),
        });
    }
    return { ...recognition, status: 'failed', errorCode, candidates: [...candidates.values()] };
}

function preserveManualAnswer(answer: { reviewStatus: string; gradingSource: string | null }, replaceReviewed: boolean): boolean {
    return !replaceReviewed && (answer.reviewStatus === 'reviewed'
        || (answer.reviewStatus === 'required' && answer.gradingSource === 'manual'));
}

/** 只检查本次成功页触及的题；失败信封是复核材料，不作为当前自动认领。 */
function competingQuestionIds(
    pages: Array<{ order: number; recognitionResult: string | null }>,
    answers: Array<{ examQuestionId: string; regionJson: string | null }>,
    questions: ExamAttemptMatchQuestion[],
    pageOrder: number,
): string[] {
    const claims = new Map<string, Set<number>>();
    const touched = new Set<string>();
    const repeated = new Set<string>();
    const addClaim = (questionId: string, order: number) => {
        const owners = claims.get(questionId) ?? new Set<number>();
        owners.add(order);
        claims.set(questionId, owners);
    };
    for (const page of pages) {
        const recognition = page.recognitionResult ? parseAttemptPageRecognition(page.recognitionResult) : null;
        if (recognition?.status !== 'succeeded') continue;
        const counts = new Map<string, number>();
        for (const match of resolveExamAnswerCandidateTargets(recognition.candidates, questions)) {
            addClaim(match.questionId, page.order);
            counts.set(match.questionId, (counts.get(match.questionId) ?? 0) + 1);
            if (page.order === pageOrder) {
                touched.add(match.questionId);
                if (counts.get(match.questionId)! > 1) repeated.add(match.questionId);
            }
        }
    }
    const existingOrders = new Set(pages.map((page) => page.order));
    for (const answer of answers) {
        const owner = readAttemptRegionPageOrder(answer.regionJson);
        if (owner !== null && existingOrders.has(owner)) addClaim(answer.examQuestionId, owner);
    }
    return [...touched].filter((questionId) => repeated.has(questionId) || (claims.get(questionId)?.size ?? 0) > 1);
}

function checkCurrent(current: CurrentAttempt | null, userId: string, version: Date, page?: Page): asserts current is CurrentAttempt {
    if (!current || current.userId !== userId) throw new StaleRecognitionError('EXAM_ATTEMPT_CHANGED');
    if (current.status === 'confirmed') throw new StaleRecognitionError('EXAM_ATTEMPT_ALREADY_CONFIRMED');
    if (current.status !== 'recognizing' || current.updatedAt.getTime() !== version.getTime()) {
        throw new StaleRecognitionError('EXAM_ATTEMPT_CHANGED');
    }
    if (page && !current.pages.some((saved) => saved.id === page.id && saved.checksum === page.checksum)) {
        throw new StaleRecognitionError('EXAM_PAGE_CHANGED');
    }
}

async function gradeCandidate(
    service: AIService, question: Question, candidate: ExamAttemptAnswerCandidate,
    pageOrder: number, language: 'zh' | 'en',
): Promise<AnswerDraft> {
    let result: 'correct' | 'wrong' | 'not_attempted' | null = candidate.notAttempted ? 'not_attempted' : null;
    let reason: string | null = null;
    let gradingFailed = false;
    let gradingSource: string | null = null;
    if (!candidate.notAttempted && candidate.recognizedAnswer?.trim() && question.answerText?.trim()) {
        try {
            const grading = await service.gradeAnswer({
                questionText: question.questionText ?? '', answerText: question.answerText,
                analysis: question.analysis, userAnswer: candidate.recognizedAnswer, language,
            });
            result = grading.correct ? 'correct' : 'wrong';
            reason = grading.reason;
            gradingSource = 'ai';
        } catch (error) {
            gradingFailed = true;
            logger.warn({ pageOrder, questionId: question.id, errorCode: parseErrorCode(error) }, '逐题判分失败');
        }
    }
    return {
        recognizedAnswer: candidate.recognizedAnswer, result,
        awardedScore: suggestExamAnswerScore(result, question.score ?? 0), maxScore: question.score,
        gradingSource, gradingReason: reason, confidence: candidate.confidence,
        reviewStatus: requiresExamAnswerReview({
            confidence: candidate.confidence, questionType: question.questionType ?? question.errorItem?.questionType ?? null, answerKey: question.answerText,
            maxScore: question.score, result, gradingFailed, notAttempted: candidate.notAttempted,
        }) ? 'required' : 'pending',
        regionJson: JSON.stringify({ pageOrder, candidateId: candidate.candidateId, regions: candidate.regions }),
    };
}

/** 一次操作共用额度和路由服务；每页独立保存，迟到结果不得覆盖人工修改。 */
export async function recognizeExamAttemptPages(input: RecognizeExamAttemptPagesInput) {
    const { attemptId, user, pageOrders, language, replaceReviewed = false } = input;
    const attempt = await prisma.examAttempt.findUnique({ where: { id: attemptId, userId: user.id }, include: attemptInclude });
    if (!attempt || attempt.userId !== user.id) reject('Exam attempt not found', 404);
    if (attempt.status === 'confirmed') reject('EXAM_ATTEMPT_ALREADY_CONFIRMED', 409);
    const expected = new Date(input.expectedUpdatedAt);
    if (attempt.updatedAt.getTime() !== expected.getTime()) reject('EXAM_ATTEMPT_CHANGED', 409);
    const pages = pageOrders.map((order) => attempt.pages.find((page) => page.order === order));
    if (pages.some((page) => !page)) reject('EXAM_PAGE_NOT_FOUND', 400);

    let version = nextVersion(expected);
    const lock = await prisma.examAttempt.updateMany({
        where: { id: attemptId, userId: user.id, updatedAt: expected, status: { not: 'confirmed' } },
        data: { status: 'recognizing', updatedAt: version },
    });
    if (!lock.count) reject('EXAM_ATTEMPT_CHANGED', 409);

    const limited = await consumeAiQuota(user, 'grade');
    if (limited) {
        // 使用新版本释放锁，避免恢复旧版本产生 ABA；并发修改后只返回最新状态。
        await prisma.examAttempt.updateMany({
            where: { id: attemptId, userId: user.id, status: 'recognizing', updatedAt: version },
            data: { status: attempt.status === 'recognizing' ? 'uploaded' : attempt.status, updatedAt: nextVersion(version) },
        });
        const latest = await prisma.examAttempt.findUnique({ where: { id: attemptId, userId: user.id }, select: { status: true, updatedAt: true } });
        const body: unknown = await limited.clone().json().catch(() => null);
        if (!latest || !body || typeof body !== 'object' || Array.isArray(body)) throw new ExamAttemptRecognitionError(limited);
        const headers = new Headers(limited.headers);
        headers.delete('content-length');
        throw new ExamAttemptRecognitionError(Response.json({ ...body, status: latest.status, updatedAt: latest.updatedAt.toISOString() }, { status: limited.status, headers }));
    }

    let service: AIService | null = null;
    let serviceError = 'AI_UNKNOWN_ERROR';
    try {
        service = await getAIService({ userId: user.id, kind: 'grade' });
    } catch (error) {
        serviceError = parseErrorCode(error);
    }
    const successes: Array<{ pageOrder: number; candidateCount: number; matchedCount: number }> = [];
    const failures: Array<{ pageOrder: number; error: string }> = [];
    let staleCode: string | null = null;
    const readCurrent = async (page?: Page) => {
        const current = await prisma.examAttempt.findUnique({ where: { id: attemptId, userId: user.id }, select: currentSelect });
        checkCurrent(current, user.id, version, page);
        return current;
    };
    const printLayout = buildExamPrintLayout(attempt.paper.questions.map((question) => {
        const linkedType = normalizeQuestionType(question.errorItem?.questionType);
        return {
            ...question, questionType: normalizeQuestionType(question.questionType),
            errorItem: question.errorItem ? { questionType: linkedType } : null, errorItemQuestionType: linkedType,
        };
    }), attempt.paper.groupByType, language);
    const context = printLayout.items.slice(0, 100).map(({ question, displayNumber }) => ({
        id: question.id, displayNumber, sourceShortId: question.sourceShortId,
        questionText: (question.questionText ?? '').slice(0, 160),
    }));
    const matchingQuestions = printLayout.items.map(({ question, displayNumber }) => ({
        id: question.id, sourceShortId: question.sourceShortId, displayNumber,
    }));

    for (const page of pages) {
        if (!page) continue;
        if (staleCode) {
            failures.push({ pageOrder: page.order, error: staleCode });
            continue;
        }
        let envelope;
        const drafts = new Map<string, AnswerDraft>();
        let matchedCount = 0;
        try {
            await readCurrent(page);
            if (!service) throw new Error(serviceError);
            const extracted = await service.extractExamPageAnswers({
                imageBase64: page.imageData.replace(/^data:[^,]*,/, ''), mimeType: page.mimeType,
                questions: context, language,
            });
            const current = await readCurrent(page);
            envelope = buildAttemptPageRecognition(page.order, {
                candidates: extracted.candidates.map((candidate) => ({
                    ...candidate, regions: candidate.regions.filter((region) => region.width > 0 && region.height > 0),
                })),
            }, new Date().toISOString());
            const matching = matchExamAnswerCandidates(envelope.candidates, matchingQuestions);
            const ownedMatches = matching.matches.filter((match) => {
                const existing = current.answers.find((answer) => answer.examQuestionId === match.questionId);
                const owner = readAttemptRegionPageOrder(existing?.regionJson);
                return owner === null || owner === page.order;
            });
            matchedCount = ownedMatches.length;
            for (const match of ownedMatches) {
                if (current.answers.some((answer) => answer.examQuestionId === match.questionId && preserveManualAnswer(answer, replaceReviewed))) continue;
                await readCurrent(page);
                const question = printLayout.questions.find((item) => item.id === match.questionId)!;
                const candidate = envelope.candidates.find((item) => item.candidateId === match.candidateId)!;
                drafts.set(question.id, await gradeCandidate(service, question, candidate, page.order, language));
                await readCurrent(page);
            }
        } catch (error) {
            if (error instanceof StaleRecognitionError) {
                staleCode = error.message;
                failures.push({ pageOrder: page.order, error: staleCode });
                continue;
            }
            const errorCode = parseErrorCode(error);
            envelope = buildFailureRecognition(page, buildAttemptPageRecognition(page.order, null, new Date().toISOString(), errorCode), errorCode);
            logger.warn({ attemptId, pageOrder: page.order, errorCode }, '作答页面识别失败');
        }

        const persistPage = (recognition: ExamAttemptPageRecognition) => prisma.$transaction(async (tx) => {
            const current = await tx.examAttempt.findUnique({
                where: { id: attemptId, userId: user.id },
                select: { ...currentSelect, pages: { select: { id: true, order: true, checksum: true, recognitionResult: true } } },
            });
            checkCurrent(current, user.id, version, page);
            const updatedAt = nextVersion(version);
            const saved = await tx.examAttempt.updateMany({
                where: { id: attemptId, userId: user.id, status: 'recognizing', updatedAt: version },
                data: { updatedAt },
            });
            if (!saved.count) throw new StaleRecognitionError('EXAM_ATTEMPT_CHANGED');
            await tx.examAttemptPage.update({ where: { id: page.id }, data: { recognitionResult: serializeAttemptPageRecognition(recognition) } });
            // 提取失败保留已有草稿；成功重识别才清除该页不再匹配的非人工答案。
            if (recognition.status === 'succeeded') {
                const obsolete = current.answers.filter((answer) => answer.reviewStatus !== 'reviewed' && !preserveManualAnswer(answer, replaceReviewed)
                    && readAttemptRegionPageOrder(answer.regionJson) === page.order && !drafts.has(answer.examQuestionId));
                if (obsolete.length) await tx.examAttemptAnswer.deleteMany({
                    where: { attemptId, id: { in: obsolete.map((answer) => answer.id) }, reviewStatus: { not: 'reviewed' } },
                });
                for (const [examQuestionId, data] of drafts) {
                    const existing = current.answers.find((answer) => answer.examQuestionId === examQuestionId);
                    const owner = readAttemptRegionPageOrder(existing?.regionJson);
                    if (owner !== null && owner !== page.order) continue;
                    if (existing) {
                        await tx.examAttemptAnswer.updateMany({
                            where: { id: existing.id, attemptId, ...(!replaceReviewed ? { reviewStatus: { not: 'reviewed' } } : {}) }, data,
                        });
                    } else await tx.examAttemptAnswer.create({ data: { attemptId, examQuestionId, ...data } });
                }
                const retained = current.answers.filter((answer) => !obsolete.some((removed) => removed.id === answer.id));
                const competing = competingQuestionIds(
                    current.pages.map((savedPage) => savedPage.id === page.id
                        ? { ...savedPage, recognitionResult: serializeAttemptPageRecognition(recognition) } : savedPage),
                    [...retained, ...[...drafts].map(([examQuestionId, data]) => ({ examQuestionId, regionJson: data.regionJson ?? null }))],
                    matchingQuestions, page.order,
                );
                if (competing.length) await tx.examAttemptAnswer.updateMany({
                    where: { attemptId, examQuestionId: { in: competing } }, data: { reviewStatus: 'required' },
                });
            }
            return updatedAt;
        });
        try {
            version = await persistPage(envelope);
            if (envelope.status === 'succeeded') successes.push({ pageOrder: page.order, candidateCount: envelope.candidates.length, matchedCount });
            else failures.push({ pageOrder: page.order, error: envelope.errorCode! });
        } catch (error) {
            if (error instanceof StaleRecognitionError) {
                staleCode = error.message;
                failures.push({ pageOrder: page.order, error: staleCode });
                continue;
            }
            const errorCode = 'EXAM_PAGE_SAVE_FAILED';
            logger.warn({ attemptId, pageOrder: page.order, errorCode }, '保存作答页面失败');
            failures.push({ pageOrder: page.order, error: errorCode });
            // 单页事务已回滚；尽力保存失败材料，后续页面仍继续处理。
            try {
                version = await persistPage(buildFailureRecognition(page, envelope, errorCode));
            } catch (retryError) {
                if (retryError instanceof StaleRecognitionError) staleCode = retryError.message;
                else logger.warn({ attemptId, pageOrder: page.order, errorCode }, '保存页面失败信封失败');
            }
        }
    }

    let finalizeFailed = false;
    if (!staleCode) {
        let finalStatus: 'review' | 'failed' | null = null;
        const finalize = () => prisma.$transaction(async (tx) => {
            const current = await tx.examAttempt.findUnique({
                where: { id: attemptId, userId: user.id },
                select: {
                    ...currentSelect,
                    pages: { select: { id: true, checksum: true, recognitionResult: true } },
                    answers: { select: { ...currentSelect.answers.select, recognizedAnswer: true, result: true } },
                },
            });
            checkCurrent(current, user.id, version);
            const hasResults = current.pages.some((page) => {
                const recognition = page.recognitionResult ? parseAttemptPageRecognition(page.recognitionResult) : null;
                return recognition !== null && (recognition.status === 'succeeded' || recognition.candidates.length > 0);
            }) || current.answers.some((answer) => answer.reviewStatus === 'reviewed' || answer.recognizedAnswer !== null
                || answer.result !== null || readAttemptRegionPageOrder(answer.regionJson) !== null);
            finalStatus = hasResults ? 'review' : 'failed';
            const updatedAt = nextVersion(version);
            const saved = await tx.examAttempt.updateMany({
                where: { id: attemptId, userId: user.id, status: 'recognizing', updatedAt: version },
                data: { status: finalStatus, updatedAt },
            });
            if (!saved.count) throw new StaleRecognitionError('EXAM_ATTEMPT_CHANGED');
            for (const question of printLayout.questions) {
                if (!current.answers.some((answer) => answer.examQuestionId === question.id)) {
                    await tx.examAttemptAnswer.create({ data: {
                        attemptId, examQuestionId: question.id, recognizedAnswer: null, result: null,
                        awardedScore: null, maxScore: question.score, gradingSource: null, gradingReason: null,
                        confidence: null, reviewStatus: 'required', regionJson: null,
                    } });
                }
            }
        });
        for (let retry = 0; retry < 2; retry += 1) {
            try {
                await finalize();
                break;
            } catch (error) {
                // 新请求已接管或人工已改动时，不再重试旧调用。
                if (error instanceof StaleRecognitionError) break;
                logger.warn({ attemptId, errorCode: 'EXAM_ATTEMPT_FINALIZE_FAILED', attempt: retry + 1 }, '补齐作答占位失败');
                if (retry === 0) continue;
                if (finalStatus === null) throw error;
                // 持续失败仍须释放状态，但向调用方明确返回批次收尾错误。
                await prisma.examAttempt.updateMany({
                    where: { id: attemptId, userId: user.id, status: 'recognizing', updatedAt: version },
                    data: { status: finalStatus, updatedAt: nextVersion(version) },
                });
                finalizeFailed = true;
            }
        }
    }
    const latest = await prisma.examAttempt.findUnique({ where: { id: attemptId, userId: user.id }, select: { status: true, updatedAt: true } });
    const result = { successes, failures, status: latest?.status ?? 'failed', updatedAt: latest?.updatedAt.toISOString() ?? version.toISOString() };
    if (finalizeFailed) {
        const response = createErrorResponse('EXAM_ATTEMPT_FINALIZE_FAILED', 503, ErrorCode.DATABASE_ERROR, { phase: 'finalize', retryable: true });
        const body = await response.json() as ApiErrorResponse;
        throw new ExamAttemptRecognitionError(Response.json({ ...body, ...result }, { status: response.status, headers: response.headers }));
    }
    return result;
}
