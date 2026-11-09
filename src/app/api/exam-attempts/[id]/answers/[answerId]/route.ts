import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';

import { getAIService } from '@/lib/ai';
import { consumeAiQuota } from '@/lib/ai-quota';
import { conflict, internalError, notFound, validationError } from '@/lib/api-errors';
import { withUser } from '@/lib/api-handler';
import type { AuthenticatedContext } from '@/lib/api-handler';
import { runSerializedTransaction } from '@/lib/db-write-queue';
import { parseAttemptPageRecognition, parseAttemptRegionJson, suggestExamAnswerScore } from '@/lib/exam/exam-attempt';
import { normalizeExamScore } from '@/lib/exam/exam-score';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { withRecoverableResponse } from '@/lib/recoverable-response';
import { updateExamAttemptAnswerSchema } from '@/lib/schemas/exam-attempt';

const logger = createLogger('api:exam-attempts:answers');

class ReviewError extends Error {
    constructor(readonly response: Response) { super('EXAM_ATTEMPT_REVIEW_REJECTED'); }
}

const nextVersion = (previous: Date) => new Date(Math.max(Date.now(), previous.getTime() + 1));

export const PATCH = withRecoverableResponse(withUser(async (
    req: Request,
    { user, params }: AuthenticatedContext & { params: Promise<{ id: string; answerId: string }> },
) => {
    const { id, answerId } = await params;
    let owned = false;
    // 已认领重判也可能因额度或模型失败结束；错误响应必须给客户端可继续保存的版本。
    const latestResponse = async (response: Response): Promise<Response> => {
        if (!owned) return response;
        const latest = await prisma.examAttempt.findUnique({ where: { id, userId: user.id }, select: { updatedAt: true, status: true } });
        if (!latest) return response;
        const body: unknown = await response.clone().json().catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return response;
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        return NextResponse.json({ ...body, status: latest.status, updatedAt: latest.updatedAt.toISOString() }, { status: response.status, headers });
    };
    try {
        const parsed = updateExamAttemptAnswerSchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return validationError('Invalid exam attempt answer', parsed.error.issues);
        const { candidateRef, regrade, expectedUpdatedAt, ...changes } = parsed.data;
        const expected = new Date(expectedUpdatedAt);
        const prepared = await runSerializedTransaction(async (tx) => {
            const attempt = await tx.examAttempt.findUnique({ where: { id, userId: user.id }, include: {
                pages: { select: { order: true, recognitionResult: true } }, answers: true, paper: { select: { userId: true } },
            } });
            if (!attempt || attempt.userId !== user.id || attempt.paper.userId !== user.id) throw new ReviewError(notFound('EXAM_ATTEMPT_NOT_FOUND'));
            owned = true;
            const answer = attempt.answers.find((item) => item.id === answerId);
            const question = answer ? await tx.examQuestion.findUnique({ where: { id: answer.examQuestionId } }) : null;
            if (!answer || !question || question.paperId !== attempt.paperId) throw new ReviewError(notFound('EXAM_ATTEMPT_ANSWER_NOT_FOUND'));
            if (attempt.status === 'confirmed') throw new ReviewError(conflict('EXAM_ATTEMPT_ALREADY_CONFIRMED'));
            if (attempt.updatedAt.getTime() !== expected.getTime()) throw new ReviewError(conflict('EXAM_ATTEMPT_CHANGED'));

            const data: Prisma.ExamAttemptAnswerUpdateInput = { ...changes, gradingSource: 'manual', reviewStatus: 'reviewed' };
            if (candidateRef === null) {
                if (!parseAttemptRegionJson(answer.regionJson)?.candidateId) throw new ReviewError(validationError('EXAM_ATTEMPT_CANDIDATE_NOT_MAPPED'));
                Object.assign(data, { recognizedAnswer: null, confidence: null, regionJson: null });
            } else if (candidateRef !== undefined) {
                const page = attempt.pages.find((item) => item.order === candidateRef.pageOrder);
                const envelope = page?.recognitionResult ? parseAttemptPageRecognition(page.recognitionResult) : null;
                const candidates = envelope?.candidates.filter((item) => item.candidateId === candidateRef.candidateId) ?? [];
                if (candidates.length !== 1) throw new ReviewError(validationError('EXAM_ATTEMPT_CANDIDATE_NOT_FOUND'));
                const used = attempt.answers.some((item) => {
                    const region = parseAttemptRegionJson(item.regionJson);
                    return item.id !== answerId && region?.pageOrder === candidateRef.pageOrder && region.candidateId === candidateRef.candidateId;
                });
                if (used) throw new ReviewError(conflict('EXAM_ATTEMPT_CANDIDATE_ALREADY_MAPPED'));
                const candidate = candidates[0];
                const regionJson = JSON.stringify({ ...candidateRef, regions: candidate.regions });
                if (!parseAttemptRegionJson(regionJson)) throw new ReviewError(validationError('EXAM_ATTEMPT_CANDIDATE_INVALID'));
                data.recognizedAnswer = candidate.recognizedAnswer;
                data.confidence = candidate.confidence;
                data.regionJson = regionJson;
            }
            if (candidateRef !== undefined) {
                // 更换或解除来源后，旧结论不再适用；选择候选本身不表示人工认可判分。
                Object.assign(data, { result: null, awardedScore: null, gradingReason: null, gradingSource: null, reviewStatus: 'required' });
            }
            const maxScore = changes.maxScore === undefined ? answer.maxScore : changes.maxScore;
            const awardedScore = regrade ? null : changes.awardedScore === undefined ? answer.awardedScore : changes.awardedScore;
            if (candidateRef === undefined && ((maxScore !== null && normalizeExamScore(maxScore) === null)
                || (awardedScore !== null && (maxScore === null || awardedScore < 0 || awardedScore > maxScore
                    || !Number.isFinite(awardedScore) || Math.abs(awardedScore * 10 - Math.round(awardedScore * 10)) > 1e-6)))) {
                throw new ReviewError(validationError('EXAM_ATTEMPT_SCORE_INVALID'));
            }
            const recognizedAnswer = typeof data.recognizedAnswer === 'string' || data.recognizedAnswer === null ? data.recognizedAnswer : answer.recognizedAnswer;
            if (regrade) {
                if (!recognizedAnswer?.trim() || !question.answerText?.trim()) throw new ReviewError(validationError('EXAM_ATTEMPT_REGRADE_ANSWER_REQUIRED'));
                // 修正答案后旧评分已不适用；即使重判失败也不能保留可直接确认的旧结论。
                Object.assign(data, { result: null, awardedScore: null, gradingReason: null, gradingSource: null, reviewStatus: 'required' });
            }
            const version = nextVersion(expected);
            const lock = await tx.examAttempt.updateMany({
                where: { id, userId: user.id, updatedAt: expected, status: { not: 'confirmed' } },
                // 人工接管同时终止旧识别所有权，避免旧调用停止后遗留 recognizing。
                data: { status: 'review', updatedAt: version },
            });
            if (!lock.count) throw new ReviewError(conflict('EXAM_ATTEMPT_CHANGED'));
            const saved = await tx.examAttemptAnswer.update({ where: { id: answerId }, data });
            return { answer: saved, question, version };
        });
        if (!regrade) return NextResponse.json({ answer: prepared.answer, updatedAt: prepared.version.toISOString() });

        const limited = await consumeAiQuota(user, 'grade');
        if (limited) return latestResponse(limited);
        const service = await getAIService({ userId: user.id, kind: 'grade' });
        const grading = await service.gradeAnswer({
            questionText: prepared.question.questionText ?? '', answerText: prepared.question.answerText!,
            analysis: prepared.question.analysis, userAnswer: prepared.answer.recognizedAnswer!, language: 'zh',
        });
        const result = await runSerializedTransaction(async (tx) => {
            const updatedAt = nextVersion(prepared.version);
            const lock = await tx.examAttempt.updateMany({
                where: { id, userId: user.id, paperId: prepared.question.paperId, updatedAt: prepared.version, status: 'review', paper: { userId: user.id } },
                data: { updatedAt },
            });
            if (!lock.count) throw new ReviewError(conflict('EXAM_ATTEMPT_CHANGED'));
            const answer = await tx.examAttemptAnswer.findUnique({ where: { id: answerId }, include: { examQuestion: { select: { paperId: true } } } });
            if (!answer || answer.attemptId !== id || answer.examQuestion.paperId !== prepared.question.paperId) throw new ReviewError(conflict('EXAM_ATTEMPT_CHANGED'));
            const gradingResult = grading.correct ? 'correct' : 'wrong';
            const saved = await tx.examAttemptAnswer.update({ where: { id: answerId }, data: {
                result: gradingResult, awardedScore: suggestExamAnswerScore(gradingResult, answer.maxScore ?? 0),
                gradingReason: grading.reason, gradingSource: 'ai', reviewStatus: 'required',
            } });
            return { answer: saved, updatedAt: updatedAt.toISOString() };
        });
        return NextResponse.json(result);
    } catch (error) {
        if (error instanceof ReviewError) return latestResponse(error.response);
        // 数据库和模型异常可能带有题干、图片或学生答案，仅记录固定错误码。
        logger.error({ attemptId: id, answerId, errorCode: 'EXAM_ATTEMPT_REVIEW_FAILED' }, '复核纸质作答失败');
        return latestResponse(internalError('EXAM_ATTEMPT_REVIEW_FAILED'));
    }
}));
