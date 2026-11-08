import { NextResponse } from 'next/server';

import { conflict, internalError, notFound, validationError } from '@/lib/api-errors';
import { withUser } from '@/lib/api-handler';
import type { AuthenticatedContext } from '@/lib/api-handler';
import { checksumExamPage } from '@/lib/exam/exam-import';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { MAX_IMPORTED_EXAM_PAGES, upsertExamPagesSchema } from '@/lib/schemas/exam';

const logger = createLogger('api:exams:pages');

export const POST = withUser(async (
    req: Request,
    { user, params }: AuthenticatedContext & { params: Promise<{ id: string }> },
) => {
    const { id } = await params;
    try {
        const parsed = upsertExamPagesSchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return validationError('Invalid exam pages', parsed.error.issues);

        const paper = await prisma.examPaper.findUnique({
            where: { id },
            select: {
                id: true,
                userId: true,
                origin: true,
                status: true,
                pages: {
                    select: { id: true, order: true, role: true, imageData: true, mimeType: true, width: true, height: true, checksum: true },
                },
            },
        });
        if (!paper || paper.userId !== user.id || paper.origin !== 'imported') return notFound('Exam paper not found');
        if (paper.status === 'ready') return conflict('IMPORTED_EXAM_ALREADY_PUBLISHED');

        const existingOrders = new Set<number>();
        for (const page of paper.pages) {
            if (existingOrders.has(page.order)) return conflict('EXAM_PAGE_ORDER_DUPLICATE');
            existingOrders.add(page.order);
        }
        const incomingOrders = new Set(parsed.data.pages.map((page) => page.order));
        const newPageCount = parsed.data.pages.filter((page) => !existingOrders.has(page.order)).length;
        if (paper.pages.length + newPageCount > MAX_IMPORTED_EXAM_PAGES) return validationError('EXAM_PAGE_LIMIT_EXCEEDED');

        const pages = await Promise.all(parsed.data.pages.map(async (page) => ({
            ...page,
            checksum: await checksumExamPage(page.imageData),
        })));
        const untouchedChecksums = new Set(paper.pages.filter((page) => !incomingOrders.has(page.order)).map((page) => page.checksum));
        if (pages.some((page) => untouchedChecksums.has(page.checksum))) return conflict('EXAM_PAGE_DUPLICATE');

        const existingByOrder = new Map(paper.pages.map((page) => [page.order, page]));
        const updatedPages = await prisma.$transaction(async (tx) => {
            const result = [];
            for (const page of pages) {
                const existing = existingByOrder.get(page.order);
                const data = {
                    role: page.role,
                    imageData: page.imageData,
                    mimeType: page.mimeType,
                    width: page.width,
                    height: page.height,
                    checksum: page.checksum,
                };
                if (existing) {
                    const changed = existing.role !== page.role || existing.checksum !== page.checksum;
                    result.push(await tx.examPaperPage.update({ where: { id: existing.id }, data }));
                    if (changed) {
                        await tx.examQuestion.deleteMany({ where: { paperId: id, pageNumber: page.order } });
                    }
                } else {
                    result.push(await tx.examPaperPage.create({ data: { paperId: id, order: page.order, ...data } }));
                }
            }
            await tx.examPaper.update({ where: { id }, data: { status: 'importing' } });
            return result;
        });

        return NextResponse.json({
            paperId: id,
            status: 'importing',
            pages: updatedPages.sort((a, b) => a.order - b.order),
        });
    } catch (error) {
        logger.error({ paperId: id, error }, 'Failed to save imported exam pages');
        return internalError('Failed to save imported exam pages', { error, scope: 'api:exams:pages' });
    }
});

