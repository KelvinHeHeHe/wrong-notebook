import { z } from "zod";

/** 时间范围：7 天 / 30 天 / 90 天 / 6 个月 / 全部 */
export type StatsRange = '7d' | '30d' | '90d' | '6m' | 'all';

const statsRangeSchema = z.enum(['7d', '30d', '90d', '6m', 'all']);

/**
 * 从查询参数解析时间范围；非法值回落默认值 '30d'。
 */
export function parseStatsRange(
    raw: string | null | undefined,
    defaultRange: StatsRange = '30d',
): StatsRange {
    if (!raw) return defaultRange;
    const result = statsRangeSchema.safeParse(raw);
    return result.success ? result.data : defaultRange;
}
