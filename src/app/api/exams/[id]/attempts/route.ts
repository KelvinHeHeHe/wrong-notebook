import { NextResponse } from 'next/server';

import { conflict, internalError, notFound, validationError } from '@/lib/api-errors';
import { withUser } from '@/lib/api-handler';
import type { AuthenticatedContext } from '@/lib/api-handler';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { createExamAttemptSchema } from '@/lib/schemas/exam-attempt';

const logger = createLogger('api:exams:attempts');
type Context = AuthenticatedContext & { params: Promise<{ id: string }> };

export const GET = withUser(async (_req: Request, { user, params }: Context) => {
    const { id } = await params;
    try {
        const paper = await prisma.examPaper.findUnique({ where: { id }, select: { userId: true } });
        if (!paper || paper.userId !== user.id) return notFound('Exam paper not found');

        const attempts = await prisma.examAttempt.findMany({
            where: { paperId: id, userId: user.id },
            orderBy: { takenAt: 'desc' },
        });
        return NextResponse.json(attempts);
    } catch (error) {
        logger.error({ error }, '读取试卷作答列表失败');
        return internalError('Failed to fetch exam attempts', { error, scope: 'api:exams:attempts' });
    }
});

export const POST = withUser(async (req: Request, { user, params }: Context) => {
    const { id } = await params;
    try {
        const parsed = createExamAttemptSchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return validationError('Invalid exam attempt', parsed.error.issues);

        const paper = await prisma.examPaper.findUnique({ where: { id }, select: { userId: true, status: true } });
        if (!paper || paper.userId !== user.id) return notFound('Exam paper not found');
        if (paper.status !== 'ready') return conflict('EXAM_PAPER_NOT_READY');

        const attempt = await prisma.$transaction((tx) => tx.examAttempt.create({
            data: {
                userId: user.id,
                paperId: id,
                status: 'uploaded',
                takenAt: new Date(parsed.data.takenAt),
                comment: parsed.data.comment ?? null,
            },
        }));
        return NextResponse.json(attempt, { status: 201 });
    } catch (error) {
        logger.error({ error }, '创建试卷作答失败');
        return internalError('Failed to create exam attempt', { error, scope: 'api:exams:attempts' });
    }
});
