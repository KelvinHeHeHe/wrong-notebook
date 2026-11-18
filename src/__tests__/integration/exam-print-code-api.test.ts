import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    user: { findUnique: vi.fn() },
    examPaper: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
    },
    examPaperPage: { findMany: vi.fn() },
    session: { user: { email: 'user@example.com' }, expires: '2099-01-01' },
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.user,
        examPaper: mocks.examPaper,
        examPaperPage: mocks.examPaperPage,
    },
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(() => Promise.resolve(mocks.session)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { GET as DETAIL } from '@/app/api/exams/[id]/route';
import { GET as RESOLVE_PRINT_CODE } from '@/app/api/exams/print-code/[printCode]/route';

const routeParams = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const question = {
    id: 'question-1',
    paperId: 'paper-1',
    order: 1,
    status: 'ready',
    sourceShortId: 'AbC234',
    questionText: '1 + 1 = ?',
    answerText: '2',
    analysis: '相加',
    figureSvg: null,
    figureScale: 100,
    figureAlign: 'center',
    answerSpacePx: 80,
    score: 5,
    questionType: 'fill_blank',
    externalNumber: '1',
};
const paper = {
    id: 'paper-1',
    userId: 'user-1',
    title: '三年级数学练习',
    status: 'ready',
    scope: 'all',
    difficulty: 'medium',
    mode: 'original',
    requestedCount: 1,
    groupByType: false,
    subjectIds: '[]',
    tagNames: null,
    resultsRecordedAt: null,
    origin: 'generated',
    subjectId: null,
    gradeSemester: null,
    examType: null,
    examDate: null,
    totalScore: 5,
    sourceFileName: null,
    printCode: 'Ab3xYz91',
    createdAt: new Date('2026-11-17T00:00:00Z'),
    updatedAt: new Date('2026-11-17T00:00:00Z'),
    questions: [question],
};

describe('试卷打印短码 API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
        mocks.examPaper.updateMany.mockResolvedValue({ count: 1 });
    });

    it('格式错误的短码统一返回 404 且不查询试卷', async () => {
        const response = await RESOLVE_PRINT_CODE(
            new Request('http://localhost/api/exams/print-code/not-valid'),
            routeParams({ printCode: 'not-valid' }),
        );

        expect(response.status).toBe(404);
        expect(mocks.examPaper.findFirst).not.toHaveBeenCalled();
    });

    it('查询条件绑定当前用户，其他用户或不存在统一返回 404', async () => {
        mocks.examPaper.findFirst.mockResolvedValue(null);

        const response = await RESOLVE_PRINT_CODE(
            new Request('http://localhost/api/exams/print-code/Ab3xYz91'),
            routeParams({ printCode: 'Ab3xYz91' }),
        );

        expect(response.status).toBe(404);
        expect(mocks.examPaper.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { printCode: 'Ab3xYz91', userId: 'user-1' },
        }));
    });

    it('返回当前版次，并只在查询参数与当前版次相同时标记匹配', async () => {
        mocks.examPaper.findFirst.mockResolvedValue(paper);

        const missing = await RESOLVE_PRINT_CODE(
            new Request('http://localhost/api/exams/print-code/Ab3xYz91'),
            routeParams({ printCode: 'Ab3xYz91' }),
        );
        const missingBody = await missing.json();
        const wrong = await RESOLVE_PRINT_CODE(
            new Request('http://localhost/api/exams/print-code/Ab3xYz91?v=deadbeefdead'),
            routeParams({ printCode: 'Ab3xYz91' }),
        );
        const matching = await RESOLVE_PRINT_CODE(
            new Request(`http://localhost/api/exams/print-code/Ab3xYz91?v=${missingBody.currentPrintVersion}`),
            routeParams({ printCode: 'Ab3xYz91' }),
        );

        expect(missingBody).toMatchObject({
            paperId: 'paper-1',
            title: '三年级数学练习',
            printCode: 'Ab3xYz91',
            currentPrintVersion: expect.stringMatching(/^[a-f0-9]{12}$/),
            versionMatches: false,
        });
        expect(await wrong.json()).toMatchObject({ versionMatches: false });
        expect(await matching.json()).toMatchObject({ versionMatches: true });
    });

    it('旧卷关联错题的回退题型变化时返回新版次', async () => {
        mocks.examPaper.findFirst
            .mockResolvedValueOnce({
                ...paper,
                groupByType: true,
                questions: [{ ...question, questionType: null, errorItem: { questionType: 'single_choice' } }],
            })
            .mockResolvedValueOnce({
                ...paper,
                groupByType: true,
                questions: [{ ...question, questionType: null, errorItem: { questionType: 'fill_blank' } }],
            });

        const first = await RESOLVE_PRINT_CODE(
            new Request('http://localhost/api/exams/print-code/Ab3xYz91'),
            routeParams({ printCode: 'Ab3xYz91' }),
        );
        const second = await RESOLVE_PRINT_CODE(
            new Request('http://localhost/api/exams/print-code/Ab3xYz91'),
            routeParams({ printCode: 'Ab3xYz91' }),
        );

        expect((await second.json()).currentPrintVersion).not.toBe((await first.json()).currentPrintVersion);
        expect(mocks.examPaper.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.objectContaining({
                questions: expect.objectContaining({
                    select: expect.objectContaining({
                        errorItem: { select: { questionType: true } },
                    }),
                }),
            }),
        }));
    });

    it('详情接口为既有无短码试卷惰性补码并返回内容版次', async () => {
        mocks.examPaper.findUnique.mockImplementation(async (args: Record<string, unknown>) => {
            const where = args.where as Record<string, unknown>;
            const select = args.select as Record<string, unknown> | undefined;
            if (where.printCode) return null;
            if (select?.userId) return { userId: 'user-1', printCode: null };
            if (select?.printCode) return { id: 'paper-1', printCode: null };
            return { ...paper, printCode: null, questions: [{ ...question, errorItem: null, practiceRecords: [] }] };
        });

        const response = await DETAIL(
            new Request('http://localhost/api/exams/paper-1'),
            routeParams({ id: 'paper-1' }),
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.printCode).toMatch(/^[1-9A-HJ-NP-Za-km-z]{8}$/);
        expect(body.printVersion).toMatch(/^[a-f0-9]{12}$/);
        expect(mocks.examPaper.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'paper-1', printCode: null },
        }));
    });
});
