import { NextResponse } from 'next/server';

import { conflict, internalError, notFound, validationError } from '@/lib/api-errors';
import { withUser } from '@/lib/api-handler';
import type { AuthenticatedContext } from '@/lib/api-handler';
import { parseAttemptRegionJson } from '@/lib/exam/exam-attempt';
import { ExamPageImageError, validateExamPageImages } from '@/lib/exam/exam-page-image';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { MAX_IMPORTED_EXAM_PAGES } from '@/lib/schemas/exam';
import { upsertExamAttemptPagesSchema } from '@/lib/schemas/exam-attempt';

const logger = createLogger('api:exam-attempts:pages');
const pageMetadataSelect = {
    id: true, attemptId: true, order: true, mimeType: true, width: true, height: true,
    checksum: true, createdAt: true, updatedAt: true,
} as const;

export const POST = withUser(async (
    req: Request,
    { user, params }: AuthenticatedContext & { params: Promise<{ id: string }> },
) => {
    const { id } = await params;
    try {
        const parsed = upsertExamAttemptPagesSchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return validationError('Invalid exam attempt pages', parsed.error.issues);

        const attempt = await prisma.examAttempt.findUnique({
            where: { id },
            select: {
                userId: true, status: true, updatedAt: true,
                pages: { select: { id: true, order: true, checksum: true } },
            },
        });
        if (!attempt || attempt.userId !== user.id) return notFound('Exam attempt not found');
        const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);
        if (attempt.status === 'confirmed') return conflict('EXAM_ATTEMPT_ALREADY_CONFIRMED');
        if (attempt.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return conflict('EXAM_ATTEMPT_CHANGED');

        const existingByOrder = new Map(attempt.pages.map((page) => [page.order, page]));
        const incomingOrders = new Set(parsed.data.pages.map((page) => page.order));
        const newPageCount = parsed.data.pages.filter((page) => !existingByOrder.has(page.order)).length;
        if (attempt.pages.length + newPageCount > MAX_IMPORTED_EXAM_PAGES) return validationError('EXAM_PAGE_LIMIT_EXCEEDED');

        let pages;
        try {
            pages = await validateExamPageImages(parsed.data.pages);
        } catch (error) {
            if (error instanceof ExamPageImageError) return validationError(error.code);
            throw error;
        }
        const checksums = new Set(attempt.pages.filter((page) => !incomingOrders.has(page.order)).map((page) => page.checksum));
        for (const page of pages) {
            if (checksums.has(page.checksum)) return conflict('EXAM_PAGE_DUPLICATE');
            checksums.add(page.checksum);
        }

        const updated = await prisma.$transaction(async (tx) => {
            // 毫秒级时间戳也必须前进，避免同一毫秒的请求重复使用旧版本。
            const updatedAt = new Date(Math.max(Date.now(), expectedUpdatedAt.getTime() + 1));
            const lock = await tx.examAttempt.updateMany({
                where: { id, userId: user.id, updatedAt: expectedUpdatedAt, status: { not: 'confirmed' } },
                data: { status: 'uploaded', updatedAt },
            });
            if (lock.count === 0) return null;

            const replacedOrders = new Set<number>();
            const savedPages = [];
            for (const page of pages) {
                const existing = existingByOrder.get(page.order);
                const { order, imageData, mimeType, width, height, checksum } = page;
                const data = { imageData, mimeType, width, height, checksum };
                if (existing) {
                    const changed = existing.checksum !== checksum;
                    if (changed) replacedOrders.add(order);
                    savedPages.push(await tx.examAttemptPage.update({
                        where: { id: existing.id },
                        data: { ...data, ...(changed ? { recognitionResult: null } : {}) },
                        select: pageMetadataSelect,
                    }));
                } else {
                    savedPages.push(await tx.examAttemptPage.create({
                        data: { attemptId: id, order, ...data }, select: pageMetadataSelect,
                    }));
                }
            }

            if (replacedOrders.size > 0) {
                const answers = await tx.examAttemptAnswer.findMany({
                    where: { attemptId: id }, select: { id: true, reviewStatus: true, gradingSource: true, regionJson: true },
                });
                const affected = answers.filter((answer) => {
                    const region = parseAttemptRegionJson(answer.regionJson);
                    return region !== null && replacedOrders.has(region.pageOrder);
                });
                const preserved = affected.filter((answer) => answer.reviewStatus === 'reviewed' || answer.gradingSource === 'manual');
                const preservedIds = new Set(preserved.map((answer) => answer.id));
                const pendingIds = affected.filter((answer) => !preservedIds.has(answer.id)).map((answer) => answer.id);
                if (pendingIds.length > 0) {
                    await tx.examAttemptAnswer.deleteMany({
                        where: { attemptId: id, id: { in: pendingIds }, reviewStatus: { not: 'reviewed' } },
                    });
                }
                if (preservedIds.size > 0) {
                    await tx.examAttemptAnswer.updateMany({
                        where: { attemptId: id, id: { in: [...preservedIds] } },
                        data: { regionJson: null, confidence: null },
                    });
                }
            }

            const result = await tx.examAttempt.findUnique({ where: { id }, select: { id: true, status: true, updatedAt: true } });
            return { ...result, pages: savedPages.sort((a, b) => a.order - b.order) };
        });
        if (!updated) return conflict('EXAM_ATTEMPT_CHANGED');
        return NextResponse.json(updated);
    } catch (error) {
        logger.error({ error }, '保存试卷作答页面失败');
        return internalError('Failed to save exam attempt pages', { error, scope: 'api:exam-attempts:pages' });
    }
});
