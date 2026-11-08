import { z } from 'zod';

import { MAX_EXAM_SCORE, MIN_EXAM_SCORE } from '@/lib/exam/exam-score';
import { draftRegionSchema, MAX_DRAFT_TEXT_LENGTH } from '@/lib/question-split/draft';

export const MAX_IMPORTED_EXAM_PAGES = 20;
export const MAX_EXAM_PAGE_DATA_URL_LENGTH = 2_100_000;
export const EXAM_PAGE_ROLES = ['questions', 'answer_key'] as const;
export const IMPORTED_EXAM_TYPES = ['unit', 'midterm', 'final', 'daily', 'other'] as const;

const pageMimeTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp']);

export const importedExamPageSchema = z.object({
    order: z.number().int().min(1).max(MAX_IMPORTED_EXAM_PAGES),
    role: z.enum(EXAM_PAGE_ROLES).default('questions'),
    imageData: z.string()
        .max(MAX_EXAM_PAGE_DATA_URL_LENGTH, 'EXAM_PAGE_TOO_LARGE')
        .regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/, 'EXAM_PAGE_INVALID'),
    mimeType: pageMimeTypeSchema,
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
}).superRefine((page, context) => {
    if (!page.imageData.startsWith(`data:${page.mimeType};base64,`)) {
        context.addIssue({ code: 'custom', path: ['mimeType'], message: 'EXAM_PAGE_MIME_MISMATCH' });
    }
    if (page.width * page.height > 2560 * 1920) {
        context.addIssue({ code: 'custom', path: ['width'], message: 'EXAM_PAGE_PIXELS_EXCEEDED' });
    }
});

function uniquePages<T extends { order: number; imageData: string }>(pages: T[], context: z.RefinementCtx): void {
    const orders = new Set<number>();
    const images = new Set<string>();
    pages.forEach((page, index) => {
        if (orders.has(page.order)) {
            context.addIssue({ code: 'custom', path: ['pages', index, 'order'], message: 'EXAM_PAGE_ORDER_DUPLICATE' });
        }
        if (images.has(page.imageData)) {
            context.addIssue({ code: 'custom', path: ['pages', index, 'imageData'], message: 'EXAM_PAGE_DUPLICATE' });
        }
        orders.add(page.order);
        images.add(page.imageData);
    });
}

const importedExamMetadataSchema = z.object({
    title: z.string().trim().min(1).max(100),
    subjectId: z.string().min(1),
    gradeSemester: z.string().trim().max(50).nullable().optional(),
    examType: z.enum(IMPORTED_EXAM_TYPES).nullable().optional(),
    examDate: z.string().datetime({ offset: true }).nullable().optional(),
    totalScore: z.number().min(0).max(20_000).nullable().optional(),
    sourceFileName: z.string().trim().max(255).nullable().optional(),
});

export const createImportedExamSchema = importedExamMetadataSchema.extend({
    pages: z.array(importedExamPageSchema).min(1).max(MAX_IMPORTED_EXAM_PAGES),
}).superRefine((value, context) => uniquePages(value.pages, context));

export const upsertExamPagesSchema = z.object({
    pages: z.array(importedExamPageSchema).min(1).max(MAX_IMPORTED_EXAM_PAGES),
}).superRefine((value, context) => uniquePages(value.pages, context));

export const recognizeExamPagesSchema = z.object({
    pageOrders: z.array(z.number().int().min(1).max(MAX_IMPORTED_EXAM_PAGES)).min(1).max(MAX_IMPORTED_EXAM_PAGES),
}).superRefine((value, context) => {
    if (new Set(value.pageOrders).size !== value.pageOrders.length) {
        context.addIssue({ code: 'custom', path: ['pageOrders'], message: 'EXAM_PAGE_ORDER_DUPLICATE' });
    }
});

const examScoreSchema = z.number()
    .min(MIN_EXAM_SCORE)
    .max(MAX_EXAM_SCORE)
    .refine((value) => Math.abs(value * 10 - Math.round(value * 10)) <= 1e-6, 'EXAM_SCORE_PRECISION');

export const importedExamQuestionSchema = z.object({
    id: z.string().min(1).optional(),
    externalNumber: z.string().trim().max(20).nullable().optional(),
    pageNumber: z.number().int().min(1).max(MAX_IMPORTED_EXAM_PAGES),
    regions: z.array(draftRegionSchema).min(1).max(4),
    questionText: z.string().trim().min(1).max(MAX_DRAFT_TEXT_LENGTH),
    answerText: z.string().max(MAX_DRAFT_TEXT_LENGTH).nullable().optional(),
    analysis: z.string().max(MAX_DRAFT_TEXT_LENGTH).nullable().optional(),
    questionType: z.string().trim().max(200).nullable().optional(),
    score: examScoreSchema.nullable().optional(),
});

const importedExamPageRoleUpdateSchema = z.object({
    id: z.string().min(1),
    order: z.number().int().min(1).max(MAX_IMPORTED_EXAM_PAGES),
    role: z.enum(EXAM_PAGE_ROLES),
});

export const updateImportedExamSchema = z.object({
    kind: z.literal('import-draft'),
    title: z.string().trim().min(1).max(100),
    subjectId: z.string().min(1).optional(),
    gradeSemester: z.string().trim().max(50).nullable().optional(),
    examType: z.enum(IMPORTED_EXAM_TYPES).nullable().optional(),
    examDate: z.string().datetime({ offset: true }).nullable().optional(),
    totalScore: z.number().min(0).max(20_000).nullable().optional(),
    pages: z.array(importedExamPageRoleUpdateSchema).min(1).max(MAX_IMPORTED_EXAM_PAGES),
    questions: z.array(importedExamQuestionSchema).max(MAX_IMPORTED_EXAM_PAGES * 60),
    publish: z.boolean().default(false),
}).superRefine((value, context) => {
    const pageIds = new Set<string>();
    const pageOrders = new Set<number>();
    value.pages.forEach((page, index) => {
        if (pageIds.has(page.id)) context.addIssue({ code: 'custom', path: ['pages', index, 'id'], message: 'EXAM_PAGE_DUPLICATE' });
        if (pageOrders.has(page.order)) context.addIssue({ code: 'custom', path: ['pages', index, 'order'], message: 'EXAM_PAGE_ORDER_DUPLICATE' });
        pageIds.add(page.id);
        pageOrders.add(page.order);
    });

    const questionIds = new Set<string>();
    value.questions.forEach((question, index) => {
        if (!question.id) return;
        if (questionIds.has(question.id)) {
            context.addIssue({ code: 'custom', path: ['questions', index, 'id'], message: 'EXAM_QUESTION_DUPLICATE' });
        }
        questionIds.add(question.id);
    });
});

export type CreateImportedExamInput = z.infer<typeof createImportedExamSchema>;
export type UpsertExamPagesInput = z.infer<typeof upsertExamPagesSchema>;
export type UpdateImportedExamInput = z.infer<typeof updateImportedExamSchema>;

