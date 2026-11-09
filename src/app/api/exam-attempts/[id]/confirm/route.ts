import { NextResponse } from 'next/server';

import { internalError, validationError } from '@/lib/api-errors';
import { withUser } from '@/lib/api-handler';
import type { AuthenticatedContext } from '@/lib/api-handler';
import { confirmExamAttempt, ExamAttemptConfirmError } from '@/lib/exam/exam-attempt-confirm';
import { createLogger } from '@/lib/logger';
import { scheduleMasteryEvaluation } from '@/lib/mastery';
import { confirmExamAttemptSchema } from '@/lib/schemas/exam-attempt';

const logger = createLogger('api:exam-attempts:confirm');

export const POST = withUser(async (
    req: Request,
    { user, params }: AuthenticatedContext & { params: Promise<{ id: string }> },
) => {
    const { id } = await params;
    try {
        const parsed = confirmExamAttemptSchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return validationError('Invalid exam attempt confirmation', parsed.error.issues);
        const { summary, affectedErrorItemIds } = await confirmExamAttempt({ attemptId: id, user, ...parsed.data });
        if (affectedErrorItemIds.length) scheduleMasteryEvaluation(affectedErrorItemIds);
        return NextResponse.json(summary);
    } catch (error) {
        if (error instanceof ExamAttemptConfirmError) return error.response;
        logger.error({ attemptId: id, errorCode: 'EXAM_ATTEMPT_CONFIRM_FAILED' }, '确认纸质作答失败');
        return internalError('EXAM_ATTEMPT_CONFIRM_FAILED');
    }
});
