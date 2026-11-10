import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    examAttemptFindMany: vi.fn(),
    subjectFindFirst: vi.fn(),
    subjectFindMany: vi.fn(),
    userFindUnique: vi.fn(),
    session: {
        user: { id: 'session-user', email: 'user@example.com', name: '测试用户' },
        expires: '2027-12-31',
    },
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        examAttempt: { findMany: mocks.examAttemptFindMany },
        subject: {
            findFirst: mocks.subjectFindFirst,
            findMany: mocks.subjectFindMany,
        },
        user: { findUnique: mocks.userFindUnique },
    },
}));

vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve(mocks.session)),
}));

vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/config', () => ({ getAppTimeZone: () => 'Asia/Shanghai' }));

import { GET } from '@/app/api/stats/exams/route';
import { getServerSession } from 'next-auth';

function request(query = ''): Request {
    return new Request(`http://localhost/api/stats/exams${query}`);
}

function attempt(id: string, takenAt: string) {
    return {
        id,
        takenAt: new Date(takenAt),
        createdAt: new Date(takenAt),
        totalScore: 17,
        maxScore: 50,
        paper: { id: `paper-${id}`, title: `试卷 ${id}`, subjectId: 'subject-math' },
        answers: [{ result: 'wrong' }],
    };
}

describe('GET /api/stats/exams', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-10T04:00:00Z'));
        vi.mocked(getServerSession).mockResolvedValue(mocks.session);
        mocks.userFindUnique.mockResolvedValue({ id: 'user-123', email: 'user@example.com' });
        mocks.subjectFindFirst.mockResolvedValue(null);
        mocks.subjectFindMany.mockResolvedValue([{ id: 'subject-math', name: '数学' }]);
        mocks.examAttemptFindMany.mockResolvedValue([]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('默认查询当前用户最近 90 天的已确认有效成绩且只选择趋势字段', async () => {
        const response = await GET(request());
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.range).toBe('90d');
        expect(data.summary).toEqual({
            examCount: 0,
            averageRate: null,
            latestRate: null,
            changeFromPrevious: null,
            wrongCount: 0,
        });
        expect(mocks.examAttemptFindMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-123',
                status: 'confirmed',
                totalScore: { not: null },
                maxScore: { gt: 0 },
                takenAt: { gte: new Date('2026-08-12T16:00:00.000Z') },
            },
            select: {
                id: true,
                takenAt: true,
                createdAt: true,
                totalScore: true,
                maxScore: true,
                paper: { select: { id: true, title: true, subjectId: true } },
                answers: { select: { result: true } },
            },
            orderBy: [{ takenAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        });
        expect(JSON.stringify(data)).not.toContain('NaN');
    });

    it('应用时间边界只包含起点及之后的作答', async () => {
        const before = attempt('before', '2026-08-12T15:59:59.999Z');
        const atBoundary = attempt('at-boundary', '2026-08-12T16:00:00.000Z');
        mocks.examAttemptFindMany.mockImplementation(({ where }: {
            where: { takenAt?: { gte: Date } };
        }) => {
            const start = where.takenAt?.gte;
            return Promise.resolve([before, atBoundary].filter(item => !start || item.takenAt >= start));
        });

        const data = await (await GET(request())).json();

        expect(data.points.map((point: { attemptId: string }) => point.attemptId))
            .toEqual(['at-boundary']);
    });

    it('合法学科限定试卷并回传筛选信息', async () => {
        mocks.subjectFindFirst.mockResolvedValue({ id: 'subject-math', name: '数学' });

        const data = await (await GET(request('?subjectId=subject-math'))).json();

        expect(mocks.subjectFindFirst).toHaveBeenCalledWith({
            where: { id: 'subject-math', userId: 'user-123' },
            select: { id: true, name: true },
        });
        expect(mocks.examAttemptFindMany.mock.calls[0][0].where.paper)
            .toEqual({ subjectId: 'subject-math' });
        expect(data.subjectId).toBe('subject-math');
        expect(data.subjectName).toBe('数学');
    });

    it('其他用户学科按未筛选处理且不移除顶层用户隔离', async () => {
        mocks.subjectFindFirst.mockResolvedValue(null);

        const data = await (await GET(request('?subjectId=foreign-subject'))).json();
        const where = mocks.examAttemptFindMany.mock.calls[0][0].where;

        expect(where.userId).toBe('user-123');
        expect(where.paper).toBeUndefined();
        expect(data.subjectId).toBeUndefined();
    });

    it('仅以当前用户学科映射补充趋势点名称', async () => {
        mocks.examAttemptFindMany.mockResolvedValue([
            attempt('one', '2026-11-01T01:00:00Z'),
        ]);

        const data = await (await GET(request())).json();

        expect(mocks.subjectFindMany).toHaveBeenCalledWith({
            where: { userId: 'user-123', id: { in: ['subject-math'] } },
            select: { id: true, name: true },
        });
        expect(data.points[0].subjectName).toBe('数学');
    });

    it('all 不添加时间起点且非法范围回落 90 天', async () => {
        const allData = await (await GET(request('?range=all'))).json();
        expect(allData.range).toBe('all');
        expect(mocks.examAttemptFindMany.mock.calls[0][0].where.takenAt).toBeUndefined();

        mocks.examAttemptFindMany.mockClear();
        const fallbackData = await (await GET(request('?range=invalid'))).json();
        expect(fallbackData.range).toBe('90d');
        expect(mocks.examAttemptFindMany.mock.calls[0][0].where.takenAt.gte)
            .toEqual(new Date('2026-08-12T16:00:00.000Z'));
    });

    it('未登录返回 401 且不查询作答', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null);

        const response = await GET(request());

        expect(response.status).toBe(401);
        expect(mocks.examAttemptFindMany).not.toHaveBeenCalled();
    });
});
