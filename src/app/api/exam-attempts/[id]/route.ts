import { NextResponse } from 'next/server';

import { internalError, notFound } from '@/lib/api-errors';
import { withUser } from '@/lib/api-handler';
import type { AuthenticatedContext } from '@/lib/api-handler';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';

const logger = createLogger('api:exam-attempts:id');

export const GET = withUser(async (
    req: Request,
    { user, params }: AuthenticatedContext & { params: Promise<{ id: string }> },
) => {
    const { id } = await params;
    try {
        const includePages = new URL(req.url).searchParams.get('includePages') === '1';
        const attempt = await prisma.examAttempt.findUnique({
            where: { id },
            include: {
                answers: { orderBy: { examQuestion: { order: 'asc' } } },
                pages: {
                    orderBy: { order: 'asc' },
                    select: {
                        id: true, attemptId: true, order: true, mimeType: true, width: true, height: true,
                        checksum: true, recognitionResult: true, createdAt: true, updatedAt: true,
                        ...(includePages ? { imageData: true } : {}),
                    },
                },
            },
        });
        if (!attempt || attempt.userId !== user.id) return notFound('Exam attempt not found');

        return NextResponse.json({
            ...attempt,
            pages: attempt.pages.map((page) => {
                const { imageData, ...metadata } = page;
                return includePages ? { ...metadata, imageData } : metadata;
            }),
        });
    } catch (error) {
        logger.error({ error }, '读取试卷作答详情失败');
        return internalError('Failed to fetch exam attempt', { error, scope: 'api:exam-attempts:id' });
    }
});
