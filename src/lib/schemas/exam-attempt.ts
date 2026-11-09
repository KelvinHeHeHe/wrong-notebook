import { z } from 'zod';

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
