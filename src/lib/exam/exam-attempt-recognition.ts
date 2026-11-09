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
import type { ExamAttemptAnswerCandidate } from '@/lib/exam/exam-attempt';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';

const logger = createLogger('exam-attempt-recognition');
const attemptInclude = {
    pages: { orderBy: { order: 'asc' as const } },
    answers: true,
    paper: { include: { questions: { orderBy: { order: 'asc' as const } } } },
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
            confidence: candidate.confidence, questionType: question.questionType, answerKey: question.answerText,
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

    const limited = await consumeAiQuota(user, 'grade');
    if (limited) throw new ExamAttemptRecognitionError(limited);
    let version = nextVersion(expected);
    const lock = await prisma.examAttempt.updateMany({
        where: { id: attemptId, userId: user.id, updatedAt: expected, status: { not: 'confirmed' } },
        data: { status: 'recognizing', updatedAt: version },
    });
    if (!lock.count) reject('EXAM_ATTEMPT_CHANGED', 409);

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
    const context = attempt.paper.questions.slice(0, 100).map((question) => ({
        id: question.id, displayNumber: question.order, sourceShortId: question.sourceShortId,
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
            envelope = buildAttemptPageRecognition(page.order, extracted, new Date().toISOString());
            const matching = matchExamAnswerCandidates(envelope.candidates, attempt.paper.questions.map((question) => ({
                id: question.id, sourceShortId: question.sourceShortId, displayNumber: question.order,
            })));
            matchedCount = matching.matches.length;
            for (const match of matching.matches) {
                if (!replaceReviewed && current.answers.some((answer) => answer.examQuestionId === match.questionId && answer.reviewStatus === 'reviewed')) continue;
                await readCurrent(page);
                const question = attempt.paper.questions.find((item) => item.id === match.questionId)!;
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
            logger.warn({ attemptId, pageOrder: page.order, errorCode }, '作答页面识别失败');
        }

        try {
            const savedVersion = await prisma.$transaction(async (tx) => {
                const current = await tx.examAttempt.findUnique({ where: { id: attemptId, userId: user.id }, select: currentSelect });
                checkCurrent(current, user.id, version, page);
                const updatedAt = nextVersion(version);
                const saved = await tx.examAttempt.updateMany({
                    where: { id: attemptId, userId: user.id, status: 'recognizing', updatedAt: version },
                    data: { updatedAt },
                });
                if (!saved.count) throw new StaleRecognitionError('EXAM_ATTEMPT_CHANGED');
                await tx.examAttemptPage.update({ where: { id: page.id }, data: { recognitionResult: serializeAttemptPageRecognition(envelope) } });
                // 提取失败保留已有草稿；成功重识别才清除该页不再匹配的非人工答案。
                if (envelope.status === 'succeeded') {
                    const obsolete = current.answers.filter((answer) => answer.reviewStatus !== 'reviewed'
                        && parseAttemptRegionJson(answer.regionJson)?.pageOrder === page.order && !drafts.has(answer.examQuestionId));
                    if (obsolete.length) await tx.examAttemptAnswer.deleteMany({
                        where: { attemptId, id: { in: obsolete.map((answer) => answer.id) }, reviewStatus: { not: 'reviewed' } },
                    });
                    for (const [examQuestionId, data] of drafts) {
                        const existing = current.answers.find((answer) => answer.examQuestionId === examQuestionId);
                        if (existing) {
                            await tx.examAttemptAnswer.updateMany({
                                where: { id: existing.id, attemptId, ...(!replaceReviewed ? { reviewStatus: { not: 'reviewed' } } : {}) }, data,
                            });
                        } else await tx.examAttemptAnswer.create({ data: { attemptId, examQuestionId, ...data } });
                    }
                }
                return updatedAt;
            });
            version = savedVersion;
            if (envelope.status === 'succeeded') successes.push({ pageOrder: page.order, candidateCount: envelope.candidates.length, matchedCount });
            else failures.push({ pageOrder: page.order, error: envelope.errorCode! });
        } catch (error) {
            if (!(error instanceof StaleRecognitionError)) throw error;
            staleCode = error.message;
            failures.push({ pageOrder: page.order, error: staleCode });
        }
    }

    if (!staleCode) {
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
                const hasResults = current.pages.some((page) => page.recognitionResult && parseAttemptPageRecognition(page.recognitionResult)?.status === 'succeeded')
                    || current.answers.some((answer) => answer.reviewStatus === 'reviewed' || answer.recognizedAnswer !== null || answer.result !== null);
                const updatedAt = nextVersion(version);
                const saved = await tx.examAttempt.updateMany({
                    where: { id: attemptId, userId: user.id, status: 'recognizing', updatedAt: version },
                    data: { status: hasResults ? 'review' : 'failed', updatedAt },
                });
                if (!saved.count) throw new StaleRecognitionError('EXAM_ATTEMPT_CHANGED');
                for (const question of attempt.paper.questions) {
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
            if (!(error instanceof StaleRecognitionError)) throw error;
            // 新请求已接管或人工已改动时，不再更新旧调用的状态和占位。
        }
    }
    const latest = await prisma.examAttempt.findUnique({ where: { id: attemptId, userId: user.id }, select: { status: true, updatedAt: true } });
    return { successes, failures, status: latest?.status ?? 'failed', updatedAt: latest?.updatedAt.toISOString() ?? version.toISOString() };
}
