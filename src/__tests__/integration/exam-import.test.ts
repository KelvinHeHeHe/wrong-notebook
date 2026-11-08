import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const tx = {
        examPaper: { create: vi.fn(), update: vi.fn() },
        examPaperPage: { create: vi.fn(), update: vi.fn() },
        examQuestion: { deleteMany: vi.fn() },
    };
    return {
        tx,
        user: { findUnique: vi.fn() },
        subject: { findFirst: vi.fn() },
        examPaper: { findUnique: vi.fn(), findMany: vi.fn() },
        transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
        session: { user: { email: 'user@example.com' }, expires: '2099-01-01' },
    };
});

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.user,
        subject: mocks.subject,
        examPaper: mocks.examPaper,
        $transaction: mocks.transaction,
    },
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(() => Promise.resolve(mocks.session)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { POST as CREATE_IMPORTED } from '@/app/api/exams/import/route';
import { POST as UPSERT_PAGES } from '@/app/api/exams/[id]/pages/route';
import { GET as LIST } from '@/app/api/exams/route';
import { GET as DETAIL } from '@/app/api/exams/[id]/route';

const json = (url: string, body: object) => new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const page = (order: number, overrides: Record<string, unknown> = {}) => ({
    order,
    role: 'questions',
    imageData: `data:image/jpeg;base64,cGFnZS0${order}`,
    mimeType: 'image/jpeg',
    width: 1200,
    height: 1600,
    ...overrides,
});

describe('外部整卷草稿与页面 API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
        mocks.subject.findFirst.mockResolvedValue({ id: 'subject-1' });
        mocks.tx.examPaper.create.mockResolvedValue({
            id: 'paper-1',
            title: '数学单元测验',
            status: 'importing',
            pages: [{ id: 'page-1', order: 1, role: 'questions' }],
        });
    });

    it('在一个事务中创建 1～20 页 imported 草稿并由服务端写入 checksum', async () => {
        const response = await CREATE_IMPORTED(json('http://localhost/api/exams/import', {
            title: '数学单元测验',
            subjectId: 'subject-1',
            examType: 'unit',
            examDate: '2026-11-08T00:00:00.000Z',
            totalScore: 100,
            sourceFileName: 'unit.pdf',
            pages: [page(1)],
        }));

        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({
            paperId: 'paper-1',
            status: 'importing',
            pages: [{ id: 'page-1', order: 1, role: 'questions' }],
        });
        const data = mocks.tx.examPaper.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
            userId: 'user-1',
            origin: 'imported',
            mode: 'original',
            scope: 'all',
            difficulty: 'original',
            requestedCount: 0,
            subjectId: 'subject-1',
            subjectIds: '["subject-1"]',
            status: 'importing',
        });
        expect(data.pages.create[0]).toMatchObject({
            order: 1,
            role: 'questions',
            checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(data).not.toHaveProperty('questions');
    });

    it('拒绝使用其他用户的学科且不创建半份试卷', async () => {
        mocks.subject.findFirst.mockResolvedValue(null);

        const response = await CREATE_IMPORTED(json('http://localhost/api/exams/import', {
            title: '越权', subjectId: 'other-subject', pages: [page(1)],
        }));

        expect(response.status).toBe(400);
        expect(mocks.tx.examPaper.create).not.toHaveBeenCalled();
    });

    it('在数据库调用前拒绝跨角色重复物理页和重复图片', async () => {
        const imageData = 'data:image/jpeg;base64,c2FtZQ==';
        const response = await CREATE_IMPORTED(json('http://localhost/api/exams/import', {
            title: '重复',
            subjectId: 'subject-1',
            pages: [page(1, { imageData }), page(1, { role: 'answer_key', imageData: 'data:image/jpeg;base64,b3RoZXI=' })],
        }));
        const duplicateImage = await CREATE_IMPORTED(json('http://localhost/api/exams/import', {
            title: '重复图', subjectId: 'subject-1', pages: [page(1, { imageData }), page(2, { imageData })],
        }));

        expect(response.status).toBe(400);
        expect(duplicateImage.status).toBe(400);
        expect(mocks.tx.examPaper.create).not.toHaveBeenCalled();
    });

    it('按物理页序替换页面，切为答案页时删除该页题目并恢复 importing', async () => {
        mocks.examPaper.findUnique.mockResolvedValue({
            id: 'paper-1',
            userId: 'user-1',
            origin: 'imported',
            status: 'review',
            pages: [{
                id: 'page-1', order: 1, role: 'questions', checksum: 'old',
                imageData: 'data:image/jpeg;base64,b2xk', mimeType: 'image/jpeg', width: 1000, height: 1400,
            }],
        });
        mocks.tx.examPaperPage.update.mockResolvedValue({ id: 'page-1', order: 1, role: 'answer_key' });
        mocks.tx.examPaper.update.mockResolvedValue({ id: 'paper-1', status: 'importing' });

        const response = await UPSERT_PAGES(json('http://localhost/api/exams/paper-1/pages', {
            pages: [page(1, { role: 'answer_key', imageData: 'data:image/jpeg;base64,bmV3' })],
        }), params('paper-1'));

        expect(response.status).toBe(200);
        expect(mocks.tx.examPaperPage.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'page-1' },
            data: expect.objectContaining({ role: 'answer_key', checksum: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        }));
        expect(mocks.tx.examQuestion.deleteMany).toHaveBeenCalledWith({ where: { paperId: 'paper-1', pageNumber: 1 } });
        expect(mocks.tx.examPaper.update).toHaveBeenCalledWith({ where: { id: 'paper-1' }, data: { status: 'importing' } });
    });

    it('追加新物理页但不允许修改他人或已发布试卷', async () => {
        mocks.examPaper.findUnique.mockResolvedValueOnce({ id: 'paper-1', userId: 'other', origin: 'imported', status: 'review', pages: [] });
        const other = await UPSERT_PAGES(json('http://localhost', { pages: [page(1)] }), params('paper-1'));

        mocks.examPaper.findUnique.mockResolvedValueOnce({ id: 'paper-1', userId: 'user-1', origin: 'imported', status: 'ready', pages: [] });
        const ready = await UPSERT_PAGES(json('http://localhost', { pages: [page(1)] }), params('paper-1'));

        expect(other.status).toBe(404);
        expect(ready.status).toBe(409);
        expect(mocks.tx.examPaperPage.create).not.toHaveBeenCalled();
    });

    it('列表和详情为 imported 试卷返回来源、元数据与有序页面', async () => {
        mocks.examPaper.findMany.mockResolvedValue([{
            id: 'paper-1', title: '导入卷', origin: 'imported', subjectId: 'subject-1', gradeSemester: 'primary_3_1',
            examType: 'unit', examDate: new Date('2026-11-08T00:00:00Z'), totalScore: 100, sourceFileName: 'unit.pdf',
            questions: [{ status: 'ready', _count: { practiceRecords: 0 } }],
        }]);
        mocks.examPaper.findUnique.mockResolvedValue({
            id: 'paper-1', userId: 'user-1', title: '导入卷', status: 'review', origin: 'imported',
            pages: [{ id: 'page-2', order: 2, role: 'answer_key', imageData: 'data:image/jpeg;base64,Yg==', mimeType: 'image/jpeg', width: 100, height: 100, checksum: 'b' },
                { id: 'page-1', order: 1, role: 'questions', imageData: 'data:image/jpeg;base64,YQ==', mimeType: 'image/jpeg', width: 100, height: 100, checksum: 'a' }],
            questions: [{
                id: 'question-1', order: 1, status: 'ready', externalNumber: '1', pageNumber: 1,
                regionJson: '[{"x":0,"y":0,"width":1,"height":0.5}]', recognitionConfidence: null,
                errorItem: null, practiceRecords: [], score: 5, questionType: null, figureScale: 100, figureAlign: 'center', answerSpacePx: null,
            }],
        });

        const list = await (await LIST()).json();
        const detail = await (await DETAIL(new Request('http://localhost'), params('paper-1'))).json();

        expect(list[0]).toMatchObject({ origin: 'imported', subjectId: 'subject-1', examType: 'unit', questionCount: 1 });
        expect(detail.pages.map((item: { order: number }) => item.order)).toEqual([1, 2]);
        expect(detail.questions[0]).toMatchObject({ externalNumber: '1', pageNumber: 1 });
    });
});
