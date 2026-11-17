import { NextResponse } from "next/server";

import { notFound } from "@/lib/api-errors";
import { withUser } from "@/lib/api-handler";
import type { AuthenticatedContext } from "@/lib/api-handler";
import { isExamPrintCode } from "@/lib/exam/exam-print-code";
import { createExamPrintVersion } from "@/lib/exam/exam-print-identity";
import { prisma } from "@/lib/prisma";

/** 按纸面短码解析当前用户自己的试卷；短码只负责定位，不绕过登录与所有权校验。 */
export const GET = withUser(async (
    req: Request,
    { user, params }: AuthenticatedContext & { params: Promise<{ printCode: string }> },
) => {
    const { printCode } = await params;
    if (!isExamPrintCode(printCode)) return notFound("Exam paper not found");

    const paper = await prisma.examPaper.findFirst({
        where: { printCode, userId: user.id },
        select: {
            id: true,
            title: true,
            printCode: true,
            groupByType: true,
            questions: {
                orderBy: { order: "asc" },
                select: {
                    order: true,
                    status: true,
                    sourceShortId: true,
                    questionText: true,
                    answerText: true,
                    analysis: true,
                    figureSvg: true,
                    figureScale: true,
                    figureAlign: true,
                    answerSpacePx: true,
                    score: true,
                    questionType: true,
                    externalNumber: true,
                },
            },
        },
    });
    if (!paper || !paper.printCode) return notFound("Exam paper not found");

    const currentPrintVersion = createExamPrintVersion(paper);
    const requestedVersion = new URL(req.url).searchParams.get("v");
    return NextResponse.json({
        paperId: paper.id,
        title: paper.title,
        printCode: paper.printCode,
        currentPrintVersion,
        versionMatches: requestedVersion === currentPrintVersion,
    });
});
