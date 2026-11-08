import { NextResponse } from 'next/server';

import { conflict, internalError, notFound, validationError } from '@/lib/api-errors';
import { withUser } from '@/lib/api-handler';
import type { AuthenticatedContext } from '@/lib/api-handler';
import { buildImportedQuestions } from '@/lib/exam/exam-import';
import { getErrorMessage } from '@/lib/error-message';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { mapAnalysisError, parseImageDataUrl, splitQuestionsForUser } from '@/lib/question/question-analysis';
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

export const POST = withUser(async (
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
                pages: { select: { order: true, role: true, imageData: true, mimeType: true } },
            },
        });
        if (!paper || paper.userId !== user.id || paper.origin !== 'imported') return notFound('Exam paper not found');
        if (paper.status === 'ready') return conflict('IMPORTED_EXAM_ALREADY_PUBLISHED');

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

                await prisma.$transaction(async (tx) => {
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
                });
                successes.push({ pageOrder, questionCount: questions.length });
            } catch (error) {
                const code = mapAnalysisError(getErrorMessage(error));
                logger.warn({ paperId: id, pageOrder, error: code }, 'Imported exam page recognition failed');
                failures.push({ pageOrder, error: code });
            }
        }

        await prisma.examPaper.update({ where: { id }, data: { status: 'review' } });
        return NextResponse.json({ successes, failures, status: 'review' });
    } catch (error) {
        logger.error({ paperId: id, error }, 'Failed to recognize imported exam');
        return internalError('Failed to recognize imported exam', { error, scope: 'api:exams:recognize' });
    }
});

