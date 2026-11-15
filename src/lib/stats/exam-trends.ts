import "server-only";

import type { Prisma } from "@prisma/client";

import { getAppTimeZone } from "@/lib/config";
import { formatDateTime, getDayRange } from "@/lib/date-time";
import { prisma } from "@/lib/prisma";
import { resolveStatsSubjectId } from "@/lib/stats/stats-filter";
import { getRangeStart } from "@/lib/stats/stats-range";

import type { ExamTrendPoint, ExamTrendStatsData, StatsRange } from "@/types/api";

export interface ExamTrendSourceRow {
    id: string;
    takenAt: Date;
    createdAt: Date;
    totalScore: number;
    maxScore: number;
    paper: {
        id: string;
        title: string;
        subjectId: string | null;
        subjectIds: string;
    };
    answers: Array<{ result: string | null }>;
}

interface BuildExamTrendOptions {
    range: StatsRange;
    timeZone: string;
    subject?: { id: string; name: string } | null;
    subjectNames: ReadonlyMap<string, string>;
}

function roundRate(value: number): number {
    const rounded = Math.round((value + Number.EPSILON) * 10) / 10;
    return Object.is(rounded, -0) ? 0 : rounded;
}

function compareRows(left: ExamTrendSourceRow, right: ExamTrendSourceRow): number {
    return left.takenAt.getTime() - right.takenAt.getTime()
        || left.createdAt.getTime() - right.createdAt.getTime()
        || left.id.localeCompare(right.id);
}

function parsePaperSubjectIds(value: string): string[] {
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === 'string')
            : [];
    } catch {
        return [];
    }
}

function getPaperSubjectIds(paper: ExamTrendSourceRow['paper']): string[] {
    return [...new Set([
        ...(paper.subjectId ? [paper.subjectId] : []),
        ...parsePaperSubjectIds(paper.subjectIds),
    ])];
}

export function buildExamTrendStats(
    rows: ExamTrendSourceRow[],
    options: BuildExamTrendOptions,
): ExamTrendStatsData {
    const points: ExamTrendPoint[] = [...rows]
        .sort(compareRows)
        .map(row => {
            const rate = roundRate(row.totalScore / row.maxScore * 100);
            const ownedSubjectIds = getPaperSubjectIds(row.paper)
                .filter(id => options.subjectNames.has(id));
            const subjectId = options.subject && ownedSubjectIds.includes(options.subject.id)
                ? options.subject.id
                : ownedSubjectIds.length === 1
                    ? ownedSubjectIds[0]
                    : null;
            const wrongCount = row.answers.reduce(
                (count, answer) => count + (answer.result === 'wrong' || answer.result === 'not_attempted' ? 1 : 0),
                0,
            );
            return {
                attemptId: row.id,
                paperId: row.paper.id,
                paperTitle: row.paper.title,
                subjectId,
                subjectName: subjectId
                    ? options.subjectNames.get(subjectId) ?? null
                    : null,
                takenAt: row.takenAt.toISOString(),
                dateLabel: formatDateTime(row.takenAt, 'yyyy-MM-dd', options.timeZone),
                totalScore: row.totalScore,
                maxScore: row.maxScore,
                rate,
                wrongCount,
            };
        });

    const latestRate = points.at(-1)?.rate ?? null;
    const previousRate = points.at(-2)?.rate ?? null;
    const averageRate = rows.length > 0
        ? roundRate(rows.reduce(
            (sum, row) => sum + row.totalScore / row.maxScore * 100,
            0,
        ) / rows.length)
        : null;
    const changeFromPrevious = latestRate !== null && previousRate !== null
        ? roundRate(latestRate - previousRate)
        : null;

    return {
        range: options.range,
        ...(options.subject ? {
            subjectId: options.subject.id,
            subjectName: options.subject.name,
        } : {}),
        summary: {
            examCount: points.length,
            averageRate,
            latestRate,
            changeFromPrevious,
            wrongCount: points.reduce((sum, point) => sum + point.wrongCount, 0),
        },
        points,
    };
}

const EXAM_TREND_SELECT = {
    id: true,
    takenAt: true,
    createdAt: true,
    totalScore: true,
    maxScore: true,
    paper: { select: { id: true, title: true, subjectId: true, subjectIds: true } },
    answers: { select: { result: true } },
} satisfies Prisma.ExamAttemptSelect;

export async function getExamTrendStats(input: {
    userId: string;
    range: StatsRange;
    subjectIdParam: string | null;
    now?: Date;
}): Promise<ExamTrendStatsData> {
    const timeZone = getAppTimeZone();
    const subject = await resolveStatsSubjectId(input.userId, input.subjectIdParam);
    const now = input.now ?? new Date();
    const start = getRangeStart(input.range, now, timeZone);
    const end = start ? getDayRange(now, timeZone, 1).start : null;
    const rows = await prisma.examAttempt.findMany({
        where: {
            userId: input.userId,
            status: 'confirmed',
            totalScore: { not: null },
            maxScore: { gt: 0 },
            ...(start && end ? { takenAt: { gte: start, lt: end } } : {}),
        },
        select: EXAM_TREND_SELECT,
        orderBy: [{ takenAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });

    const validRows: ExamTrendSourceRow[] = rows.flatMap(row => {
        if (row.totalScore === null || row.maxScore === null || row.maxScore <= 0) return [];
        if (subject && !getPaperSubjectIds(row.paper).includes(subject.id)) return [];
        return [{
            ...row,
            totalScore: row.totalScore,
            maxScore: row.maxScore,
        }];
    });
    const subjectIds = [...new Set(validRows.flatMap(row => getPaperSubjectIds(row.paper)))];
    const subjects = subjectIds.length > 0
        ? await prisma.subject.findMany({
            where: { userId: input.userId, id: { in: subjectIds } },
            select: { id: true, name: true },
        })
        : [];
    const subjectNames = new Map(subjects.map(item => [item.id, item.name]));

    return buildExamTrendStats(validRows, {
        range: input.range,
        timeZone,
        subject,
        subjectNames,
    });
}
