/**
 * 导入步骤：外部试卷页、纸质作答、回传页与逐题评分。
 */
import { createAttemptIdentityResolver } from './attempt-identity';
import type { ImportContext } from './types';

function isId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

/** 7. 导入外部整卷页面；同一试卷、角色和页序保持幂等。 */
export async function importExamPaperPages(ctx: ImportContext): Promise<void> {
    const { tx, normalized, stats, examPaperIdMap, examPaperOwnerMap } = ctx;
    for (const page of normalized.examPaperPages) {
        const { raw } = page;
        if (!isId(raw.id) || !isId(raw.paperId) || !page.imageData || !page.mimeType || !page.checksum) continue;
        const paperId = examPaperIdMap.get(raw.paperId);
        if (!paperId || !examPaperOwnerMap.has(raw.paperId)) continue;

        const existing = await tx.examPaperPage.findUnique({
            where: { paperId_role_order: { paperId, role: page.role, order: page.order } },
            select: { id: true },
        });
        if (existing) continue;

        await tx.examPaperPage.create({
            data: {
                paperId,
                order: page.order,
                role: page.role,
                imageData: page.imageData,
                mimeType: page.mimeType,
                width: page.width,
                height: page.height,
                checksum: page.checksum,
                createdAt: page.createdAt,
                updatedAt: page.updatedAt,
            },
        });
        stats.examPaperPagesCreated++;
    }
}

/** 8. 导入作答主记录，并建立旧 ID 到新 ID 的映射。 */
export async function importExamAttempts(ctx: ImportContext): Promise<void> {
    const {
        tx, user, importAll, normalized, stats,
        examPaperIdMap, examPaperOwnerMap,
        examAttemptIdMap, examAttemptOwnerMap, examAttemptPaperMap,
    } = ctx;
    if (!normalized.examAttempts.length) return;
    const resolveIdentity = await createAttemptIdentityResolver(tx, normalized.examAttempts, [...examPaperIdMap.values()]);
    for (const attempt of normalized.examAttempts) {
        const { raw } = attempt;
        if (!isId(raw.id) || !isId(raw.paperId) || !attempt.takenAt) continue;
        const targetUserId = importAll ? raw.userId : user.id;
        const paperId = examPaperIdMap.get(raw.paperId);
        if (!paperId || examPaperOwnerMap.get(raw.paperId) !== targetUserId) continue;

        const identity = await resolveIdentity({ sourceId: raw.id, userId: targetUserId, paperId, takenAt: attempt.takenAt });
        if (!identity) continue;
        if (identity.existing) {
            examAttemptIdMap.set(raw.id, identity.id);
            examAttemptOwnerMap.set(raw.id, targetUserId);
            examAttemptPaperMap.set(raw.id, paperId);
            continue;
        }

        const created = await tx.examAttempt.create({
            data: {
                id: identity.id,
                userId: targetUserId,
                paperId,
                status: attempt.status,
                takenAt: attempt.takenAt,
                totalScore: attempt.totalScore,
                maxScore: attempt.maxScore,
                comment: attempt.comment,
                confirmedAt: attempt.confirmedAt,
                createdAt: attempt.createdAt,
                updatedAt: attempt.updatedAt,
            },
        });
        examAttemptIdMap.set(raw.id, created.id);
        examAttemptOwnerMap.set(raw.id, targetUserId);
        examAttemptPaperMap.set(raw.id, paperId);
        stats.examAttemptsCreated++;
    }
}

/** 9. 导入回传页和逐题评分；评分题目必须属于该次作答的试卷。 */
export async function importExamAttemptDetails(ctx: ImportContext): Promise<void> {
    const {
        tx, normalized, stats,
        examAttemptIdMap, examAttemptOwnerMap, examAttemptPaperMap,
        examQuestionIdMap, examQuestionOwnerMap, examQuestionPaperMap,
    } = ctx;

    for (const page of normalized.examAttemptPages) {
        const { raw } = page;
        if (!isId(raw.id) || !isId(raw.attemptId) || !page.imageData || !page.mimeType || !page.checksum) continue;
        const attemptId = examAttemptIdMap.get(raw.attemptId);
        if (!attemptId || !examAttemptOwnerMap.has(raw.attemptId)) continue;

        const existing = await tx.examAttemptPage.findUnique({
            where: { attemptId_order: { attemptId, order: page.order } },
            select: { id: true },
        });
        if (existing) continue;

        await tx.examAttemptPage.create({
            data: {
                attemptId,
                order: page.order,
                imageData: page.imageData,
                mimeType: page.mimeType,
                width: page.width,
                height: page.height,
                checksum: page.checksum,
                recognitionResult: page.recognitionResult,
                createdAt: page.createdAt,
                updatedAt: page.updatedAt,
            },
        });
        stats.examAttemptPagesCreated++;
    }

    for (const answer of normalized.examAttemptAnswers) {
        const { raw } = answer;
        if (!isId(raw.id) || !isId(raw.attemptId) || !isId(raw.examQuestionId)) continue;
        const attemptId = examAttemptIdMap.get(raw.attemptId);
        const examQuestionId = examQuestionIdMap.get(raw.examQuestionId);
        const owner = examAttemptOwnerMap.get(raw.attemptId);
        if (!attemptId || !examQuestionId || !owner || examQuestionOwnerMap.get(raw.examQuestionId) !== owner) continue;
        if (examAttemptPaperMap.get(raw.attemptId) !== examQuestionPaperMap.get(raw.examQuestionId)) continue;

        const existing = await tx.examAttemptAnswer.findUnique({
            where: { attemptId_examQuestionId: { attemptId, examQuestionId } },
            select: { id: true },
        });
        if (existing) continue;

        const awardedScore = answer.awardedScore !== null && answer.maxScore !== null && answer.awardedScore > answer.maxScore
            ? null : answer.awardedScore;
        await tx.examAttemptAnswer.create({
            data: {
                attemptId,
                examQuestionId,
                recognizedAnswer: answer.recognizedAnswer,
                result: answer.result,
                awardedScore,
                maxScore: answer.maxScore,
                gradingSource: answer.gradingSource,
                gradingReason: answer.gradingReason,
                confidence: answer.confidence,
                reviewStatus: answer.reviewStatus,
                regionJson: answer.regionJson,
                createdAt: answer.createdAt,
                updatedAt: answer.updatedAt,
            },
        });
        stats.examAttemptAnswersCreated++;
    }
}
