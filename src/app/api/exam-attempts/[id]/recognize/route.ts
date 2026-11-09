import { NextResponse } from 'next/server';
import { z } from 'zod';

import { internalError, validationError } from '@/lib/api-errors';
import { withUser } from '@/lib/api-handler';
import type { AuthenticatedContext } from '@/lib/api-handler';
import { ExamAttemptRecognitionError, recognizeExamAttemptPages } from '@/lib/exam/exam-attempt-recognition';
import { createLogger } from '@/lib/logger';
import { withRecoverableResponse } from '@/lib/recoverable-response';
import { MAX_IMPORTED_EXAM_PAGES } from '@/lib/schemas/exam';

const logger = createLogger('api:exam-attempts:recognize');
const recognizeSchema = z.object({
    pageOrders: z.array(z.number().int().min(1).max(MAX_IMPORTED_EXAM_PAGES)).min(1).max(MAX_IMPORTED_EXAM_PAGES)
        .refine((orders) => new Set(orders).size === orders.length, 'EXAM_PAGE_ORDER_DUPLICATE'),
    language: z.enum(['zh', 'en']).default('zh'),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
    replaceReviewed: z.boolean().optional(),
});

export const POST = withRecoverableResponse(withUser(async (
    req: Request,
    { user, params }: AuthenticatedContext & { params: Promise<{ id: string }> },
) => {
    const parsed = recognizeSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError('Invalid exam attempt recognition', parsed.error.issues);
    const { id } = await params;
    try {
        return NextResponse.json(await recognizeExamAttemptPages({ attemptId: id, user, ...parsed.data }));
    } catch (error) {
        if (error instanceof ExamAttemptRecognitionError) return error.response;
        // 原始异常可能带有模型输入，日志与响应仅使用固定错误码。
        logger.error({ attemptId: id, errorCode: 'EXAM_ATTEMPT_RECOGNITION_FAILED' }, '识别纸质作答失败');
        return internalError('EXAM_ATTEMPT_RECOGNITION_FAILED');
    }
}));
