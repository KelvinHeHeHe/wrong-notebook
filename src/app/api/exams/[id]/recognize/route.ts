import { NextResponse } from 'next/server';

import { conflict, internalError, notFound, validationError } from '@/lib/api-errors';
import { withUser } from '@/lib/api-handler';
import type { AuthenticatedContext } from '@/lib/api-handler';
import { buildImportedQuestions } from '@/lib/exam/exam-import';
import { getErrorMessage } from '@/lib/error-message';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { mapAnalysisError, parseImageDataUrl, splitQuestionsForUser } from '@/lib/question/question-analysis';
import { withRecoverableResponse } from '@/lib/recoverable-response';
import { recognizeExamPagesSchema } from '@/lib/schemas/exam';

const logger = createLogger('api:exams:recognize');

interface RecognitionSuccess {
    pageOrder: number;
    questionCount: number;
}

interface RecognitionFailure {
    pageOrder: number;
    error: string;
}

const handlePost = withUser(async (
    req: Request,
    { user, params }: AuthenticatedContext & { params: Promise<{ id: string }> },
) => {
    const { id } = await params;
    try {
        const parsed = recognizeExamPagesSchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return validationError('Invalid exam recognition request', parsed.error.issues);

        const paper = await prisma.examPaper.findUnique({
            where: { id },
            select: {
                id: true,
                userId: true,
                origin: true,
                status: true,
                updatedAt: true,
                pages: { select: { order: true, role: true, imageData: true, mimeType: true, checksum: true } },
            },
        });
        if (!paper || paper.userId !== user.id || paper.origin !== 'imported') return notFound('Exam paper not found');
        if (paper.status === 'ready') return conflict('IMPORTED_EXAM_ALREADY_PUBLISHED');

        // 先把本次识别置为校对态并取得写入顺序；后续补页会重新置为 importing，
        // 因而迟到的识别请求无需在 AI 返回后再次覆盖整卷状态。
        const reviewAt = new Date();
        const transition = await prisma.examPaper.updateMany({
            where: {
                id,
                userId: user.id,
                origin: 'imported',
                status: { not: 'ready' },
                updatedAt: paper.updatedAt,
            },
            data: { status: 'review', updatedAt: reviewAt },
        });
        if (transition.count === 0) return conflict('IMPORTED_EXAM_CHANGED');

        const pagesByOrder = new Map(paper.pages.map((page) => [page.order, page]));
        const successes: RecognitionSuccess[] = [];
        const failures: RecognitionFailure[] = [];

        for (const pageOrder of parsed.data.pageOrders) {
            const page = pagesByOrder.get(pageOrder);
            if (!page) {
                failures.push({ pageOrder, error: 'EXAM_PAGE_NOT_FOUND' });
                continue;
            }
            if (page.role !== 'questions') {
                failures.push({ pageOrder, error: 'EXAM_PAGE_NOT_RECOGNIZABLE' });
                continue;
            }

            try {
                const image = parseImageDataUrl(page.imageData, page.mimeType);
                const split = await splitQuestionsForUser(user.id, {
                    kind: 'image',
                    imageBase64: image.base64,
                    mimeType: image.mimeType ?? page.mimeType,
                    language: parsed.data.language,
                }, `/exams/${id}/import`);
                const questions = buildImportedQuestions(pageOrder, split);
                if (questions.length === 0) {
                    failures.push({ pageOrder, error: 'EXAM_PAGE_NO_QUESTIONS' });
                    continue;
                }

                const writeConflict = await prisma.$transaction(async (tx) => {
                    const current = await tx.examPaper.findUnique({
                        where: { id },
                        select: {
                            status: true,
                            pages: {
                                where: { order: pageOrder },
                                select: { role: true, checksum: true },
                            },
                        },
                    });
                    if (!current || current.status === 'ready') return 'IMPORTED_EXAM_ALREADY_PUBLISHED' as const;
                    const currentPage = current.pages[0];
                    if (!currentPage || currentPage.role !== 'questions' || currentPage.checksum !== (page.checksum ?? null)) {
                        return 'EXAM_PAGE_CHANGED' as const;
                    }
                    await tx.examQuestion.deleteMany({ where: { paperId: id, pageNumber: pageOrder } });
                    await tx.examQuestion.createMany({
                        data: questions.map((question) => ({
                            paperId: id,
                            ...question,
                            order: pageOrder * 1000 + question.order,
                        })),
                    });
                    const ordered = await tx.examQuestion.findMany({
                        where: { paperId: id },
                        orderBy: [{ pageNumber: 'asc' }, { order: 'asc' }],
                        select: { id: true },
                    });
                    for (let index = 0; index < ordered.length; index += 1) {
                        await tx.examQuestion.update({ where: { id: ordered[index].id }, data: { order: index + 1 } });
                    }
                    return null;
                });
                if (writeConflict) {
                    failures.push({ pageOrder, error: writeConflict });
                    continue;
                }
                successes.push({ pageOrder, questionCount: questions.length });
            } catch (error) {
                const code = mapAnalysisError(getErrorMessage(error));
                logger.warn({ paperId: id, pageOrder, error: code }, 'Imported exam page recognition failed');
                failures.push({ pageOrder, error: code });
            }
        }

        const latest = await prisma.examPaper.findUnique({ where: { id }, select: { status: true } });
        return NextResponse.json({ successes, failures, status: latest?.status ?? 'review' });
    } catch (error) {
        logger.error({ paperId: id, error }, 'Failed to recognize imported exam');
        return internalError('Failed to recognize imported exam', { error, scope: 'api:exams:recognize' });
    }
});

export const POST = withRecoverableResponse(handlePost);

