import 'server-only';

import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import type { NormalizedExamAttempt } from '@/lib/backup/import-parser';

const IMPORTED_ATTEMPT_PREFIX = 'backup-attempt-v1-';
const identitySelect = { id: true, userId: true, paperId: true, takenAt: true } as const;
interface AttemptIdentityInput { sourceId: string; userId: string; paperId: string; takenAt: Date }

/** 固定旧导入候选快照；每个来源身份只能认领一条记录，新建记录不能成为后续 legacy 候选。 */
export async function createAttemptIdentityResolver(tx: Prisma.TransactionClient, attempts: NormalizedExamAttempt[], paperIds: string[]) {
    const counts = new Map<string, number>();
    for (const { raw } of attempts) if (typeof raw.id === 'string' && raw.id) counts.set(raw.id, (counts.get(raw.id) ?? 0) + 1);
    const sourceIds = new Set(counts.keys());
    const before = await tx.examAttempt.findMany({
        where: { paperId: { in: [...new Set(paperIds)] } },
        select: identitySelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const legacy = before.filter((row) => !row.id.startsWith(IMPORTED_ATTEMPT_PREFIX) && !sourceIds.has(row.id));
    const claimed = new Set<string>();

    return async (input: AttemptIdentityInput): Promise<{ id: string; existing: boolean } | null> => {
        // 映射字典以来源 ID 为键；冲突声明全部跳过，避免后写覆盖而串联不同用户/试卷。
        if (counts.get(input.sourceId) !== 1) return null;
        const belongs = (row: { id: string; userId: string; paperId: string }) => row.userId === input.userId && row.paperId === input.paperId && !claimed.has(row.id);
        const original = await tx.examAttempt.findUnique({ where: { id: input.sourceId }, select: identitySelect });
        if (original && belongs(original)) {
            claimed.add(original.id);
            return { id: original.id, existing: true };
        }

        // SHA-256 + JSON 元组编码稳定且无拼接歧义；目标用户隔离，日期不是身份的一部分。
        const prefix = `${IMPORTED_ATTEMPT_PREFIX}${createHash('sha256').update(JSON.stringify([input.userId, input.sourceId])).digest('hex')}-`;
        const occupied = await tx.examAttempt.findMany({ where: { id: { startsWith: prefix } }, select: identitySelect });
        const stable = occupied.filter((row) => {
            const suffix = row.id.slice(prefix.length);
            const slot = Number(suffix);
            return Number.isSafeInteger(slot) && slot >= 0 && String(slot) === suffix;
        });
        // 查找全部稳定槽，碰撞记录后来删除也不能让已导入的备用槽失去幂等性。
        const existing = stable.find((row) => belongs(row) && !sourceIds.has(row.id))
            ?? legacy.find((row) => belongs(row) && row.takenAt.getTime() === input.takenAt.getTime());
        if (existing) {
            claimed.add(existing.id);
            return { id: existing.id, existing: true };
        }

        const occupiedIds = new Set(occupied.map((row) => row.id));
        let slot = 0;
        while (occupiedIds.has(`${prefix}${slot}`) || sourceIds.has(`${prefix}${slot}`)) slot++;
        const id = `${prefix}${slot}`;
        claimed.add(id);
        return { id, existing: false };
    };
}
