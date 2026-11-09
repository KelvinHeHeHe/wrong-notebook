import 'server-only';

import type { PracticeRecord, Prisma } from '@prisma/client';

export interface ExamPracticeRecordInput {
    userId: string;
    errorItemId: string | null;
    examQuestionId: string;
    examAttemptId?: string | null;
    result: 'correct' | 'wrong' | 'not_attempted';
    takenAt: Date;
    difficulty: string | null;
    subject: string | null;
    questionText: string | null;
    answerText: string | null;
    analysis: string | null;
    wrongAnswerText?: string | null;
    originalImageUrl?: string | null;
    figureSvg?: string | null;
}

/** 统一试卷练习快照；空作答 ID 保留手工录入可多次追加的行为。 */
export function createExamPracticeRecord(tx: Prisma.TransactionClient, input: ExamPracticeRecordInput): Promise<PracticeRecord> {
    const { takenAt, ...snapshot } = input;
    return tx.practiceRecord.create({ data: { ...snapshot, source: 'exam', isCorrect: input.result === 'correct', createdAt: takenAt } });
}
