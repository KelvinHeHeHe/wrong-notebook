import { buildExamPrintLayout } from '@/lib/exam/exam-sections';
import { normalizeQuestionType } from '@/lib/question/question-type';
import { normalizeExamScore } from '@/lib/exam/exam-score';
import type { ExamAttemptAnswerDetail, ExamAttemptAnswerUpdate, ExamPaperDetail, ExamQuestionDetail } from '@/types/api';

export interface ExamReviewQuestion extends ExamQuestionDetail { displayNumber: number }

/** 与打印 API 一样先规范化两种题型来源，再使用共享布局的过滤与连续编号。 */
export function buildExamReviewQuestions(paper: ExamPaperDetail, language: 'zh' | 'en'): ExamReviewQuestion[] {
    const questions = paper.questions.map((question) => ({ ...question,
        questionType: normalizeQuestionType(question.questionType),
        errorItemQuestionType: normalizeQuestionType(question.errorItemQuestionType),
    }));
    return buildExamPrintLayout(questions, paper.groupByType, language).items
        .map(({ question, displayNumber }) => ({ ...question, displayNumber }));
}

export interface ExamAnswerDraft {
    recognizedAnswer: string;
    result: string;
    maxScore: string;
    awardedScore: string;
    gradingReason: string;
}

export function answerDraft(answer: ExamAttemptAnswerDetail): ExamAnswerDraft {
    return { recognizedAnswer: answer.recognizedAnswer ?? '', result: answer.result ?? '', maxScore: answer.maxScore?.toString() ?? '', awardedScore: answer.awardedScore?.toString() ?? '', gradingReason: answer.gradingReason ?? '' };
}

export function validAwardedScore(score: number | null, max: number | null): boolean {
    return max !== null && normalizeExamScore(max) !== null && score !== null && Number.isFinite(score)
        && score >= 0 && score <= max && Math.abs(score * 10 - Math.round(score * 10)) <= 1e-6;
}

export function draftChanges(draft: ExamAnswerDraft): ExamAttemptAnswerUpdate {
    return { recognizedAnswer: draft.recognizedAnswer, result: ['correct', 'wrong', 'not_attempted'].includes(draft.result) ? draft.result as ExamAttemptAnswerDetail['result'] : null,
        maxScore: draft.maxScore.trim() === '' ? null : Number(draft.maxScore), awardedScore: draft.awardedScore.trim() === '' ? null : Number(draft.awardedScore), gradingReason: draft.gradingReason };
}

export function validDraft(draft: ExamAnswerDraft): boolean {
    const changes = draftChanges(draft);
    return !!changes.result && validAwardedScore(changes.awardedScore ?? null, changes.maxScore ?? null)
        && draft.recognizedAnswer.length <= 20000 && draft.gradingReason.length <= 10000;
}

export type ReviewIssue = { questionId: string; number: number; reason: 'missingAnswer' | 'reviewRequired' | 'missingResult' | 'missingMax' | 'missingScore' | 'unsaved' };

/** 仅用于解释缺项；确认资格仍由服务端在事务内裁决。 */
export function reviewIssues(questions: ExamReviewQuestion[], answers: ExamAttemptAnswerDetail[], drafts: Record<string, ExamAnswerDraft>): ReviewIssue[] {
    return questions.flatMap((question) => {
        const answer = answers.find((item) => item.examQuestionId === question.id);
        const reasons: ReviewIssue['reason'][] = [];
        if (!answer) reasons.push('missingAnswer');
        else {
            if (answer.reviewStatus !== 'pending' && answer.reviewStatus !== 'reviewed') reasons.push('reviewRequired');
            if (!['correct', 'wrong', 'not_attempted'].includes(answer.result ?? '')) reasons.push('missingResult');
            if (normalizeExamScore(answer.maxScore) === null) reasons.push('missingMax');
            if (!validAwardedScore(answer.awardedScore, answer.maxScore)) reasons.push('missingScore');
            if (drafts[answer.id]) reasons.push('unsaved');
        }
        return reasons.map((reason) => ({ questionId: question.id, number: question.displayNumber, reason }));
    });
}
