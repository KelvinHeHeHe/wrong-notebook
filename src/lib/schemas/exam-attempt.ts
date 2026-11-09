import { z } from 'zod';

import { normalizeExamScore } from '@/lib/exam/exam-score';
import { importedExamPageSchema, MAX_IMPORTED_EXAM_PAGES } from '@/lib/schemas/exam';

export const createExamAttemptSchema = z.object({
    takenAt: z.string().datetime({ offset: true }),
    comment: z.string().max(500).optional(),
});

// Zod 不允许直接 omit 含 refinement 的对象；经原 schema 校验后再移除默认 role。
const examAttemptPageSchema = z.object(importedExamPageSchema.shape)
    .omit({ role: true })
    .strict()
    .pipe(importedExamPageSchema)
    .transform(({ role: _role, ...page }) => page);

export const upsertExamAttemptPagesSchema = z.object({
    pages: z.array(examAttemptPageSchema).min(1).max(MAX_IMPORTED_EXAM_PAGES),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
}).superRefine(({ pages }, context) => {
    const orders = new Set<number>();
    pages.forEach((page, index) => {
        if (orders.has(page.order)) {
            context.addIssue({ code: 'custom', path: ['pages', index, 'order'], message: 'EXAM_PAGE_ORDER_DUPLICATE' });
        }
        orders.add(page.order);
    });
});

export type CreateExamAttemptInput = z.infer<typeof createExamAttemptSchema>;
export type UpsertExamAttemptPagesInput = z.infer<typeof upsertExamAttemptPagesSchema>;

const awardedScoreSchema = z.number().min(0).max(1000)
    .refine((score) => Math.abs(score * 10 - Math.round(score * 10)) <= 1e-6, 'EXAM_ATTEMPT_SCORE_INVALID');

export const updateExamAttemptAnswerSchema = z.object({
    recognizedAnswer: z.string().max(20000).nullable().optional(),
    result: z.enum(['correct', 'wrong', 'not_attempted']).nullable().optional(),
    awardedScore: awardedScoreSchema.nullable().optional(),
    maxScore: z.number().refine((score) => normalizeExamScore(score) !== null, 'EXAM_ATTEMPT_SCORE_INVALID').nullable().optional(),
    gradingReason: z.string().max(10000).nullable().optional(),
    candidateRef: z.object({
        pageOrder: z.number().int().min(1).max(MAX_IMPORTED_EXAM_PAGES),
        candidateId: z.string().trim().min(1).max(200),
    }).strict().nullable().optional(),
    regrade: z.boolean().optional(),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((input, context) => {
    const manualJudgment = ['result', 'awardedScore', 'gradingReason'] as const;
    const answerChanges = ['recognizedAnswer', 'maxScore', ...manualJudgment] as const;
    // 来源变更是独立动作；显式 null 同样表示请求了变更，不能按字段缺失处理。
    if (input.candidateRef !== undefined && (input.regrade === true || answerChanges.some((key) => input[key] !== undefined))) {
        context.addIssue({ code: 'custom', path: ['candidateRef'], message: 'EXAM_ATTEMPT_REVIEW_ACTION_CONFLICT' });
    }
    if (input.regrade === true && manualJudgment.some((key) => input[key] !== undefined)) {
        context.addIssue({ code: 'custom', path: ['regrade'], message: 'EXAM_ATTEMPT_REVIEW_ACTION_CONFLICT' });
    }
});

export const confirmExamAttemptSchema = z.object({
    expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();
