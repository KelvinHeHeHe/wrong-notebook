import { NextResponse } from 'next/server';

import { conflict, internalError, validationError } from '@/lib/api-errors';
import { withUser } from '@/lib/api-handler';
import type { AuthenticatedContext } from '@/lib/api-handler';
import { checksumExamPage } from '@/lib/exam/exam-import';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { createImportedExamSchema } from '@/lib/schemas/exam';

const logger = createLogger('api:exams:import');

/** 创建外部整卷草稿；页图已在浏览器完成方向校正与压缩。 */
export const POST = withUser(async (req: Request, { user }: AuthenticatedContext) => {
    try {
        const parsed = createImportedExamSchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return validationError('Invalid imported exam', parsed.error.issues);

        const input = parsed.data;
        const subject = await prisma.subject.findFirst({
            where: { id: input.subjectId, userId: user.id },
            select: { id: true },
        });
        if (!subject) return validationError('Invalid subject');

        const pages = await Promise.all(input.pages.map(async (page) => ({
            ...page,
            checksum: await checksumExamPage(page.imageData),
        })));
        if (new Set(pages.map((page) => page.checksum)).size !== pages.length) {
            return conflict('EXAM_PAGE_DUPLICATE');
        }

        const paper = await prisma.$transaction((tx) => tx.examPaper.create({
            data: {
                userId: user.id,
                title: input.title,
                status: 'importing',
                scope: 'all',
                difficulty: 'original',
                mode: 'original',
                requestedCount: 0,
                subjectIds: JSON.stringify([input.subjectId]),
                origin: 'imported',
                subjectId: input.subjectId,
                gradeSemester: input.gradeSemester ?? null,
                examType: input.examType ?? null,
                examDate: input.examDate ? new Date(input.examDate) : null,
                totalScore: input.totalScore ?? null,
                sourceFileName: input.sourceFileName ?? null,
                pages: {
                    create: pages.map(({ imageData, mimeType, width, height, order, role, checksum }) => ({
                        imageData, mimeType, width, height, order, role, checksum,
                    })),
                },
            },
            select: {
                id: true,
                status: true,
                pages: { orderBy: { order: 'asc' }, select: { id: true, order: true, role: true } },
            },
        }));

        return NextResponse.json({ paperId: paper.id, status: paper.status, pages: paper.pages }, { status: 201 });
    } catch (error) {
        logger.error({ error }, 'Failed to create imported exam');
        return internalError('Failed to create imported exam', { error, scope: 'api:exams:import' });
    }
});

