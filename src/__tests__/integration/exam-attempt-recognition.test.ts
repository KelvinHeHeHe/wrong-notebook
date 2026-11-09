import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExamAttemptAnswer } from '@prisma/client';

const mocks = vi.hoisted(() => ({
    user: { findUnique: vi.fn() },
    find: vi.fn(), lock: vi.fn(), pageUpdate: vi.fn(),
    answerCreate: vi.fn(), answerUpdate: vi.fn(), answerDelete: vi.fn(),
    transaction: vi.fn(), extract: vi.fn(), grade: vi.fn(), quota: vi.fn(), service: vi.fn(),
    log: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ prisma: {
    user: mocks.user,
    examAttempt: { findUnique: mocks.find, updateMany: mocks.lock },
    $transaction: mocks.transaction,
} }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { email: 'user@example.com' } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/ai', () => ({ getAIService: mocks.service }));
vi.mock('@/lib/ai-quota', () => ({ consumeAiQuota: mocks.quota }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: mocks.log, warn: mocks.log, info: mocks.log }) }));

import { POST } from '@/app/api/exam-attempts/[id]/recognize/route';
import { recognizeExamAttemptPages } from '@/lib/exam/exam-attempt-recognition';
import { getStoredResponse } from '@/lib/recoverable-response';

const initial = new Date('2026-11-08T00:00:00Z');
const question = (order: number, overrides = {}) => ({
    id: `q${order}`, order, sourceShortId: `SHORT${order}`, questionText: `秘密题干${order}`,
    answerText: '标准答案全文', analysis: '解析', questionType: 'choice', score: 5, ...overrides,
});
const page = (order: number) => ({
    id: `p${order}`, order, checksum: `checksum${order}`, imageData: `data:image/png;base64,c2VjcmV0${order}`,
    mimeType: 'image/png', recognitionResult: null as string | null,
});
const candidate = (order: number, overrides = {}) => ({
    sourceShortId: `SHORT${order}`, displayNumber: order, recognizedAnswer: '学生答案全文',
    notAttempted: false, confidence: 0.95, regions: [{ x: 0, y: 0, width: 1, height: 0.5 }], ...overrides,
});
const answer = (overrides: Partial<ExamAttemptAnswer> = {}): ExamAttemptAnswer => ({
    id: 'a1', attemptId: 'a', examQuestionId: 'q1', recognizedAnswer: '旧答案', result: 'wrong',
    awardedScore: 2, maxScore: 5, gradingSource: 'manual', gradingReason: '人工说明', confidence: 1,
    reviewStatus: 'reviewed', regionJson: JSON.stringify({ pageOrder: 1, candidateId: 'old', regions: [] }),
    createdAt: initial, updatedAt: initial, ...overrides,
});
let state: ReturnType<typeof fixture>;
function fixture() {
    return { id: 'a', userId: 'u', status: 'uploaded', updatedAt: initial,
        pages: [page(1), page(2)], paper: { questions: [question(1), question(2), question(3)] },
        answers: [] as ExamAttemptAnswer[] };
}
const params = { params: Promise.resolve({ id: 'a' }) };
const request = (body: unknown, requestId?: string) => new Request('http://localhost/api/exam-attempts/a/recognize', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(requestId ? { 'x-request-id': requestId } : {}) },
    body: JSON.stringify(body),
});
const run = (overrides = {}) => POST(request({ pageOrders: [1, 2], language: 'zh', expectedUpdatedAt: state.updatedAt.toISOString(), ...overrides }), params);

describe('纸质作答按页识别与独立判分', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        state = fixture();
        mocks.user.findUnique.mockResolvedValue({ id: 'u', email: 'user@example.com' });
        mocks.find.mockImplementation(async () => structuredClone(state));
        mocks.lock.mockImplementation(async ({ where, data }) => {
            if (where.updatedAt?.getTime() !== state.updatedAt.getTime()
                || (typeof where.status === 'string' && where.status !== state.status)
                || (where.status?.not && where.status.not === state.status)) return { count: 0 };
            Object.assign(state, data);
            return { count: 1 };
        });
        mocks.pageUpdate.mockImplementation(async ({ where, data }) => {
            Object.assign(state.pages.find((item) => item.id === where.id)!, data);
        });
        mocks.answerCreate.mockImplementation(async ({ data }) => {
            const saved = answer({ ...data, id: `a${state.answers.length + 1}` });
            state.answers.push(saved);
            return saved;
        });
        mocks.answerUpdate.mockImplementation(async ({ where, data }) => {
            const target = state.answers.find((item) => item.id === where.id
                && (!where.reviewStatus?.not || item.reviewStatus !== where.reviewStatus.not));
            if (target) Object.assign(target, data);
            return { count: target ? 1 : 0 };
        });
        mocks.answerDelete.mockImplementation(async ({ where }) => {
            state.answers = state.answers.filter((item) => !where.id.in.includes(item.id) || item.reviewStatus === 'reviewed');
        });
        mocks.transaction.mockImplementation(async (callback) => callback({
            examAttempt: { findUnique: mocks.find, updateMany: mocks.lock },
            examAttemptPage: { update: mocks.pageUpdate },
            examAttemptAnswer: { create: mocks.answerCreate, updateMany: mocks.answerUpdate, deleteMany: mocks.answerDelete },
        }));
        mocks.quota.mockResolvedValue(null);
        mocks.service.mockResolvedValue({ extractExamPageAnswers: mocks.extract, gradeAnswer: mocks.grade });
        mocks.extract.mockResolvedValue({ candidates: [candidate(1)] });
        mocks.grade.mockResolvedValue({ correct: true, reason: '判分说明' });
    });

    it('一页成功一页失败仍保存页信封、逐题评分与未识别题占位，一次操作仅消费一次额度', async () => {
        mocks.extract.mockResolvedValueOnce({ candidates: [candidate(1)] }).mockRejectedValueOnce(new Error('AI_TIMEOUT_ERROR 学生答案全文'));
        const response = await run();
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ successes: [{ pageOrder: 1, candidateCount: 1, matchedCount: 1 }], failures: [{ pageOrder: 2, error: 'AI_TIMEOUT_ERROR' }], status: 'review', updatedAt: state.updatedAt.toISOString() });
        expect(JSON.parse(state.pages[0].recognitionResult!)).toMatchObject({ version: 1, status: 'succeeded', candidates: [{ recognizedAnswer: '学生答案全文' }] });
        expect(JSON.parse(state.pages[1].recognitionResult!)).toMatchObject({ status: 'failed', errorCode: 'AI_TIMEOUT_ERROR' });
        expect(state.answers).toEqual(expect.arrayContaining([
            expect.objectContaining({ examQuestionId: 'q1', result: 'correct', awardedScore: 5, reviewStatus: 'pending', gradingSource: 'ai' }),
            expect.objectContaining({ examQuestionId: 'q2', result: null, recognizedAnswer: null, reviewStatus: 'required' }),
            expect.objectContaining({ examQuestionId: 'q3', reviewStatus: 'required' }),
        ]));
        expect(mocks.grade).toHaveBeenCalledWith({ questionText: '秘密题干1', answerText: '标准答案全文', analysis: '解析', userAnswer: '学生答案全文', language: 'zh' });
        expect(mocks.quota).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'u' }), 'grade');
        expect(mocks.service).toHaveBeenCalledExactlyOnceWith({ userId: 'u', kind: 'grade' });
        expect(JSON.stringify(mocks.log.mock.calls)).not.toMatch(/c2VjcmV0|学生答案全文|秘密题干|标准答案全文/);
    });

    it('未作答、缺标准答案不判分，低置信度与主观题强制复核', async () => {
        state.paper.questions = [question(1), question(2, { answerText: null }), question(3), question(4, { questionType: 'solution' })];
        mocks.extract.mockResolvedValue({ candidates: [candidate(1, { notAttempted: true, recognizedAnswer: null }), candidate(2), candidate(3, { confidence: 0.79 }), candidate(4)] });
        await run({ pageOrders: [1] });
        expect(mocks.grade).toHaveBeenCalledTimes(2);
        expect(state.answers.map((item) => item.reviewStatus)).toEqual(['required', 'required', 'required', 'required']);
        expect(state.answers[0]).toMatchObject({ result: 'not_attempted', awardedScore: 0 });
        expect(state.answers[1]).toMatchObject({ result: null, awardedScore: null });
    });

    it('单题判分失败只令该题待复核，其余题照常保存', async () => {
        mocks.extract.mockResolvedValue({ candidates: [candidate(1), candidate(2)] });
        mocks.grade.mockRejectedValueOnce(new Error('AI_TIMEOUT_ERROR 学生答案全文')).mockResolvedValueOnce({ correct: false, reason: '错误' });
        await run({ pageOrders: [1] });
        expect(state.answers).toEqual(expect.arrayContaining([
            expect.objectContaining({ examQuestionId: 'q1', result: null, reviewStatus: 'required' }),
            expect.objectContaining({ examQuestionId: 'q2', result: 'wrong', awardedScore: 0 }),
        ]));
        expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('学生答案全文');
    });

    it('失败重试保留旧成功草稿并保持 review', async () => {
        state.status = 'review';
        state.answers = [answer({ reviewStatus: 'pending', gradingSource: 'ai' })];
        mocks.extract.mockRejectedValue(new Error('AI_TIMEOUT_ERROR'));
        await run({ pageOrders: [1] });
        expect(state.answers.find((item) => item.examQuestionId === 'q1')).toMatchObject({ recognizedAnswer: '旧答案', awardedScore: 2 });
        expect(state.status).toBe('review');
    });

    it.each([false, true])('人工已复核答案只有显式替换时被覆盖：%s', async (replaceReviewed) => {
        state.answers = [answer()];
        await run({ pageOrders: [1], replaceReviewed });
        expect(state.answers[0]).toMatchObject(replaceReviewed
            ? { recognizedAnswer: '学生答案全文', result: 'correct', awardedScore: 5, reviewStatus: 'pending' }
            : { recognizedAnswer: '旧答案', awardedScore: 2, reviewStatus: 'reviewed' });
    });

    it.each(['page', 'patch', 'confirm'])('提取期间并发修改拒绝迟到结果：%s', async (change) => {
        mocks.extract.mockImplementation(async () => {
            if (change === 'page') state.pages[0].checksum = 'new-checksum';
            if (change === 'patch') state.updatedAt = new Date(state.updatedAt.getTime() + 1);
            if (change === 'confirm') state.status = 'confirmed';
            return { candidates: [candidate(1)] };
        });
        const response = await run({ pageOrders: [1] });
        expect(await response.json()).toMatchObject({ successes: [], failures: [{ pageOrder: 1, error: change === 'page' ? 'EXAM_PAGE_CHANGED' : change === 'confirm' ? 'EXAM_ATTEMPT_ALREADY_CONFIRMED' : 'EXAM_ATTEMPT_CHANGED' }] });
        expect(state.pages[0].recognitionResult).toBeNull();
        expect(state.answers).toEqual([]);
        expect(mocks.grade).not.toHaveBeenCalled();
        if (change === 'confirm') expect(state.status).toBe('confirmed');
    });

    it('判分期间人工修改也拒绝写入迟到评分', async () => {
        mocks.grade.mockImplementation(async () => {
            state.updatedAt = new Date(state.updatedAt.getTime() + 1);
            state.answers = [answer()];
            return { correct: true, reason: '正确' };
        });
        const response = await run({ pageOrders: [1] });
        expect(await response.json()).toMatchObject({ successes: [], failures: [{ error: 'EXAM_ATTEMPT_CHANGED' }] });
        expect(state.answers).toHaveLength(1);
        expect(state.answers[0].recognizedAnswer).toBe('旧答案');
        expect(state.pages[0].recognitionResult).toBeNull();
    });

    it('全部提取失败为 failed，遗留 recognizing 可新请求重试', async () => {
        state.status = 'recognizing';
        mocks.extract.mockRejectedValue(new Error('AI_TIMEOUT_ERROR'));
        await run();
        expect(state.status).toBe('failed');
        expect(state.answers).toHaveLength(3);
        mocks.extract.mockResolvedValue({ candidates: [candidate(1)] });
        await run({ pageOrders: [1] });
        expect(state.status).toBe('review');
    });

    it('每页只发送最多 100 题的短 ID、连续题号和 160 字摘要', async () => {
        state.paper.questions = Array.from({ length: 105 }, (_, index) => question(index + 1, { questionText: '题'.repeat(200) }));
        await run({ pageOrders: [1] });
        const input = mocks.extract.mock.calls[0][0];
        expect(input.questions).toHaveLength(100);
        expect(input.questions[0]).toEqual({ id: 'q1', sourceShortId: 'SHORT1', displayNumber: 1, questionText: '题'.repeat(160) });
        expect(input.imageBase64).toBe('c2VjcmV01');
    });

    it('AI 前后的版本复检只读元数据，不反复加载图片或题干', async () => {
        await run({ pageOrders: [1] });
        const recheck = mocks.find.mock.calls[1][0];
        expect(recheck.where).toEqual({ id: 'a', userId: 'u' });
        expect(recheck.select.pages.select).toEqual({ id: true, checksum: true });
        expect(recheck.select.answers.select).not.toHaveProperty('recognizedAnswer');
        expect(recheck.select).not.toHaveProperty('paper');
    });

    it.each([{}, { pageOrders: [] }, { pageOrders: [1, 1] }, { pageOrders: [0] }, { pageOrders: [1], expectedUpdatedAt: 'bad' }])('拒绝非法识别请求 %#', async (body) => {
        expect((await POST(request(body), params)).status).toBe(400);
        expect(mocks.quota).not.toHaveBeenCalled();
    });

    it.each(['other', 'confirmed', 'stale'])('开始前拒绝越权、确认态及旧版本：%s', async (kind) => {
        if (kind === 'other') state.userId = 'other';
        if (kind === 'confirmed') state.status = 'confirmed';
        const response = await run(kind === 'stale' ? { expectedUpdatedAt: '2026-11-07T00:00:00Z' } : {});
        expect(response.status).toBe(kind === 'other' ? 404 : 409);
        expect(mocks.quota).not.toHaveBeenCalled();
        expect(mocks.extract).not.toHaveBeenCalled();
    });

    it('归属查询前置且拒绝响应沿用统一 API 错误格式', async () => {
        state.userId = 'other';
        const response = await run();
        expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
        expect(mocks.find.mock.calls[0][0].where).toEqual({ id: 'a', userId: 'u' });
    });

    it('未知页序在扣费前被拒绝', async () => {
        const response = await run({ pageOrders: [3] });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR', message: 'EXAM_PAGE_NOT_FOUND' });
        expect(mocks.quota).not.toHaveBeenCalled();
    });

    it('额度拒绝不调用 AI、不更改状态', async () => {
        mocks.quota.mockResolvedValue(new Response('{}', { status: 429 }));
        expect((await run()).status).toBe(429);
        expect(state.status).toBe('uploaded');
        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('开始时乐观锁失败不调用 AI', async () => {
        mocks.lock.mockResolvedValueOnce({ count: 0 });
        expect((await run()).status).toBe(409);
        expect(mocks.extract).not.toHaveBeenCalled();
    });

    it('页事务内乐观锁失败时不写入信封和答案', async () => {
        const lock = mocks.lock.getMockImplementation()!;
        let calls = 0;
        mocks.lock.mockImplementation(async (args) => ++calls === 2 ? { count: 0 } : lock(args));
        const response = await run({ pageOrders: [1] });
        expect(await response.json()).toMatchObject({ successes: [], failures: [{ pageOrder: 1, error: 'EXAM_ATTEMPT_CHANGED' }] });
        expect(state.pages[0].recognitionResult).toBeNull();
        expect(state.answers).toEqual([]);
    });

    it('新识别请求接管 recognizing 后拒绝旧调用，保留新调用的结果', async () => {
        mocks.extract.mockImplementationOnce(async () => {
            expect((await run({ pageOrders: [1] })).status).toBe(200);
            return { candidates: [candidate(1, { recognizedAnswer: '迟到旧答案' })] };
        });
        const response = await run({ pageOrders: [1] });
        expect(await response.json()).toMatchObject({ successes: [], failures: [{ pageOrder: 1, error: 'EXAM_ATTEMPT_CHANGED' }], status: 'review' });
        expect(state.answers.find((item) => item.examQuestionId === 'q1')?.recognizedAnswer).toBe('学生答案全文');
        expect(mocks.grade).toHaveBeenCalledTimes(1);
    });

    it('默认不为人工复核结果重复判分，替换时才再次判分', async () => {
        state.answers = [answer()];
        await run({ pageOrders: [1] });
        expect(mocks.grade).not.toHaveBeenCalled();
        await run({ pageOrders: [1], replaceReviewed: true });
        expect(mocks.grade).toHaveBeenCalledTimes(1);
    });

    it('成功重识别只清理目标页过期的非人工候选，其他页草稿保留', async () => {
        state.answers = [
            answer({ reviewStatus: 'pending', gradingSource: 'ai' }),
            answer({ id: 'a2', examQuestionId: 'q2', reviewStatus: 'required', gradingSource: 'ai', regionJson: JSON.stringify({ pageOrder: 2, candidateId: 'p2', regions: [] }) }),
        ];
        mocks.extract.mockResolvedValueOnce({ candidates: [] });
        await run({ pageOrders: [1] });
        expect(state.answers.find((item) => item.examQuestionId === 'q1')).toMatchObject({ recognizedAnswer: null, result: null, reviewStatus: 'required' });
        expect(state.answers.find((item) => item.examQuestionId === 'q2')).toMatchObject({ recognizedAnswer: '旧答案', awardedScore: 2 });
    });

    it('持久化异常的日志和 HTTP 响应不泄露图片、题干或答案', async () => {
        mocks.pageUpdate.mockRejectedValueOnce(new Error('c2VjcmV0 学生答案全文 秘密题干 标准答案全文'));
        const response = await run({ pageOrders: [1] });
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ message: 'EXAM_ATTEMPT_RECOGNITION_FAILED' });
        expect(JSON.stringify(mocks.log.mock.calls)).not.toMatch(/c2VjcmV0|学生答案全文|秘密题干|标准答案全文/);
    });

    it('耗时响应可恢复且编排函数对外可用', async () => {
        expect(recognizeExamAttemptPages).toBeTypeOf('function');
        const id = 'abcdefabcdefabcdefabcdefabcdefab';
        const response = await POST(request({ pageOrders: [1], expectedUpdatedAt: initial.toISOString() }, id), params);
        expect(response.status).toBe(200);
        expect(getStoredResponse(id)).toMatchObject({ state: 'done', status: 200, body: { status: 'review' } });
    });
});
