import "server-only";

import type { Prisma, User } from "@prisma/client";
import { createLogger } from "@/lib/logger";
import { resolveOrCreateTags, inferTagScope } from "@/lib/tags/tag-resolver";
import { normalizeMistakeStatusForSave } from "@/lib/question/mistake-status";
import { generateUniqueShortId } from "@/lib/short-id/short-id";
import { resolveNotebookForSubject } from "@/lib/notebook-resolver";
import { normalizeQuestionType } from "@/lib/question/question-type";
import { sanitizeFigureSvg } from "@/lib/figure-svg";
import { getDefaultPaperLevelGroupId, ensureDefaultPaperGroups } from "@/lib/paper-level";
import type { ImportQuestionInput, SavedQuestionItem } from "@/lib/question/question-save";

const logger = createLogger('question-write');

/** 只创建错题及标签，不写练习历史；由调用方提供事务与判重边界。 */
export async function createErrorItemInTransaction(
    tx: Prisma.TransactionClient,
    user: User,
    body: ImportQuestionInput,
    context: { gradeSemester: string | null; resolvedPaperLevel: string | null; extraErrorItemData?: Partial<Prisma.ErrorItemUncheckedCreateInput> },
): Promise<SavedQuestionItem> {
    const { questionText, answerText, analysis, wrongAnswerText, mistakeAnalysis, mistakeStatus,
        knowledgePoints, originalImageUrl, subjectId: requestedSubjectId, subjectName, difficultyStars, geogebraCommands } = body;
    const questionType = normalizeQuestionType(body.questionType);
    const figureSvg = sanitizeFigureSvg(body.figureSvg);
    const hasFigure = !!body.hasFigure || figureSvg !== null;
    let paperLevelId = context.resolvedPaperLevel;
    // 事务内确保默认分组存在（并发安全），并解析默认卷别
    if (paperLevelId === null) {
        await ensureDefaultPaperGroups(user.id, tx);
        paperLevelId = await getDefaultPaperLevelGroupId(user.id, difficultyStars, tx);
    }

    // 未指定错题本时，按学科名匹配或新建错题本
    let subjectId: string | undefined = requestedSubjectId || undefined;
    if (!subjectId && typeof subjectName === 'string' && subjectName.trim()) {
        subjectId = (await resolveNotebookForSubject(user.id, subjectName, tx)).id;
    }

    const finalGradeSemester = context.gradeSemester;

    // 处理知识点标签（限定在当前错题本的标签体系内）
    const tagNames: string[] = Array.isArray(knowledgePoints) ? knowledgePoints : [];

    // 推断学科与标签体系（与新增错题时一致）
    const subject = await tx.subject.findUnique({ where: { id: subjectId || '' } });
    const { subjectKey, tagSet } = inferTagScope(subject);
    logger.debug({ subjectId, subjectName: subject?.name, subjectKey }, 'Subject inferred');

    const tagConnections = await resolveOrCreateTags(tx, {
        userId: user.id,
        tagNames,
        subjectKey,
        tagSet,
        gradeSemester: finalGradeSemester,
    });

    logger.info({ tagNames, tagConnectionsCount: tagConnections.length }, 'Creating ErrorItem with tags');

    // 创建错题记录
    try {
        const errorItem = await tx.errorItem.create({
            data: {
                shortId: await generateUniqueShortId(tx),
                userId: user.id,
                subjectId: subjectId || undefined,
                originalImageUrl,
                questionText,
                answerText,
                analysis,
                wrongAnswerText: wrongAnswerText || null,
                mistakeAnalysis: mistakeAnalysis || null,
                mistakeStatus: normalizeMistakeStatusForSave(mistakeStatus, wrongAnswerText),
                knowledgePoints: JSON.stringify(tagNames),
                gradeSemester: finalGradeSemester,
                paperLevel: paperLevelId,
                difficultyStars: difficultyStars ?? null,
                hasFigure,
                figureSvg,
                figureScale: body.figureScale,
                figureAlign: body.figureAlign,
                geogebraCommands: geogebraCommands || null,
                questionType,
                masteryLevel: 0,
                ...context.extraErrorItemData,
                tags: {
                    connect: tagConnections,
                },
            },
            include: {
                tags: true,
                subject: { select: { id: true, name: true } },
            },
        });

        logger.info({ errorItemId: errorItem.id, tagsCount: errorItem.tags?.length || 0 }, 'ErrorItem created successfully');
        return errorItem;
    } catch (dbError) {
        logger.error({
            error: dbError,
            userId: user.id,
            subjectId,
            tagConnectionsCount: tagConnections.length
        }, 'Database error creating ErrorItem');
        throw dbError;
    }
}
