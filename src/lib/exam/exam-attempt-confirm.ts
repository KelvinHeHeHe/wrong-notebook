import 'server-only';

import type { ExamAttempt, User } from '@prisma/client';

import { conflict, notFound, validationError } from '@/lib/api-errors';
import { runSerializedTransaction } from '@/lib/db-write-queue';
import { parseAttemptRegionJson, summarizeExamAttemptScores } from '@/lib/exam/exam-attempt';
import { cropAttemptAnswerImage } from '@/lib/exam/exam-attempt-image';
import { createExamPracticeRecord } from '@/lib/exam/exam-results';
import { normalizeExamScore } from '@/lib/exam/exam-score';
import { getPrintableExamQuestions } from '@/lib/exam/exam-sections';
import { findDuplicateQuestion } from '@/lib/question/question-deduplication';
import { importSchema } from '@/lib/question/question-save';
import { createErrorItemInTransaction } from '@/lib/question/question-write';

export class ExamAttemptConfirmError extends Error {
    constructor(public readonly response: Response) {
        super('EXAM_ATTEMPT_CONFIRM_REJECTED');
    }
}

export type ExamAttemptConfirmationSummary = Pick<ExamAttempt, 'id' | 'paperId' | 'status' | 'takenAt' | 'totalScore' | 'maxScore' | 'confirmedAt' | 'updatedAt'>;

function summary(attempt: ExamAttempt): ExamAttemptConfirmationSummary {
    const { id, paperId, status, takenAt, totalScore, maxScore, confirmedAt, updatedAt } = attempt;
    return { id, paperId, status, takenAt, totalScore, maxScore, confirmedAt, updatedAt };
}

function reject(message: string, status = 400): never {
    throw new ExamAttemptConfirmError(status === 404 ? notFound(message) : status === 409 ? conflict(message) : validationError(message));
}

/** 坐标损坏时仍恢复合法页序，让裁图函数回退到该页原图。 */
function pageOrder(raw: string | null): number | null {
    const parsed = parseAttemptRegionJson(raw);
    if (parsed) return parsed.pageOrder;
    try {
        const value: unknown = JSON.parse(raw ?? 'null');
        const order = value && typeof value === 'object' ? (value as { pageOrder?: unknown }).pageOrder : null;
        return typeof order === 'number' && Number.isInteger(order) && order > 0 ? order : null;
    } catch {
        return null;
    }
}

/** 确认与历史入账一起提交；提交后的掌握度调度由路由负责，重复确认不再返回调度 ID。 */
export function confirmExamAttempt(input: {
    attemptId: string;
    user: User;
    expectedUpdatedAt: string;
}): Promise<{ summary: ExamAttemptConfirmationSummary; affectedErrorItemIds: string[] }> {
    return runSerializedTransaction(async (tx) => {
        const attempt = await tx.examAttempt.findUnique({
            where: { id: input.attemptId },
            include: {
                pages: { orderBy: { order: 'asc' } },
                answers: true,
                paper: { include: { questions: { where: { status: 'ready' }, orderBy: { order: 'asc' }, include: { errorItem: { include: { subject: true } } } } } },
            },
        });
        if (!attempt || attempt.userId !== input.user.id || attempt.paper.userId !== input.user.id) reject('EXAM_ATTEMPT_NOT_FOUND', 404);
        if (attempt.status === 'confirmed') return { summary: summary(attempt), affectedErrorItemIds: [] };
        if (attempt.status !== 'review' || attempt.paper.status !== 'ready') reject('EXAM_ATTEMPT_INVALID_STATUS', 409);
        const expected = new Date(input.expectedUpdatedAt);
        if (!Number.isFinite(expected.getTime()) || expected.getTime() !== attempt.updatedAt.getTime()) reject('EXAM_ATTEMPT_CHANGED', 409);
        const questions = getPrintableExamQuestions(attempt.paper.questions);
        if (!questions.length) reject('EXAM_ATTEMPT_NO_READY_QUESTIONS');
        const answers = new Map(attempt.answers.map((answer) => [answer.examQuestionId, answer]));
        for (const question of questions) {
            const answer = answers.get(question.id);
            if (!answer) reject('EXAM_ATTEMPT_ANSWER_MISSING');
            if (!['pending', 'reviewed'].includes(answer.reviewStatus)) reject('EXAM_ATTEMPT_REVIEW_REQUIRED');
            if (!['correct', 'wrong', 'not_attempted'].includes(answer.result ?? '')) reject('EXAM_ATTEMPT_RESULT_REQUIRED');
            if (normalizeExamScore(answer.maxScore) === null || answer.maxScore === null
                || answer.awardedScore === null || !Number.isFinite(answer.awardedScore)
                || answer.awardedScore < 0 || answer.awardedScore > answer.maxScore
                || Math.abs(answer.awardedScore * 10 - Math.round(answer.awardedScore * 10)) > 1e-6) reject('EXAM_ATTEMPT_SCORE_INVALID');
            if (question.errorItem && question.errorItem.userId !== input.user.id) reject('EXAM_ATTEMPT_SOURCE_INVALID');
        }
        const nextUpdatedAt = new Date(Math.max(Date.now(), attempt.updatedAt.getTime() + 1));
        const claimed = await tx.examAttempt.updateMany({
            where: { id: attempt.id, userId: input.user.id, status: 'review', updatedAt: expected },
            data: { updatedAt: nextUpdatedAt },
        });
        if (!claimed.count) reject('EXAM_ATTEMPT_CHANGED', 409);
        const subject = attempt.paper.subjectId
            ? await tx.subject.findFirst({ where: { id: attempt.paper.subjectId, userId: input.user.id } }) : null;
        const affected = new Set<string>();
        for (const question of questions) {
            const answer = answers.get(question.id)!;
            let errorItemId = question.errorItemId;
            const matchedPage = attempt.pages.find((candidate) => candidate.order === pageOrder(answer.regionJson));
            const page = matchedPage ?? attempt.pages[0];
            const originalImageUrl = page ? await cropAttemptAnswerImage(page.imageData, page.mimeType, matchedPage ? answer.regionJson : null) : null;
            if (!errorItemId && answer.result !== 'correct') {
                const body = importSchema.parse({
                    questionText: question.questionText,
                    answerText: question.answerText,
                    analysis: question.analysis,
                    wrongAnswerText: answer.recognizedAnswer,
                    mistakeStatus: answer.result === 'not_attempted' ? 'not_attempted' : 'wrong_attempt',
                    originalImageUrl: originalImageUrl ?? '',
                    subjectId: subject?.id,
                    questionType: question.questionType,
                    figureSvg: question.figureSvg,
                    figureScale: question.figureScale,
                    figureAlign: question.figureAlign,
                });
                const duplicate = await findDuplicateQuestion(tx, input.user.id, body);
                errorItemId = duplicate?.id ?? (await createErrorItemInTransaction(tx, input.user, body, {
                    gradeSemester: attempt.paper.gradeSemester,
                    resolvedPaperLevel: null,
                    // 最终复核结果优先于共享保存函数根据答案文字作出的状态推断。
                    extraErrorItemData: { mistakeStatus: body.mistakeStatus },
                })).id;
                await tx.examQuestion.update({ where: { id: question.id }, data: { errorItemId } });
            }
            await createExamPracticeRecord(tx, {
                userId: input.user.id,
                errorItemId,
                examQuestionId: question.id,
                examAttemptId: attempt.id,
                result: answer.result as 'correct' | 'wrong' | 'not_attempted',
                takenAt: attempt.takenAt,
                difficulty: attempt.paper.mode === 'original' ? null : attempt.paper.difficulty,
                subject: question.errorItem?.subject?.name ?? subject?.name ?? null,
                questionText: question.questionText,
                answerText: question.answerText,
                analysis: question.analysis,
                wrongAnswerText: answer.recognizedAnswer,
                originalImageUrl,
                figureSvg: question.figureSvg,
            });
            if (errorItemId) affected.add(errorItemId);
        }
        const scores = summarizeExamAttemptScores(questions.map((question) => answers.get(question.id)!));
        const confirmed = await tx.examAttempt.update({ where: { id: attempt.id }, data: {
            ...scores, status: 'confirmed', confirmedAt: new Date(), updatedAt: nextUpdatedAt,
        } });
        await tx.examPaper.update({ where: { id: attempt.paperId }, data: { resultsRecordedAt: new Date() } });
        return { summary: summary(confirmed), affectedErrorItemIds: [...affected] };
    });
}
