import { describe, expect, it } from 'vitest';

import { buildExamTrendStats } from '@/lib/stats/exam-trends';

const options = {
    range: '90d' as const,
    timeZone: 'Asia/Shanghai',
    subjectNames: new Map([['subject-math', '数学']]),
};

function row(input: {
    id: string;
    takenAt: string;
    createdAt: string;
    totalScore: number;
    maxScore: number;
    results?: Array<string | null>;
    subjectId?: string | null;
}) {
    return {
        id: input.id,
        takenAt: new Date(input.takenAt),
        createdAt: new Date(input.createdAt),
        totalScore: input.totalScore,
        maxScore: input.maxScore,
        paper: {
            id: `paper-${input.id}`,
            title: `试卷 ${input.id}`,
            subjectId: input.subjectId ?? 'subject-math',
        },
        answers: (input.results ?? []).map(result => ({ result })),
    };
}

describe('buildExamTrendStats', () => {
    it('按作答时间、创建时间和 ID 稳定排序并汇总得分率与错题数', () => {
        const rows = [
            row({
                id: 'latest',
                takenAt: '2026-11-03T01:00:00Z',
                createdAt: '2026-11-03T01:10:00Z',
                totalScore: 90,
                maxScore: 100,
            }),
            row({
                id: 'same-day-b',
                takenAt: '2026-11-02T01:00:00Z',
                createdAt: '2026-11-02T02:00:00Z',
                totalScore: 8,
                maxScore: 10,
                results: ['correct', 'wrong'],
            }),
            row({
                id: 'same-day-a',
                takenAt: '2026-11-02T01:00:00Z',
                createdAt: '2026-11-02T01:00:00Z',
                totalScore: 25,
                maxScore: 50,
                results: ['wrong', 'not_attempted', 'correct'],
            }),
        ];
        const originalOrder = rows.map(item => item.id);

        const result = buildExamTrendStats(rows, options);

        expect(result.points.map(point => point.attemptId)).toEqual([
            'same-day-a',
            'same-day-b',
            'latest',
        ]);
        expect(result.points.map(point => point.rate)).toEqual([50, 80, 90]);
        expect(result.points.map(point => point.wrongCount)).toEqual([2, 1, 0]);
        expect(result.summary).toEqual({
            examCount: 3,
            averageRate: 73.3,
            latestRate: 90,
            changeFromPrevious: 10,
            wrongCount: 3,
        });
        expect(rows.map(item => item.id)).toEqual(originalOrder);
    });

    it('空数据返回零计数、空数组和 null 比率', () => {
        expect(buildExamTrendStats([], options)).toEqual({
            range: '90d',
            summary: {
                examCount: 0,
                averageRate: null,
                latestRate: null,
                changeFromPrevious: null,
                wrongCount: 0,
            },
            points: [],
        });
    });

    it('只有一次考试时不虚构变化值', () => {
        const result = buildExamTrendStats([
            row({
                id: 'only',
                takenAt: '2026-11-02T01:00:00Z',
                createdAt: '2026-11-02T01:10:00Z',
                totalScore: 17,
                maxScore: 50,
            }),
        ], options);

        expect(result.summary.latestRate).toBe(34);
        expect(result.summary.changeFromPrevious).toBeNull();
    });

    it('不同满分试卷按各次得分率做算术平均', () => {
        const result = buildExamTrendStats([
            row({
                id: 'ten',
                takenAt: '2026-11-01T01:00:00Z',
                createdAt: '2026-11-01T01:10:00Z',
                totalScore: 10,
                maxScore: 10,
            }),
            row({
                id: 'hundred',
                takenAt: '2026-11-02T01:00:00Z',
                createdAt: '2026-11-02T01:10:00Z',
                totalScore: 50,
                maxScore: 100,
            }),
        ], options);

        expect(result.summary.averageRate).toBe(75);
    });

    it('平均得分率只在最终结果四舍五入一次', () => {
        const result = buildExamTrendStats([
            row({
                id: 'one-sixth',
                takenAt: '2026-11-01T01:00:00Z',
                createdAt: '2026-11-01T01:10:00Z',
                totalScore: 1,
                maxScore: 6,
            }),
            row({
                id: 'two-sevenths',
                takenAt: '2026-11-02T01:00:00Z',
                createdAt: '2026-11-02T01:10:00Z',
                totalScore: 2,
                maxScore: 7,
            }),
        ], options);

        expect(result.points.map(point => point.rate)).toEqual([16.7, 28.6]);
        expect(result.summary.averageRate).toBe(22.6);
    });

    it('使用应用时区生成日期标签和学科名称', () => {
        const result = buildExamTrendStats([
            row({
                id: 'timezone',
                takenAt: '2026-11-09T16:30:00Z',
                createdAt: '2026-11-09T17:00:00Z',
                totalScore: 8,
                maxScore: 10,
            }),
        ], options);

        expect(result.points[0]).toMatchObject({
            dateLabel: '2026-11-10',
            subjectId: 'subject-math',
            subjectName: '数学',
        });
    });

    it('在响应中回传已验证的学科筛选', () => {
        const result = buildExamTrendStats([], {
            ...options,
            subject: { id: 'subject-math', name: '数学' },
        });

        expect(result.subjectId).toBe('subject-math');
        expect(result.subjectName).toBe('数学');
    });
});
