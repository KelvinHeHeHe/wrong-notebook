import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const tx = {
        examPaper: { findUnique: vi.fn() },
        examAttempt: { create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
        examAttemptPage: { create: vi.fn(), update: vi.fn() },
        examAttemptAnswer: { findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    };
    return {
        tx,
        user: { findUnique: vi.fn() },
        examPaper: { findUnique: vi.fn() },
        examAttempt: { findUnique: vi.fn(), findMany: vi.fn() },
        transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
        session: { user: { email: 'user@example.com' }, expires: '2099-01-01' },
    };
});

vi.mock('@/lib/prisma', () => ({ prisma: {
    user: mocks.user,
    examPaper: mocks.examPaper,
    examAttempt: mocks.examAttempt,
    $transaction: mocks.transaction,
} }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(() => Promise.resolve(mocks.session)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { GET as LIST, POST as CREATE } from '@/app/api/exams/[id]/attempts/route';
import { GET as DETAIL } from '@/app/api/exam-attempts/[id]/route';
import { POST as UPLOAD } from '@/app/api/exam-attempts/[id]/pages/route';
import { upsertExamAttemptPagesSchema } from '@/lib/schemas/exam-attempt';

const initialUpdatedAt = new Date('2026-11-08T00:00:00.000Z');
const nextUpdatedAt = new Date('2026-11-08T01:00:00.000Z');
const params = (id = 'attempt-1') => ({ params: Promise.resolve({ id }) });
const json = (body: unknown) => new Request('http://localhost/api/exam-attempts/attempt-1/pages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const imageBytes = (marker: number) => Buffer.concat([PNG, Buffer.from([marker])]);
const checksum = (marker: number) => createHash('sha256').update(imageBytes(marker)).digest('hex');
const page = (order: number, overrides: Record<string, unknown> = {}) => ({
    order, imageData: `data:image/png;base64,${imageBytes(order).toString('base64')}`,
    mimeType: 'image/png', width: 1, height: 1, ...overrides,
});
const existingPage = (order: number) => ({
    id: `page-${order}`, attemptId: 'attempt-1', ...page(order), checksum: checksum(order),
    recognitionResult: '{"candidates":[]}', createdAt: initialUpdatedAt, updatedAt: initialUpdatedAt,
});
const attempt = (overrides: Record<string, unknown> = {}) => ({
    id: 'attempt-1', userId: 'user-1', paperId: 'paper-1', status: 'review',
    takenAt: initialUpdatedAt, totalScore: null, maxScore: null, comment: null, confirmedAt: null,
    createdAt: initialUpdatedAt, updatedAt: initialUpdatedAt, pages: [existingPage(1)], answers: [],
    ...overrides,
});
const upload = (pages: ReturnType<typeof page>[], overrides: Record<string, unknown> = {}) => UPLOAD(json({
    pages, expectedUpdatedAt: initialUpdatedAt.toISOString(), ...overrides,
}), params());
const region = (pageOrder: number) => JSON.stringify({ pageOrder, candidateId: `candidate-${pageOrder}`, regions: [] });
const selectPage = (data: Record<string, unknown>, select?: Record<string, boolean>) => select
    ? Object.fromEntries(Object.entries(data).filter(([key]) => select[key]))
    : data;

describe('纸质试卷作答与页面 API', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.transaction.mockImplementation(async (callback) => callback(mocks.tx));
        mocks.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
        mocks.examPaper.findUnique.mockResolvedValue({ id: 'paper-1', userId: 'user-1', status: 'ready' });
        mocks.tx.examPaper.findUnique.mockResolvedValue({ id: 'paper-1', userId: 'user-1', status: 'ready' });
        mocks.examAttempt.findUnique.mockResolvedValue(attempt());
        mocks.tx.examAttempt.create.mockResolvedValue(attempt({ status: 'uploaded' }));
        mocks.tx.examAttempt.updateMany.mockResolvedValue({ count: 1 });
        mocks.tx.examAttempt.findUnique.mockResolvedValue(attempt({ status: 'uploaded', updatedAt: nextUpdatedAt }));
        mocks.tx.examAttemptPage.create.mockImplementation(async ({ data, select }) => selectPage({ id: 'new-page', ...data }, select));
        mocks.tx.examAttemptPage.update.mockImplementation(async ({ data, where, select }) => selectPage({ id: where.id, order: 1, ...data }, select));
        mocks.tx.examAttemptAnswer.findMany.mockResolvedValue([]);
    });

    it('只有本人 ready 试卷可创建作答，写接口返回 updatedAt', async () => {
        const response = await CREATE(json({ takenAt: '2026-11-08T08:00:00+08:00', comment: '第一次作答' }), params('paper-1'));
        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ attemptId: 'attempt-1', status: 'uploaded', updatedAt: initialUpdatedAt.toISOString() });
        expect(mocks.tx.examAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
            userId: 'user-1', paperId: 'paper-1', takenAt: initialUpdatedAt, comment: '第一次作答', status: 'uploaded',
        }) }));
    });

    it.each([
        [null, 404],
        [{ id: 'paper-1', userId: 'other-user', status: 'ready' }, 404],
        [{ id: 'paper-1', userId: 'other-user', status: 'review' }, 404],
        [{ id: 'paper-1', userId: 'user-1', status: 'review' }, 409],
    ])('拒绝不存在、他人或未发布的试卷 %#', async (paper, status) => {
        mocks.examPaper.findUnique.mockResolvedValue(paper);
        mocks.tx.examPaper.findUnique.mockResolvedValue(paper);
        const response = await CREATE(json({ takenAt: initialUpdatedAt.toISOString() }), params('paper-1'));
        expect(response.status).toBe(status);
        expect(mocks.tx.examAttempt.create).not.toHaveBeenCalled();
    });

    it.each([
        { latestPaper: null, expectedStatus: 404 },
        { latestPaper: { id: 'paper-1', userId: 'user-1', status: 'review' }, expectedStatus: 409 },
        { latestPaper: { id: 'paper-1', userId: 'other-user', status: 'ready' }, expectedStatus: 404 },
    ])('在创建事务内按最新试卷归属和状态校验，删除或变更后不创建 %#', async ({ latestPaper, expectedStatus }) => {
        mocks.tx.examPaper.findUnique.mockResolvedValue(latestPaper);
        const response = await CREATE(json({ takenAt: initialUpdatedAt.toISOString() }), params('paper-1'));
        expect(response.status).toBe(expectedStatus);
        expect(mocks.tx.examAttempt.create).not.toHaveBeenCalled();
        expect(mocks.examPaper.findUnique).not.toHaveBeenCalled();
    });

    it.each([
        {}, { takenAt: '2026-11-08T08:00:00' }, { takenAt: 'bad' },
        { takenAt: initialUpdatedAt.toISOString(), comment: '字'.repeat(501) },
    ])('校验创建日期必须带时区且备注至多 500 字 %#', async (body) => {
        expect((await CREATE(json(body), params('paper-1'))).status).toBe(400);
        expect(mocks.tx.examAttempt.create).not.toHaveBeenCalled();
    });

    it('列表限定本人试卷、按作答日期倒序且不查询页图', async () => {
        mocks.examAttempt.findMany.mockResolvedValue([
            { id: 'attempt-2', takenAt: nextUpdatedAt, _count: { pages: 2 } },
            { id: 'attempt-1', takenAt: initialUpdatedAt, _count: { pages: 0 } },
        ]);
        const response = await LIST(new Request('http://localhost/api/exams/paper-1/attempts'), params('paper-1'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([
            { id: 'attempt-2', takenAt: nextUpdatedAt.toISOString(), pageCount: 2 },
            { id: 'attempt-1', takenAt: initialUpdatedAt.toISOString(), pageCount: 0 },
        ]);
        expect(mocks.examAttempt.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { paperId: 'paper-1', userId: 'user-1' }, orderBy: { takenAt: 'desc' },
        }));
        const query = mocks.examAttempt.findMany.mock.calls[0][0];
        expect(query.include?.pages).toBeUndefined();
        expect(query.select?.pages).toBeUndefined();
    });

    it('详情包含后续作答界面需要的试卷摘要', async () => {
        const summary = { id: 'paper-1', title: '数学单元测验', status: 'ready', origin: 'imported' };
        mocks.examAttempt.findUnique.mockImplementation(async ({ include }) => attempt(include?.paper ? { paper: summary } : {}));
        const response = await DETAIL(new Request('http://localhost/api/exam-attempts/attempt-1'), params());
        expect(response.status).toBe(200);
        expect((await response.json()).paper).toEqual(summary);
        expect(mocks.examAttempt.findUnique.mock.calls[0][0].include.paper).toEqual({
            select: { id: true, title: true, status: true, origin: true },
        });
    });

    it('他人试卷的列表返回 404 而非空列表', async () => {
        mocks.examPaper.findUnique.mockResolvedValue({ id: 'paper-1', userId: 'other-user', status: 'ready' });
        expect((await LIST(new Request('http://localhost'), params('paper-1'))).status).toBe(404);
        expect(mocks.examAttempt.findMany).not.toHaveBeenCalled();
    });

    it('详情默认返回页元数据，显式 includePages=1 才返回页图', async () => {
        const response = await DETAIL(new Request('http://localhost/api/exam-attempts/attempt-1'), params());
        const detail = await response.json();
        expect(response.status).toBe(200);
        expect(detail.pages[0]).toMatchObject({ id: 'page-1', order: 1, checksum: checksum(1) });
        expect(detail.pages[0]).not.toHaveProperty('imageData');
        const query = mocks.examAttempt.findUnique.mock.calls[0][0];
        expect(query.include.pages.select.imageData).not.toBe(true);
        const withImages = await DETAIL(new Request('http://localhost/api/exam-attempts/attempt-1?includePages=1'), params());
        expect((await withImages.json()).pages[0].imageData).toBe(page(1).imageData);
    });

    it.each([null, attempt({ userId: 'other-user' })])('详情不泄露他人资源 %#', async (data) => {
        mocks.examAttempt.findUnique.mockResolvedValue(data);
        const response = await DETAIL(new Request('http://localhost'), params());
        expect(response.status).toBe(404);
        expect(await response.json()).not.toHaveProperty('pages');
    });

    it('上传无 role 的页图，以真实内容计算 checksum 并返回新的 updatedAt', async () => {
        mocks.examAttempt.findUnique.mockResolvedValue(attempt({ pages: [] }));
        const response = await upload([page(2)]);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ updatedAt: nextUpdatedAt.toISOString(), status: 'uploaded' });
        expect(mocks.tx.examAttemptPage.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
            attemptId: 'attempt-1', order: 2, checksum: checksum(2),
        }) }));
        expect(mocks.tx.examAttemptPage.create.mock.calls[0][0].data).not.toHaveProperty('role');
        expect(mocks.tx.examAttempt.updateMany).toHaveBeenCalledWith({
            where: { id: 'attempt-1', userId: 'user-1', updatedAt: initialUpdatedAt, status: { not: 'confirmed' } },
            data: expect.objectContaining({ status: 'uploaded', updatedAt: expect.any(Date) }),
        });
    });

    it.each(['create', 'replace'])('上传 %s 的响应只含页元数据，不读取或回传大图', async (kind) => {
        if (kind === 'create') mocks.examAttempt.findUnique.mockResolvedValue(attempt({ pages: [] }));
        const response = await upload([page(1, { imageData: page(9).imageData })]);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.pages[0]).toMatchObject({ order: 1, checksum: checksum(9) });
        expect(body.pages[0]).not.toHaveProperty('imageData');
        const write = kind === 'create' ? mocks.tx.examAttemptPage.create : mocks.tx.examAttemptPage.update;
        expect(write.mock.calls[0][0].select).toMatchObject({ id: true, order: true, checksum: true });
        expect(write.mock.calls[0][0].select).not.toHaveProperty('imageData');
    });

    it.each([
        [{ imageData: 'data:image/png;base64,bm90LWltYWdl' }, 'EXAM_PAGE_INVALID'],
        [{ width: 2 }, 'EXAM_PAGE_DIMENSIONS_MISMATCH'],
        [{ mimeType: 'image/jpeg', imageData: `data:image/jpeg;base64,${imageBytes(1).toString('base64')}` }, 'EXAM_PAGE_MIME_MISMATCH'],
    ])('拒绝真实解码失败及 MIME、尺寸造假 %#', async (overrides, message) => {
        const response = await upload([page(1, overrides)]);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ message });
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('复用原页图 schema 的 MIME 与像素校验且输出移除 role', () => {
        const input = { pages: [page(1)], expectedUpdatedAt: initialUpdatedAt.toISOString() };
        const parsed = upsertExamAttemptPagesSchema.parse(input);
        expect(parsed.pages[0]).not.toHaveProperty('role');
        expect(upsertExamAttemptPagesSchema.safeParse({ ...input, pages: [page(1, { mimeType: 'image/jpeg' })] }).success).toBe(false);
        expect(upsertExamAttemptPagesSchema.safeParse({ ...input, pages: [page(1, { width: 3000, height: 2000 })] }).success).toBe(false);
    });

    it.each(['questions', 'answer_key', null, 'unknown'])('任何显式 role 都返回 400 而非静默丢弃：%s', async (role) => {
        const response = await upload([page(1, { role })]);
        expect(response.status).toBe(400);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('拒绝单次重复 checksum 及与未替换页的 checksum 冲突', async () => {
        const duplicateInput = await upload([page(1), page(2, { imageData: page(1).imageData })]);
        expect(duplicateInput.status).toBe(409);
        const duplicateExisting = await upload([page(2, { imageData: page(1).imageData })]);
        expect(duplicateExisting.status).toBe(409);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it.each([
        { pages: [] },
        { pages: Array.from({ length: 21 }, (_, index) => page(index + 1)) },
        { pages: [page(1), page(1)] },
    ])('拒绝空页、超过 20 页或重复页序 %#', async ({ pages }) => {
        expect((await upload(pages)).status).toBe(400);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('累计页面数超过 20 时拒绝追加', async () => {
        mocks.examAttempt.findUnique.mockResolvedValue(attempt({ pages: Array.from({ length: 20 }, (_, index) => existingPage(index + 2)) }));
        expect((await upload([page(1)])).status).toBe(400);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('替换页只删除该页未复核答案，人工答案保留评分且清除旧区域与候选引用', async () => {
        mocks.tx.examAttemptAnswer.findMany.mockResolvedValue([
            { id: 'pending-1', reviewStatus: 'pending', regionJson: region(1) },
            { id: 'required-1', reviewStatus: 'required', regionJson: region(1) },
            { id: 'reviewed-1', reviewStatus: 'reviewed', regionJson: region(1), recognizedAnswer: '人工答案', result: 'wrong', awardedScore: 2, maxScore: 5, gradingSource: 'manual' },
            { id: 'manual-required-1', reviewStatus: 'required', regionJson: region(1), recognizedAnswer: '人工待复核', result: 'correct', awardedScore: 4, maxScore: 5, gradingSource: 'manual' },
            { id: 'pending-2', reviewStatus: 'pending', regionJson: region(2) },
            { id: 'reviewed-2', reviewStatus: 'reviewed', regionJson: region(2) },
            { id: 'no-region', reviewStatus: 'pending', regionJson: null },
            { id: 'invalid-region', reviewStatus: 'pending', regionJson: '{broken' },
        ]);
        expect((await upload([page(1, { imageData: page(9).imageData })])).status).toBe(200);
        expect(mocks.tx.examAttemptPage.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'page-1' }, data: expect.objectContaining({ recognitionResult: null, checksum: checksum(9) }),
        }));
        expect(mocks.tx.examAttemptAnswer.deleteMany).toHaveBeenCalledWith({
            where: { attemptId: 'attempt-1', id: { in: ['pending-1', 'required-1'] }, reviewStatus: { not: 'reviewed' } },
        });
        expect(mocks.tx.examAttemptAnswer.updateMany).toHaveBeenCalledWith({
            where: { attemptId: 'attempt-1', id: { in: ['reviewed-1', 'manual-required-1'] } }, data: { regionJson: null, confidence: null },
        });
    });

    it('相同图片幂等上传不清除识别结果和答案', async () => {
        expect((await upload([page(1)])).status).toBe(200);
        expect(mocks.tx.examAttemptAnswer.deleteMany).not.toHaveBeenCalled();
        expect(mocks.tx.examAttemptAnswer.updateMany).not.toHaveBeenCalled();
        const calls = mocks.tx.examAttemptPage.update.mock.calls;
        if (calls.length) expect(calls[0][0].data).not.toHaveProperty('recognitionResult');
    });

    it.each([
        [{ expectedUpdatedAt: '2026-11-07T00:00:00.000Z' }, 'review'],
        [{}, 'confirmed'],
    ])('过期版本与 confirmed 终态均返回 409 %#', async (overrides, status) => {
        mocks.examAttempt.findUnique.mockResolvedValue(attempt({ status }));
        expect((await upload([page(2)], overrides)).status).toBe(409);
        expect(mocks.tx.examAttemptPage.create).not.toHaveBeenCalled();
        expect(mocks.tx.examAttemptPage.update).not.toHaveBeenCalled();
    });

    it('事务内乐观锁失败时不写入页面和答案', async () => {
        mocks.tx.examAttempt.updateMany.mockResolvedValue({ count: 0 });
        expect((await upload([page(2)])).status).toBe(409);
        expect(mocks.tx.examAttemptPage.create).not.toHaveBeenCalled();
        expect(mocks.tx.examAttemptAnswer.deleteMany).not.toHaveBeenCalled();
    });

    it.each([{}, { expectedUpdatedAt: 'bad' }])('上传必须提供合法版本时间 %#', async (input) => {
        expect((await UPLOAD(json({ pages: [page(1)], ...input }), params())).status).toBe(400);
    });

    it.each([null, attempt({ userId: 'other-user', status: 'confirmed' })])('上传不泄露他人资源或状态 %#', async (data) => {
        mocks.examAttempt.findUnique.mockResolvedValue(data);
        expect((await upload([page(2)])).status).toBe(404);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('未登录时所有接口返回 401', async () => {
        mocks.user.findUnique.mockResolvedValue(null);
        const responses = await Promise.all([
            CREATE(json({ takenAt: initialUpdatedAt.toISOString() }), params('paper-1')),
            LIST(new Request('http://localhost'), params('paper-1')),
            DETAIL(new Request('http://localhost'), params()), upload([page(1)]),
        ]);
        expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    });
});
