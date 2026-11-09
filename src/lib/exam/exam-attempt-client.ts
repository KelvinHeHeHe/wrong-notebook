import { z } from 'zod';

import { ApiError } from '@/lib/api-client';
import { prepareImage, renderRegion } from '@/lib/image-pipeline';
import { MAX_IMPORTED_EXAM_PAGES } from '@/lib/schemas/exam';
import type { CreateExamAttemptInput, UpsertExamAttemptPagesInput } from '@/lib/schemas/exam-attempt';
import type { ExamAttemptRecognitionResponse, ExamAttemptSummary, ExamAttemptVersion } from '@/types/api';

export interface PreparedExamAttemptPhoto {
    order: number;
    imageData: string;
    mimeType: 'image/jpeg';
    width: number;
    height: number;
    sourceName: string;
}

interface PreparedPhoto {
    dataUrl: string;
    width: number;
    height: number;
}

export interface ExamAttemptPreparationDeps {
    preparePhoto?: (file: File) => Promise<PreparedPhoto>;
}

export interface ExamAttemptUploadCheckpoint {
    attemptId: string;
    updatedAt: string;
    uploaded: boolean;
}

export interface ExamAttemptWorkflowDeps {
    createAttempt: (paperId: string, input: CreateExamAttemptInput) => Promise<{ attemptId: string; updatedAt: string }>;
    uploadPages: (attemptId: string, input: UpsertExamAttemptPagesInput) => Promise<ExamAttemptVersion>;
    recognizePages: (attemptId: string, input: { expectedUpdatedAt: string; pageOrders: number[]; language: 'zh' | 'en' }) => Promise<ExamAttemptRecognitionResponse>;
    getAttempt: (attemptId: string) => Promise<ExamAttemptVersion>;
    assertActive?: () => void;
    onCheckpoint?: (checkpoint: ExamAttemptUploadCheckpoint) => void;
}

interface ExamAttemptWorkflowInput extends CreateExamAttemptInput {
    paperId: string;
    language: 'zh' | 'en';
    pages: PreparedExamAttemptPhoto[];
    checkpoint?: ExamAttemptUploadCheckpoint;
}

// 沿用 Task 5 路由的顶层结果及 details 标记，拒绝缺失版本或仍在识别中的信封。
const finalizeResponseSchema = z.object({
    message: z.literal('EXAM_ATTEMPT_FINALIZE_FAILED'),
    code: z.literal('DATABASE_ERROR'),
    details: z.object({ phase: z.literal('finalize'), retryable: z.literal(true) }),
    status: z.enum(['review', 'failed', 'confirmed']),
    updatedAt: z.string().datetime({ offset: true }),
    successes: z.array(z.object({ pageOrder: z.number().int().min(1).max(MAX_IMPORTED_EXAM_PAGES), candidateCount: z.number().int().min(0), matchedCount: z.number().int().min(0) })),
    failures: z.array(z.object({ pageOrder: z.number().int().min(1).max(MAX_IMPORTED_EXAM_PAGES), error: z.string().min(1) })),
});

const IMAGE_FILE_PATTERN = /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/i;

async function preparePhoto(file: File): Promise<PreparedPhoto> {
    const prepared = await prepareImage(file);
    try {
        const { dataUrl, width, height } = await renderRegion(prepared);
        return { dataUrl, width, height };
    } finally {
        prepared.dispose();
    }
}

/** 复用图片管线的方向校正与压缩，按用户选择顺序准备回传照片。 */
export async function prepareExamAttemptPhotos(
    inputFiles: Iterable<File>,
    deps: ExamAttemptPreparationDeps = {},
): Promise<PreparedExamAttemptPhoto[]> {
    const files = Array.from(inputFiles);
    if (files.length < 1 || files.length > MAX_IMPORTED_EXAM_PAGES) throw new Error('EXAM_ATTEMPT_PHOTO_COUNT');
    if (files.some((file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
        || !(file.type.startsWith('image/') || IMAGE_FILE_PATTERN.test(file.name)))) {
        throw new Error('EXAM_ATTEMPT_IMAGES_ONLY');
    }
    const pages: PreparedExamAttemptPhoto[] = [];
    for (const file of files) {
        const rendered = await (deps.preparePhoto ?? preparePhoto)(file);
        pages.push({ order: pages.length + 1, imageData: rendered.dataUrl, mimeType: 'image/jpeg', width: rendered.width, height: rendered.height, sourceName: file.name });
    }
    return pages;
}

/** 每一步保存服务端版本；失败后可从已知创建结果继续，不重复创建作答。 */
export async function createAndRecognizeExamAttempt(input: ExamAttemptWorkflowInput, deps: ExamAttemptWorkflowDeps) {
    const assertActive = () => deps.assertActive?.();
    assertActive();
    let checkpoint = input.checkpoint;
    if (checkpoint) {
        // 上传响应丢失也可能已经写入；重试前读取当前版本，不能推算时间戳。
        const latest = await deps.getAttempt(checkpoint.attemptId);
        assertActive();
        checkpoint = { ...checkpoint, updatedAt: latest.updatedAt };
        deps.onCheckpoint?.(checkpoint);
    } else {
        const created = await deps.createAttempt(input.paperId, { takenAt: input.takenAt, ...(input.comment ? { comment: input.comment } : {}) });
        assertActive();
        checkpoint = { attemptId: created.attemptId, updatedAt: created.updatedAt, uploaded: false };
        deps.onCheckpoint?.(checkpoint);
    }
    if (!checkpoint.uploaded) {
        const uploaded = await deps.uploadPages(checkpoint.attemptId, {
            expectedUpdatedAt: checkpoint.updatedAt,
            pages: input.pages.map(({ sourceName: _sourceName, ...page }) => page),
        });
        assertActive();
        checkpoint = { ...checkpoint, updatedAt: uploaded.updatedAt, uploaded: true };
        deps.onCheckpoint?.(checkpoint);
    }
    let recognition: ExamAttemptRecognitionResponse;
    try {
        recognition = await deps.recognizePages(checkpoint.attemptId, {
            expectedUpdatedAt: checkpoint.updatedAt,
            pageOrders: input.pages.map((page) => page.order),
            language: input.language,
        });
    } catch (cause) {
        assertActive();
        // 仅收尾失败的标准信封代表已有可复核结果；不能把其他 503 当作识别成功。
        const recovered = cause instanceof ApiError && cause.status === 503 && checkpoint.attemptId.trim()
            ? finalizeResponseSchema.safeParse(cause.data)
            : null;
        if (!recovered?.success) throw cause;
        recognition = recovered.data;
    }
    assertActive();
    deps.onCheckpoint?.({ ...checkpoint, updatedAt: recognition.updatedAt });
    return { attemptId: checkpoint.attemptId, ...recognition };
}

/** 历史保持日期倒序，排序不修改请求缓存。 */
export function sortExamAttemptHistory(attempts: ExamAttemptSummary[]): ExamAttemptSummary[] {
    return [...attempts].sort((left, right) => Date.parse(right.takenAt) - Date.parse(left.takenAt));
}
