import 'server-only';

import type { Prisma, User } from '@prisma/client';

import { getAIService } from '@/lib/ai';
import { parseErrorCode } from '@/lib/ai/error-classification';
import type { AIService } from '@/lib/ai/types';
import { consumeAiQuota } from '@/lib/ai-quota';
import { conflict, notFound, validationError } from '@/lib/api-errors';
import {
    buildAttemptPageRecognition, matchExamAnswerCandidates, parseAttemptPageRecognition,
    parseAttemptRegionJson, requiresExamAnswerReview, serializeAttemptPageRecognition, suggestExamAnswerScore,
} from '@/lib/exam/exam-attempt';
import type { ExamAttemptAnswerCandidate, ExamAttemptPageRecognition } from '@/lib/exam/exam-attempt';
import { buildExamPrintLayout } from '@/lib/exam/exam-sections';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { MAX_IMPORTED_EXAM_PAGES } from '@/lib/schemas/exam';

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
    answers: { select: { id: true, examQuestionId: true, reviewStatus: true, regionJson: true } },
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

/** 旧版退化区域可能无法完整解析；只恢复经过校验的页归属，不复用坏坐标。 */
function answerPageOrder(raw: string | null | undefined): number | null {
    const region = parseAttemptRegionJson(raw);
    if (region) return region.pageOrder;
    if (!raw) return null;
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const order = (value as { pageOrder?: unknown }).pageOrder;
        return typeof order === 'number' && Number.isInteger(order) && order >= 1 && order <= MAX_IMPORTED_EXAM_PAGES ? order : null;
    } catch {
        return null;
    }
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
    const printLayout = buildExamPrintLayout(attempt.paper.questions.map((question) => ({
        ...question, errorItemQuestionType: question.errorItem?.questionType ?? null,
    })), attempt.paper.groupByType, language);
    const context = printLayout.items.slice(0, 100).map(({ question, displayNumber }) => ({
        id: question.id, displayNumber, sourceShortId: question.sourceShortId,
        questionText: (question.questionText ?? '').slice(0, 160),
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
            const matching = matchExamAnswerCandidates(envelope.candidates, printLayout.items.map(({ question, displayNumber }) => ({
                id: question.id, sourceShortId: question.sourceShortId, displayNumber,
            })));
            const ownedMatches = matching.matches.filter((match) => {
                const existing = current.answers.find((answer) => answer.examQuestionId === match.questionId);
                const owner = answerPageOrder(existing?.regionJson);
                return owner === null || owner === page.order;
            });
            matchedCount = ownedMatches.length;
            for (const match of ownedMatches) {
                if (!replaceReviewed && current.answers.some((answer) => answer.examQuestionId === match.questionId && answer.reviewStatus === 'reviewed')) continue;
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
            envelope = buildAttemptPageRecognition(page.order, null, new Date().toISOString(), errorCode);
            // 同一图片失败重试不能抹掉先前尚待人工映射的候选。
            const previous = page.recognitionResult ? parseAttemptPageRecognition(page.recognitionResult) : null;
            if (previous) envelope.candidates = previous.candidates.map((candidate) => ({
                ...candidate, regions: candidate.regions.filter((region) => region.width > 0 && region.height > 0),
            }));
            logger.warn({ attemptId, pageOrder: page.order, errorCode }, '作答页面识别失败');
        }

        const persistPage = (recognition: ExamAttemptPageRecognition) => prisma.$transaction(async (tx) => {
            const current = await tx.examAttempt.findUnique({ where: { id: attemptId, userId: user.id }, select: currentSelect });
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
                const obsolete = current.answers.filter((answer) => answer.reviewStatus !== 'reviewed'
                    && answerPageOrder(answer.regionJson) === page.order && !drafts.has(answer.examQuestionId));
                if (obsolete.length) await tx.examAttemptAnswer.deleteMany({
                    where: { attemptId, id: { in: obsolete.map((answer) => answer.id) }, reviewStatus: { not: 'reviewed' } },
                });
                for (const [examQuestionId, data] of drafts) {
                    const existing = current.answers.find((answer) => answer.examQuestionId === examQuestionId);
                    const owner = answerPageOrder(existing?.regionJson);
                    if (owner !== null && owner !== page.order) continue;
                    if (existing) {
                        await tx.examAttemptAnswer.updateMany({
                            where: { id: existing.id, attemptId, ...(!replaceReviewed ? { reviewStatus: { not: 'reviewed' } } : {}) }, data,
                        });
                    } else await tx.examAttemptAnswer.create({ data: { attemptId, examQuestionId, ...data } });
                }
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
                version = await persistPage({ ...envelope, status: 'failed', errorCode });
            } catch (retryError) {
                if (retryError instanceof StaleRecognitionError) staleCode = retryError.message;
                else logger.warn({ attemptId, pageOrder: page.order, errorCode }, '保存页面失败信封失败');
            }
        }
    }

    if (!staleCode) {
        let finalStatus: 'review' | 'failed' | null = null;
        try {
            await prisma.$transaction(async (tx) => {
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
                    || answer.result !== null || answerPageOrder(answer.regionJson) !== null);
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
        } catch (error) {
            if (!(error instanceof StaleRecognitionError)) {
                if (finalStatus === null) throw error;
                logger.warn({ attemptId, errorCode: 'EXAM_ATTEMPT_FINALIZE_FAILED' }, '补齐作答占位失败');
                // 占位写入失败不应占住识别状态；仍以同一版本锁保护最终状态。
                await prisma.examAttempt.updateMany({
                    where: { id: attemptId, userId: user.id, status: 'recognizing', updatedAt: version },
                    data: { status: finalStatus, updatedAt: nextVersion(version) },
                });
            }
            // 新请求已接管或人工已改动时，不再更新旧调用的状态和占位。
        }
    }
    const latest = await prisma.examAttempt.findUnique({ where: { id: attemptId, userId: user.id }, select: { status: true, updatedAt: true } });
    return { successes, failures, status: latest?.status ?? 'failed', updatedAt: latest?.updatedAt.toISOString() ?? version.toISOString() };
}
