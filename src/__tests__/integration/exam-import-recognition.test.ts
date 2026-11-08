import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const tx = {
        examPaper: {
            findUnique: vi.fn(),
        },
        examQuestion: {
            deleteMany: vi.fn(),
            createMany: vi.fn(),
            findMany: vi.fn(),
            update: vi.fn(),
        },
    };
    return {
        tx,
        user: { findUnique: vi.fn() },
        examPaper: { findUnique: vi.fn(), updateMany: vi.fn() },
        transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
        splitQuestionsForUser: vi.fn(),
        session: { user: { email: 'user@example.com' }, expires: '2099-01-01' },
    };
});

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.user,
        examPaper: mocks.examPaper,
        $transaction: mocks.transaction,
    },
}));
vi.mock('@/lib/question/question-analysis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/question/question-analysis')>()),
    splitQuestionsForUser: mocks.splitQuestionsForUser,
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(() => Promise.resolve(mocks.session)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { POST as RECOGNIZE } from '@/app/api/exams/[id]/recognize/route';

const request = (body: object) => new Request('http://localhost/api/exams/paper-1/recognize', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
});
const params = { params: Promise.resolve({ id: 'paper-1' }) };
const splitResult = (label: string) => ({
    questions: [{
        label,
        text: `${label} + 1 = ?`,
        material: null,
        section: null,
        regions: [{ x: 0.1, y: 0.1, width: 0.8, height: 0.2 }],
        hasFigure: false,
        flags: [],
    }],
    ignored: [],
    warnings: [],
});

describe('外部试卷按页识别', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
        mocks.examPaper.findUnique.mockResolvedValue({
            id: 'paper-1',
            userId: 'user-1',
            origin: 'imported',
            status: 'review',
            updatedAt: new Date('2026-11-08T00:00:00Z'),
            pages: [
                { id: 'page-1', order: 1, role: 'questions', imageData: 'data:image/jpeg;base64,cGFnZTE=', mimeType: 'image/jpeg' },
                { id: 'page-2', order: 2, role: 'questions', imageData: 'data:image/jpeg;base64,cGFnZTI=', mimeType: 'image/jpeg' },
            ],
        });
        mocks.tx.examQuestion.findMany.mockResolvedValue([{ id: 'question-1' }]);
        mocks.tx.examPaper.findUnique.mockImplementation(({ select }: { select?: { pages?: unknown } }) => Promise.resolve({
            status: 'importing',
            ...(select?.pages ? { pages: [{ role: 'questions', checksum: null }] } : {}),
        }));
        mocks.tx.examQuestion.createMany.mockResolvedValue({ count: 1 });
        mocks.tx.examQuestion.deleteMany.mockResolvedValue({ count: 1 });
        mocks.tx.examQuestion.update.mockResolvedValue({ id: 'question-1' });
        mocks.examPaper.updateMany.mockResolvedValue({ count: 1 });
    });

    it('两页一成一败时保留成功页并继续处理，最终进入 review', async () => {
        mocks.splitQuestionsForUser
            .mockResolvedValueOnce(splitResult('1'))
            .mockRejectedValueOnce(new Error('AI_TIMEOUT_ERROR'));

        const response = await RECOGNIZE(request({ pageOrders: [1, 2], language: 'en' }), params);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            successes: [{ pageOrder: 1, questionCount: 1 }],
            failures: [{ pageOrder: 2, error: 'AI_TIMEOUT_ERROR' }],
            status: 'review',
        });
        expect(mocks.splitQuestionsForUser).toHaveBeenNthCalledWith(1, 'user-1', {
            kind: 'image', imageBase64: 'cGFnZTE=', mimeType: 'image/jpeg', language: 'en',
        }, '/exams/paper-1/import');
        expect(mocks.transaction).toHaveBeenCalledTimes(1);
        expect(mocks.tx.examQuestion.deleteMany).toHaveBeenCalledWith({ where: { paperId: 'paper-1', pageNumber: 1 } });
        expect(mocks.tx.examQuestion.deleteMany).not.toHaveBeenCalledWith({ where: { paperId: 'paper-1', pageNumber: 2 } });
        expect(mocks.examPaper.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: 'paper-1', userId: 'user-1', origin: 'imported', status: { not: 'ready' },
                updatedAt: new Date('2026-11-08T00:00:00Z'),
            }),
            data: expect.objectContaining({ status: 'review', updatedAt: expect.any(Date) }),
        }));
    });

    it('失败页重试成功时只替换该页并重排全卷顺序', async () => {
        mocks.splitQuestionsForUser.mockResolvedValueOnce(splitResult('2'));
        mocks.tx.examQuestion.findMany.mockResolvedValueOnce([{ id: 'question-old-page-1' }, { id: 'question-new-page-2' }]);

        const response = await RECOGNIZE(request({ pageOrders: [2] }), params);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ successes: [{ pageOrder: 2, questionCount: 1 }], failures: [] });
        expect(mocks.tx.examQuestion.deleteMany).toHaveBeenCalledTimes(1);
        expect(mocks.tx.examQuestion.deleteMany).toHaveBeenCalledWith({ where: { paperId: 'paper-1', pageNumber: 2 } });
        expect(mocks.tx.examQuestion.update.mock.calls.map((call) => call[0])).toEqual([
            { where: { id: 'question-old-page-1' }, data: { order: 1 } },
            { where: { id: 'question-new-page-2' }, data: { order: 2 } },
        ]);
    });

    it('重复识别仅替换请求中的目标页', async () => {
        mocks.splitQuestionsForUser.mockResolvedValueOnce(splitResult('1'));

        await RECOGNIZE(request({ pageOrders: [1] }), params);

        expect(mocks.splitQuestionsForUser).toHaveBeenCalledTimes(1);
        expect(mocks.tx.examQuestion.deleteMany).toHaveBeenCalledWith({ where: { paperId: 'paper-1', pageNumber: 1 } });
    });

    it('AI 返回空题目时视为该页失败且不删除旧草稿', async () => {
        mocks.splitQuestionsForUser.mockResolvedValueOnce({ questions: [], ignored: [], warnings: [] });

        const response = await RECOGNIZE(request({ pageOrders: [1] }), params);

        expect(await response.json()).toEqual({
            successes: [],
            failures: [{ pageOrder: 1, error: 'EXAM_PAGE_NO_QUESTIONS' }],
            status: 'review',
        });
        expect(mocks.transaction).not.toHaveBeenCalled();
        expect(mocks.tx.examQuestion.deleteMany).not.toHaveBeenCalled();
    });

    it('AI 返回后若试卷已经发布，不写入迟到的识别结果且不降级状态', async () => {
        mocks.splitQuestionsForUser.mockResolvedValueOnce(splitResult('1'));
        mocks.tx.examPaper.findUnique.mockResolvedValueOnce({ status: 'ready', pages: [{ role: 'questions', checksum: null }] });
        mocks.examPaper.findUnique
            .mockResolvedValueOnce({
                id: 'paper-1', userId: 'user-1', origin: 'imported', status: 'review',
                updatedAt: new Date('2026-11-08T00:00:00Z'),
                pages: [{ id: 'page-1', order: 1, role: 'questions', imageData: 'data:image/jpeg;base64,cGFnZTE=', mimeType: 'image/jpeg', checksum: null }],
            })
            .mockResolvedValueOnce({ status: 'ready' });

        const response = await RECOGNIZE(request({ pageOrders: [1] }), params);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            successes: [],
            failures: [{ pageOrder: 1, error: 'IMPORTED_EXAM_ALREADY_PUBLISHED' }],
            status: 'ready',
        });
        expect(mocks.tx.examQuestion.deleteMany).not.toHaveBeenCalled();
        expect(mocks.tx.examQuestion.createMany).not.toHaveBeenCalled();
    });

    it('AI 返回后若页面已改为答案页，不写入该页题目', async () => {
        mocks.splitQuestionsForUser.mockResolvedValueOnce(splitResult('1'));
        mocks.tx.examPaper.findUnique.mockResolvedValueOnce({ status: 'review', pages: [{ role: 'answer_key', checksum: null }] });

        const response = await RECOGNIZE(request({ pageOrders: [1] }), params);

        expect(await response.json()).toMatchObject({
            successes: [],
            failures: [{ pageOrder: 1, error: 'EXAM_PAGE_CHANGED' }],
        });
        expect(mocks.tx.examQuestion.deleteMany).not.toHaveBeenCalled();
    });

    it('开始识别前试卷若已被并发修改，停止调用 AI 并返回冲突', async () => {
        mocks.examPaper.updateMany.mockResolvedValueOnce({ count: 0 });

        const response = await RECOGNIZE(request({ pageOrders: [1] }), params);

        expect(response.status).toBe(409);
        expect(mocks.splitQuestionsForUser).not.toHaveBeenCalled();
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('拒绝识别他人试卷、已发布试卷和答案页', async () => {
        mocks.examPaper.findUnique.mockResolvedValueOnce({
            id: 'paper-1', userId: 'other', origin: 'imported', status: 'review', pages: [],
        });
        const other = await RECOGNIZE(request({ pageOrders: [1] }), params);

        mocks.examPaper.findUnique.mockResolvedValueOnce({
            id: 'paper-1', userId: 'user-1', origin: 'imported', status: 'ready', pages: [],
        });
        const ready = await RECOGNIZE(request({ pageOrders: [1] }), params);

        mocks.examPaper.findUnique.mockResolvedValueOnce({
            id: 'paper-1', userId: 'user-1', origin: 'imported', status: 'review',
            pages: [{ id: 'answer-1', order: 1, role: 'answer_key', imageData: 'data:image/jpeg;base64,YQ==', mimeType: 'image/jpeg' }],
        });
        const answerPage = await RECOGNIZE(request({ pageOrders: [1] }), params);

        expect(other.status).toBe(404);
        expect(ready.status).toBe(409);
        expect(await answerPage.json()).toMatchObject({ failures: [{ pageOrder: 1, error: 'EXAM_PAGE_NOT_RECOGNIZABLE' }] });
        expect(mocks.splitQuestionsForUser).not.toHaveBeenCalled();
    });
});
