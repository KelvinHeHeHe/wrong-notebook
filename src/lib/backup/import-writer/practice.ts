/**
 * 导入步骤：练习记录与掌握阈值同步。
 */
import { sanitizeFigureSvg } from "@/lib/figure-svg";
import { syncMasteryLevels } from "@/lib/mastery";
import type { ImportContext } from "./types";

/** 7. 导入 practice records */
export async function importPracticeRecords(ctx: ImportContext): Promise<void> {
    const {
        tx, user, importAll, normalized, stats, masteryIds, evaluatedIds,
        errorItemIdMap, errorItemOwnerMap,
        examQuestionIdMap, examQuestionOwnerMap, examQuestionPaperMap,
        examAttemptIdMap, examAttemptOwnerMap, examAttemptPaperMap,
    } = ctx;
    for (const record of normalized.practiceRecords) {
        const { raw } = record;
        const targetUserId = importAll ? raw.userId : user.id;
        const errorItemId = raw.errorItemId && errorItemOwnerMap.get(raw.errorItemId) === targetUserId
            ? errorItemIdMap.get(raw.errorItemId) : undefined;
        const examQuestionId = raw.examQuestionId && examQuestionOwnerMap.get(raw.examQuestionId) === targetUserId
            ? examQuestionIdMap.get(raw.examQuestionId) : undefined;
        const mappedExamAttemptId = raw.examAttemptId && examAttemptOwnerMap.get(raw.examAttemptId) === targetUserId
            ? examAttemptIdMap.get(raw.examAttemptId) : undefined;
        const examAttemptId = mappedExamAttemptId && raw.examAttemptId && raw.examQuestionId
            && examAttemptPaperMap.get(raw.examAttemptId) === examQuestionPaperMap.get(raw.examQuestionId)
            ? mappedExamAttemptId : undefined;
        if (examAttemptId && examQuestionId) {
            const existing = await tx.practiceRecord.findUnique({
                where: { examAttemptId_examQuestionId: { examAttemptId, examQuestionId } },
                select: { id: true },
            });
            if (existing) continue;
        }
        await tx.practiceRecord.create({
            data: {
                userId: targetUserId,
                subject: raw.subject,
                difficulty: raw.difficulty,
                isCorrect: raw.isCorrect,
                // 正确外部题不创建错题，但经归属与试卷校验的作答记录仍须完整恢复。
                ...(errorItemId || (record.source === 'exam' && examAttemptId && examQuestionId) ? {
                    errorItemId,
                    result: record.result,
                    questionText: raw.questionText,
                    answerText: raw.answerText,
                    analysis: raw.analysis,
                    wrongAnswerText: raw.wrongAnswerText,
                    mistakeAnalysis: raw.mistakeAnalysis,
                    originalImageUrl: raw.originalImageUrl,
                    figureSvg: sanitizeFigureSvg(raw.figureSvg),
                    source: record.source,
                    examQuestionId,
                    examAttemptId,
                } : {}),
                createdAt: record.createdAt,
            },
        });
        stats.practiceRecordsCreated++;
        if (errorItemId && record.result && !evaluatedIds.has(errorItemId)) masteryIds.add(errorItemId);
    }
}

/** 9. 还原了已掌握阈值时，按新阈值同步该账户全部错题的 masteryLevel */
export async function syncMasteryThreshold(ctx: ImportContext): Promise<void> {
    const { tx, user, normalized } = ctx;
    if (typeof normalized.preferences.masteryThreshold === 'number') {
        await syncMasteryLevels(tx, user.id, normalized.preferences.masteryThreshold);
    }
}
