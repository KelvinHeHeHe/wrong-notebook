import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const tx = {
        examPaper: { update: vi.fn(), updateMany: vi.fn() },
        examPaperPage: { update: vi.fn() },
        examQuestion: { deleteMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    };
    return {
        tx,
        user: { findUnique: vi.fn() },
        subject: { findFirst: vi.fn() },
        examPaper: { findUnique: vi.fn(), update: vi.fn() },
        examQuestion: { updateMany: vi.fn() },
        transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
        session: { user: { email: 'user@example.com' }, expires: '2099-01-01' },
    };
});

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.user,
        subject: mocks.subject,
        examPaper: mocks.examPaper,
        examQuestion: mocks.examQuestion,
        $transaction: mocks.transaction,
    },
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(() => Promise.resolve(mocks.session)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { PATCH } from '@/app/api/exams/[id]/route';

const params = { params: Promise.resolve({ id: 'paper-1' }) };
const request = (body: object) => new Request('http://localhost/api/exams/paper-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
});
const region = { x: 0.1, y: 0.1, width: 0.8, height: 0.2 };
const basePaper = () => ({
    id: 'paper-1',
    userId: 'user-1',
    origin: 'imported',
    status: 'review',
    updatedAt: new Date('2026-11-08T00:00:00Z'),
    subjectId: 'subject-1',
    pages: [
        { id: 'page-1', order: 1, role: 'questions' },
        { id: 'page-2', order: 2, role: 'questions' },
    ],
    questions: [
        { id: 'question-1', pageNumber: 1 },
        { id: 'question-2', pageNumber: 2 },
    ],
});
const draft = (overrides: Record<string, unknown> = {}) => ({
    kind: 'import-draft',
    title: '校对后的试卷',
    subjectId: 'subject-1',
    gradeSemester: 'primary_3_1',
    examType: 'unit',
    examDate: '2026-11-08T00:00:00.000Z',
    totalScore: 10,
    pages: [
        { id: 'page-1', order: 1, role: 'questions' },
        { id: 'page-2', order: 2, role: 'answer_key' },
    ],
    questions: [
        { id: 'question-1', externalNumber: '1', pageNumber: 1, regions: [region], questionText: '1 + 1 = ?', answerText: '2', score: 5 },
        { externalNumber: '2', pageNumber: 1, regions: [{ ...region, y: 0.5 }], questionText: '2 + 2 = ?', answerText: '4', score: 5 },
    ],
    publish: false,
    ...overrides,
});

describe('外部试卷校对与发布', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
        mocks.subject.findFirst.mockResolvedValue({ id: 'subject-1' });
        mocks.examPaper.findUnique.mockResolvedValue(basePaper());
        mocks.tx.examPaper.update.mockResolvedValue({ id: 'paper-1', status: 'review', totalScore: 10 });
        mocks.tx.examPaper.updateMany.mockResolvedValue({ count: 1 });
        mocks.tx.examPaperPage.update.mockResolvedValue({});
        mocks.tx.examQuestion.deleteMany.mockResolvedValue({ count: 1 });
        mocks.tx.examQuestion.update.mockResolvedValue({});
        mocks.tx.examQuestion.create.mockResolvedValue({ id: 'question-new' });
    });

    it('在一个事务中保存元数据、页面角色以及题目新增删除重排', async () => {
        const response = await PATCH(request(draft()), params);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: 'paper-1', status: 'review', totalScore: 10 });
        expect(mocks.transaction).toHaveBeenCalledTimes(1);
        expect(mocks.tx.examQuestion.deleteMany).toHaveBeenCalledWith({
            where: { paperId: 'paper-1', id: { notIn: ['question-1'] } },
        });
        expect(mocks.tx.examQuestion.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'question-1' },
            data: expect.objectContaining({ order: 1, pageNumber: 1, questionText: '1 + 1 = ?', regionJson: JSON.stringify([region]) }),
        }));
        expect(mocks.tx.examQuestion.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ paperId: 'paper-1', order: 2, sourceShortId: 'IMP-MANUAL-002', errorItemId: null }),
        }));
        expect(mocks.tx.examPaper.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'paper-1' },
            data: expect.objectContaining({ title: '校对后的试卷', status: 'review', requestedCount: 2, subjectIds: '["subject-1"]' }),
        }));
        expect(mocks.tx).not.toHaveProperty('errorItem');
        expect(mocks.tx).not.toHaveProperty('practiceRecord');
    });

    it('跨卷题目 ID、页面 ID 或学科不能进入事务', async () => {
        const foreignQuestion = await PATCH(request(draft({
            questions: [{ id: 'question-other', pageNumber: 1, regions: [region], questionText: '越权题', score: 10 }],
        })), params);
        const foreignPage = await PATCH(request(draft({
            pages: [{ id: 'page-other', order: 1, role: 'questions' }],
            questions: [{ pageNumber: 1, regions: [region], questionText: '题目', score: 10 }],
        })), params);
        mocks.subject.findFirst.mockResolvedValueOnce(null);
        const foreignSubject = await PATCH(request(draft({ subjectId: 'subject-other' })), params);

        expect(foreignQuestion.status).toBe(400);
        expect(foreignPage.status).toBe(400);
        expect(foreignSubject.status).toBe(400);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it.each([
        ['题目页没有题目', draft({ questions: [], publish: true }), 'QUESTION_PAGE_EMPTY'],
        ['题目指向答案页', draft({ questions: [{ id: 'question-1', pageNumber: 2, regions: [region], questionText: '题目', score: 10 }], publish: true }), 'QUESTION_PAGE_EMPTY'],
        ['标称总分不一致', draft({ totalScore: 20, publish: true }), 'TOTAL_SCORE_MISMATCH'],
    ])('发布前拒绝%s', async (_name, body, errorCode) => {
        const response = await PATCH(request(body), params);
        const payload = await response.json();

        expect(response.status).toBe(400);
        expect(payload.details).toContain(errorCode);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('发布时拒绝空题干，非法区域始终由共享 schema 拒绝', async () => {
        const emptyText = await PATCH(request(draft({
            questions: [{ id: 'question-1', pageNumber: 1, regions: [region], questionText: ' ', score: 10 }], publish: true,
        })), params);
        const badRegion = await PATCH(request(draft({
            questions: [{ id: 'question-1', pageNumber: 1, regions: [{ x: 0.9, y: 0, width: 0.5, height: 0.5 }], questionText: '题目', score: 10 }],
        })), params);

        expect(emptyText.status).toBe(400);
        expect(badRegion.status).toBe(400);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('事务开始前试卷若已被另一请求发布，不允许旧草稿覆盖 ready 状态', async () => {
        mocks.tx.examPaper.updateMany.mockResolvedValueOnce({ count: 0 });

        const response = await PATCH(request(draft()), params);

        expect(response.status).toBe(409);
        expect(mocks.tx.examPaperPage.update).not.toHaveBeenCalled();
        expect(mocks.tx.examQuestion.deleteMany).not.toHaveBeenCalled();
        expect(mocks.tx.examPaper.update).not.toHaveBeenCalled();
    });

    it('发布时推导或校验总分并只把试卷转为 ready', async () => {
        mocks.tx.examPaper.update.mockResolvedValueOnce({ id: 'paper-1', status: 'ready', totalScore: 10 });
        const response = await PATCH(request(draft({ totalScore: null, publish: true })), params);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: 'paper-1', status: 'ready', totalScore: 10 });
        expect(mocks.tx.examPaper.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'ready', totalScore: 10 }),
        }));
        expect(mocks.tx).not.toHaveProperty('errorItem');
        expect(mocks.tx).not.toHaveProperty('practiceRecord');
    });

    it('不允许校对他人、生成型或已发布试卷', async () => {
        mocks.examPaper.findUnique.mockResolvedValueOnce({ ...basePaper(), userId: 'other' });
        const other = await PATCH(request(draft()), params);
        mocks.examPaper.findUnique.mockResolvedValueOnce({ ...basePaper(), origin: 'generated' });
        const generated = await PATCH(request(draft()), params);
        mocks.examPaper.findUnique.mockResolvedValueOnce({ ...basePaper(), status: 'ready' });
        const ready = await PATCH(request(draft()), params);

        expect(other.status).toBe(404);
        expect(generated.status).toBe(404);
        expect(ready.status).toBe(409);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });
});
