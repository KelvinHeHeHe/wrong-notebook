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
import { buildExamPrintLayout } from '@/lib/exam/exam-sections';
import { normalizeQuestionType } from '@/lib/question/question-type';
import { getStoredResponse } from '@/lib/recoverable-response';

const initial = new Date('2026-11-08T00:00:00Z');
const question = (order: number, overrides = {}) => ({
    id: `q${order}`, order, sourceShortId: `SHORT${order}`, questionText: `秘密题干${order}`,
    answerText: '标准答案全文', analysis: '解析', questionType: 'single_choice', score: 5,
    status: 'ready', errorItem: null as { questionType: string | null } | null, ...overrides,
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
        pages: [page(1), page(2)], paper: { groupByType: false, questions: [question(1), question(2), question(3)] },
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
            const targets = state.answers.filter((item) => (!where.id || item.id === where.id)
                && (!where.examQuestionId?.in || where.examQuestionId.in.includes(item.examQuestionId))
                && (!where.reviewStatus?.not || item.reviewStatus !== where.reviewStatus.not));
            for (const target of targets) Object.assign(target, data);
            return { count: targets.length };
        });
        mocks.answerDelete.mockImplementation(async ({ where }) => {
            state.answers = state.answers.filter((item) => !where.id.in.includes(item.id) || item.reviewStatus === 'reviewed');
        });
        mocks.transaction.mockImplementation(async (callback) => {
            const before = structuredClone(state);
            try {
                return await callback({
                    examAttempt: { findUnique: mocks.find, updateMany: mocks.lock },
                    examAttemptPage: { update: mocks.pageUpdate },
                    examAttemptAnswer: { create: mocks.answerCreate, updateMany: mocks.answerUpdate, deleteMany: mocks.answerDelete },
                });
            } catch (error) {
                state = before;
                throw error;
            }
        });
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

    it.each([
        ['AI_IMAGE_NOT_SUPPORTED', 'AI_IMAGE_NOT_SUPPORTED'],
        ['AI_OUTPUT_TRUNCATED', 'AI_OUTPUT_TRUNCATED'],
        ['network unavailable', 'AI_CONNECTION_FAILED'],
        ['request timeout', 'AI_TIMEOUT_ERROR'],
        ['403 forbidden', 'AI_PERMISSION_DENIED'],
        ['unrecognized provider failure', 'AI_UNKNOWN_ERROR'],
    ])('提取错误 %s 在信封与 API 中稳定归类且日志脱敏', async (message, expected) => {
        mocks.extract.mockRejectedValueOnce(new Error(message + ' 学生答案全文 秘密题干 c2VjcmV01'));
        const response = await run({ pageOrders: [1] });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ successes: [], failures: [{ pageOrder: 1, error: expected }], status: 'failed' });
        expect(JSON.parse(state.pages[0].recognitionResult!)).toMatchObject({ status: 'failed', errorCode: expected });
        const logs = JSON.stringify(mocks.log.mock.calls, (_key, value: unknown) => value instanceof Error ? { message: value.message, stack: value.stack, cause: value.cause } : value);
        expect(logs).not.toMatch(/学生答案全文|秘密题干|c2VjcmV01/);
        expect(JSON.stringify(body)).not.toMatch(/学生答案全文|秘密题干|c2VjcmV01/);
    });

    it.each([false, true])('按实际打印布局匹配题号，包含过滤、零基 order 和题型回退：group=%s', async (groupByType) => {
        state.paper.groupByType = groupByType;
        state.paper.questions = [
            question(1, { order: 0, questionType: 'solution' }),
            question(2, { order: 3, status: 'failed' }),
            question(3, { order: 7, questionType: null, errorItem: { questionType: 'single_choice' } }),
            question(4, { order: 9, questionText: null }),
        ];
        mocks.extract.mockResolvedValueOnce({ candidates: [candidate(1, { sourceShortId: null })] });
        await run({ pageOrders: [1] });
        expect(mocks.extract.mock.calls[0][0].questions.map((item: { id: string; displayNumber: number }) => [item.id, item.displayNumber])).toEqual(groupByType ? [['q3', 1], ['q1', 2]] : [['q1', 1], ['q3', 2]]);
        expect(state.answers.find((item) => item.recognizedAnswer === '学生答案全文')?.examQuestionId).toBe(groupByType ? 'q3' : 'q1');
        expect(state.answers.map((item) => item.examQuestionId).sort()).toEqual(['q1', 'q3']);
    });

    it('打印题型快照缺失时，复核判定同样使用关联错题的主观题型', async () => {
        state.paper.questions = [question(1, { questionType: null, errorItem: { questionType: 'solution' } })];
        await run({ pageOrders: [1] });
        expect(state.answers[0].reviewStatus).toBe('required');
    });

    it.each(['snapshot', 'linked'])('题型别名在共享打印布局之前归一化，识别序号与实际打印一致：%s', async (source) => {
        state.paper.groupByType = true;
        state.paper.questions = [question(1, { questionType: 'solution' }), question(2, source === 'snapshot'
            ? { questionType: '选择题' } : { questionType: null, errorItem: { questionType: '选择题' } })];
        const printed = buildExamPrintLayout(state.paper.questions.map((item) => ({
            ...item, questionType: normalizeQuestionType(item.questionType), errorItemQuestionType: normalizeQuestionType(item.errorItem?.questionType),
        })), true, 'zh');
        expect(printed.items.map(({ question, displayNumber }) => [question.id, displayNumber])).toEqual([['q2', 1], ['q1', 2]]);
        mocks.extract.mockResolvedValueOnce({ candidates: [candidate(1, { sourceShortId: null })] });
        await run({ pageOrders: [1] });
        expect(mocks.extract.mock.calls[0][0].questions.map((item: { id: string; displayNumber: number }) => [item.id, item.displayNumber])).toEqual([['q2', 1], ['q1', 2]]);
        expect(state.answers.find((item) => item.recognizedAnswer === '学生答案全文')?.examQuestionId).toBe('q2');
    });

    it.each(['snapshot', 'linked'])('主观题别名归一化后必须人工复核：%s', async (source) => {
        state.paper.questions = [question(1, source === 'snapshot' ? { questionType: '解答题' }
            : { questionType: null, errorItem: { questionType: '解答题' } })];
        await run({ pageOrders: [1] });
        expect(state.answers[0].reviewStatus).toBe('required');
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

    it.each([
        { orders: [1, 2], replaceReviewed: false }, { orders: [2, 1], replaceReviewed: false },
        { orders: [1, 2], replaceReviewed: true }, { orders: [2, 1], replaceReviewed: true },
    ])('同次请求跨页重复候选只由首个合法页认领：%j', async ({ orders, replaceReviewed }) => {
        mocks.extract.mockImplementation(async ({ imageBase64 }: { imageBase64: string }) => ({
            candidates: [candidate(1, { recognizedAnswer: imageBase64.endsWith('1') ? '第一页作答' : '第二页作答' })],
        }));
        const response = await run({ pageOrders: orders, replaceReviewed });
        expect(await response.json()).toMatchObject({ successes: [
            { pageOrder: orders[0], matchedCount: 1 }, { pageOrder: orders[1], matchedCount: 0 },
        ] });
        const saved = state.answers.find((item) => item.examQuestionId === 'q1')!;
        expect(saved.recognizedAnswer).toBe(orders[0] === 1 ? '第一页作答' : '第二页作答');
        expect(saved).toMatchObject({ reviewStatus: 'required', result: 'correct', awardedScore: 5 });
        expect(JSON.parse(saved.regionJson!).pageOrder).toBe(orders[0]);
        expect(JSON.parse(state.pages.find((item) => item.order === orders[1])!.recognitionResult!).candidates).toHaveLength(1);
        expect(mocks.grade).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])('其他页已认领的人工答案即使 replaceReviewed=%s 也不覆盖', async (replaceReviewed) => {
        state.answers = [answer({ regionJson: JSON.stringify({ pageOrder: 2, candidateId: 'p2', regions: [] }) })];
        await run({ pageOrders: [1], replaceReviewed });
        expect(state.answers[0]).toMatchObject({ recognizedAnswer: '旧答案', reviewStatus: 'required', awardedScore: 2, gradingSource: 'manual' });
        expect(mocks.grade).not.toHaveBeenCalled();
        expect(JSON.parse(state.pages[0].recognitionResult!).candidates).toHaveLength(1);
    });

    it.each([[1, 2], [2, 1]])('另一页 B/C 均指向 Q1 时仍构成竞争：页序 %j', async (first, second) => {
        mocks.extract.mockImplementation(async ({ imageBase64 }: { imageBase64: string }) => ({ candidates: imageBase64.endsWith('1')
            ? [candidate(1, { recognizedAnswer: 'A' })]
            : [candidate(1, { recognizedAnswer: 'B' }), candidate(1, { recognizedAnswer: 'C' })],
        }));
        const response = await run({ pageOrders: [first, second] });
        expect(response.status).toBe(200);
        expect(state.answers.find((item) => item.examQuestionId === 'q1')).toMatchObject({ recognizedAnswer: 'A', reviewStatus: 'required', awardedScore: 5 });
        expect(mocks.grade).toHaveBeenCalledTimes(1);
        expect(JSON.parse(state.pages[1].recognitionResult!).candidates).toHaveLength(2);
    });

    it.each([false, true])('同页 B/C 冲突无其他页时也必须 required，人工旧结果=%s', async (manual) => {
        if (manual) state.answers = [answer()];
        mocks.extract.mockResolvedValueOnce({ candidates: [candidate(1, { recognizedAnswer: 'B' }), candidate(1, { recognizedAnswer: 'C' })] });
        await run({ pageOrders: [1] });
        expect(state.answers.find((item) => item.examQuestionId === 'q1')).toMatchObject(manual
            ? { reviewStatus: 'required', recognizedAnswer: '旧答案', awardedScore: 2 }
            : { reviewStatus: 'required', recognizedAnswer: null, awardedScore: null });
        expect(mocks.grade).not.toHaveBeenCalled();
    });

    it('模糊无目标、未知短码及跨标识冲突候选不错误降级他页人工结果', async () => {
        state.answers = [answer()];
        mocks.extract.mockResolvedValueOnce({ candidates: [
            candidate(1, { sourceShortId: null, displayNumber: null }),
            candidate(1, { sourceShortId: 'UNKNOWN' }), candidate(1, { displayNumber: 2 }),
        ] });
        await run({ pageOrders: [2] });
        expect(state.answers[0]).toMatchObject({ reviewStatus: 'reviewed', recognizedAnswer: '旧答案', awardedScore: 2 });
        expect(mocks.grade).not.toHaveBeenCalled();
    });

    it('跨请求单页重试发现竞争后强制复核，重复识别归属页也不能绕过有效竞争', async () => {
        await run({ pageOrders: [1] });
        expect(state.answers.find((item) => item.examQuestionId === 'q1')?.reviewStatus).toBe('pending');
        const response = await run({ pageOrders: [2] });
        expect(await response.json()).toMatchObject({ successes: [{ pageOrder: 2, matchedCount: 0 }], failures: [], status: 'review', updatedAt: state.updatedAt.toISOString() });
        expect(state.answers.find((item) => item.examQuestionId === 'q1')?.reviewStatus).toBe('required');
        await run({ pageOrders: [1] });
        expect(state.answers.find((item) => item.examQuestionId === 'q1')?.reviewStatus).toBe('required');
    });

    it('人工结果被新竞争降为 required 后，默认重识别保留人工答案和评分', async () => {
        state.answers = [answer()];
        await run({ pageOrders: [2] });
        expect(state.answers[0]).toMatchObject({ reviewStatus: 'required', recognizedAnswer: '旧答案', result: 'wrong', awardedScore: 2 });
        await run({ pageOrders: [1] });
        expect(state.answers[0]).toMatchObject({ reviewStatus: 'required', recognizedAnswer: '旧答案', result: 'wrong', awardedScore: 2, gradingSource: 'manual' });
        expect(mocks.grade).not.toHaveBeenCalled();
    });

    it.each(['failed', 'empty', 'removed'])('竞争页 %s 后不再用旧候选反复误报；AI 归属页可成功重识别', async (kind) => {
        await run();
        expect(state.answers.find((item) => item.examQuestionId === 'q1')?.reviewStatus).toBe('required');
        if (kind === 'removed') state.pages = state.pages.filter((item) => item.order !== 2);
        else {
            if (kind === 'failed') mocks.extract.mockRejectedValueOnce(new Error('AI_TIMEOUT_ERROR'));
            else mocks.extract.mockResolvedValueOnce({ candidates: [] });
            await run({ pageOrders: [2] });
            expect(state.answers.find((item) => item.examQuestionId === 'q1')?.reviewStatus).toBe('required');
            if (kind === 'failed') expect(JSON.parse(state.pages[1].recognitionResult!).candidates).toHaveLength(1);
        }
        await run({ pageOrders: [1] });
        expect(state.answers.find((item) => item.examQuestionId === 'q1')).toMatchObject({ reviewStatus: 'pending', result: 'correct', awardedScore: 5 });
    });

    it('失败信封仅保留材料，人工重新复核后不会被旧竞争永久降级', async () => {
        await run();
        expect(state.answers.find((item) => item.examQuestionId === 'q1')?.reviewStatus).toBe('required');
        mocks.extract.mockRejectedValueOnce(new Error('AI_TIMEOUT_ERROR'));
        await run({ pageOrders: [2] });
        const reviewed = state.answers.find((item) => item.examQuestionId === 'q1')!;
        Object.assign(reviewed, { reviewStatus: 'reviewed', gradingSource: 'manual', recognizedAnswer: '人工最终答案', awardedScore: 3 });
        await run({ pageOrders: [1] });
        expect(state.answers.find((item) => item.examQuestionId === 'q1')).toMatchObject({ reviewStatus: 'reviewed', gradingSource: 'manual', recognizedAnswer: '人工最终答案', awardedScore: 3 });
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

    it('相同版本的并发请求只有 CAS 所有者扣费一次', async () => {
        const responses = await Promise.all([run({ pageOrders: [1] }), run({ pageOrders: [1] })]);
        expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
        expect(mocks.quota).toHaveBeenCalledTimes(1);
        expect(mocks.service).toHaveBeenCalledTimes(1);
    });

    it.each(['review', 'recognizing'])('额度拒绝安全释放识别所有权并返回可重试的新版本：原状态 %s', async (status) => {
        state.status = status;
        mocks.quota.mockResolvedValueOnce(Response.json({ message: '额度不足', code: 'AI_QUOTA_INSUFFICIENT' }, { status: 429 }));
        const response = await run({ pageOrders: [1] });
        expect(response.status).toBe(429);
        const body = await response.json();
        expect(body).toMatchObject({ code: 'AI_QUOTA_INSUFFICIENT', status: status === 'recognizing' ? 'uploaded' : 'review', updatedAt: state.updatedAt.toISOString() });
        expect(state.status).not.toBe('recognizing');
        expect(state.updatedAt.getTime()).toBeGreaterThan(initial.getTime());
        expect((await run({ pageOrders: [1], expectedUpdatedAt: body.updatedAt })).status).toBe(200);
    });

    it('额度拒绝恢复时不能撤销并发确认', async () => {
        mocks.quota.mockImplementationOnce(async () => {
            state.status = 'confirmed';
            state.updatedAt = new Date(state.updatedAt.getTime() + 1);
            return Response.json({ code: 'AI_QUOTA_INSUFFICIENT' }, { status: 429 });
        });
        expect((await run({ pageOrders: [1] })).status).toBe(429);
        expect(state.status).toBe('confirmed');
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
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ failures: [{ pageOrder: 1, error: 'EXAM_PAGE_SAVE_FAILED' }] });
        expect(JSON.stringify(mocks.log.mock.calls)).not.toMatch(/c2VjcmV0|学生答案全文|秘密题干|标准答案全文/);
    });

    it.each(['page', 'answer'])('第一页 %s 写入失败转页失败并继续保存第二页，事务不留下半成品', async (write) => {
        mocks.extract.mockResolvedValueOnce({ candidates: [candidate(1)] }).mockResolvedValueOnce({ candidates: [candidate(2)] });
        if (write === 'page') mocks.pageUpdate.mockRejectedValueOnce(new Error('数据库写入失败'));
        else mocks.answerCreate.mockRejectedValueOnce(new Error('答案写入失败'));
        const response = await run();
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ failures: [{ pageOrder: 1, error: 'EXAM_PAGE_SAVE_FAILED' }], successes: [{ pageOrder: 2, matchedCount: 1 }], status: 'review' });
        expect(JSON.parse(state.pages[0].recognitionResult!)).toMatchObject({ status: 'failed', errorCode: 'EXAM_PAGE_SAVE_FAILED' });
        expect(JSON.parse(state.pages[1].recognitionResult!)).toMatchObject({ status: 'succeeded' });
        expect(state.answers.find((item) => item.examQuestionId === 'q1')).toMatchObject({ recognizedAnswer: null, result: null, awardedScore: null, reviewStatus: 'required' });
        expect(state.answers.find((item) => item.examQuestionId === 'q2')).toMatchObject({ result: 'correct', awardedScore: 5 });
    });

    it('所有页图写入持续失败时仍结束为 failed，不遗留 recognizing', async () => {
        mocks.pageUpdate.mockRejectedValue(new Error('数据库写入失败'));
        const response = await run();
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: 'failed', successes: [], failures: [
            { pageOrder: 1, error: 'EXAM_PAGE_SAVE_FAILED' }, { pageOrder: 2, error: 'EXAM_PAGE_SAVE_FAILED' },
        ] });
        expect(state.status).toBe('failed');
    });

    it('答案写入和占位持续失败时仍释放 recognizing 并保留可复核页材料', async () => {
        mocks.answerCreate.mockRejectedValue(new Error('答案表持续写入失败'));
        const response = await run({ pageOrders: [1] });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ message: 'EXAM_ATTEMPT_FINALIZE_FAILED', code: 'DATABASE_ERROR',
            details: { phase: 'finalize', retryable: true }, status: 'review', failures: [{ pageOrder: 1, error: 'EXAM_PAGE_SAVE_FAILED' }] });
        expect(JSON.parse(state.pages[0].recognitionResult!).candidates).toHaveLength(1);
        expect(state.status).toBe('review');
        expect(state.answers).toHaveLength(0);
    });

    it('仅 required 占位持续失败时返回批次收尾错误和最新可重试版本，不误报成功页失败', async () => {
        const create = mocks.answerCreate.getMockImplementation()!;
        let placeholderCalls = 0;
        mocks.answerCreate.mockImplementation(async (args) => {
            if (args.data.regionJson === null) {
                placeholderCalls += 1;
                throw new Error('required 占位写入失败 学生答案全文');
            }
            return create(args);
        });
        const response = await run({ pageOrders: [1] });
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body).toMatchObject({ message: 'EXAM_ATTEMPT_FINALIZE_FAILED', code: 'DATABASE_ERROR',
            details: { phase: 'finalize', retryable: true },
            successes: [{ pageOrder: 1, candidateCount: 1, matchedCount: 1 }], failures: [],
            status: 'review', updatedAt: state.updatedAt.toISOString(),
        });
        expect(placeholderCalls).toBe(2);
        expect(state.status).not.toBe('recognizing');
        expect(state.updatedAt.getTime()).toBeGreaterThan(initial.getTime());
        expect(JSON.parse(state.pages[0].recognitionResult!).status).toBe('succeeded');
        expect(state.answers).toHaveLength(1);
        expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('学生答案全文');
        mocks.answerCreate.mockImplementation(create);
        expect((await run({ pageOrders: [1], expectedUpdatedAt: body.updatedAt })).status).toBe(200);
        expect(state.answers.filter((item) => item.reviewStatus === 'required')).toHaveLength(2);
    });

    it('仅 required 占位短暂失败时在同版本保护下重试收尾，完成后才返回成功', async () => {
        const create = mocks.answerCreate.getMockImplementation()!;
        let failed = false;
        mocks.answerCreate.mockImplementation(async (args) => {
            if (args.data.regionJson === null && !failed) {
                failed = true;
                throw new Error('占位短暂写入失败');
            }
            return create(args);
        });
        const response = await run({ pageOrders: [1] });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: 'review', failures: [] });
        expect(state.answers.filter((item) => item.reviewStatus === 'required')).toHaveLength(2);
    });

    it.each([false, true])('过滤退化区域后保留合法来源引用，全部过滤=%s', async (allInvalid) => {
        const valid = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
        mocks.extract.mockResolvedValueOnce({ candidates: [candidate(1, { regions: [
            { x: 1, y: 0, width: 0, height: 0.5 }, { x: 0, y: 1, width: 0.5, height: 0 },
            ...(!allInvalid ? [valid] : []),
        ] })] });
        await run({ pageOrders: [1] });
        const saved = state.answers.find((item) => item.examQuestionId === 'q1')!;
        expect(JSON.parse(saved.regionJson!)).toEqual({ pageOrder: 1, candidateId: expect.any(String), regions: allInvalid ? [] : [valid] });
        expect(JSON.parse(state.pages[0].recognitionResult!).candidates[0].regions).toEqual(allInvalid ? [] : [valid]);
    });

    it('重试能从旧坏区域中恢复页归属，清除旧 pending 和评分', async () => {
        state.answers = [answer({ reviewStatus: 'pending', gradingSource: 'ai', regionJson: JSON.stringify({
            pageOrder: 1, candidateId: 'old', regions: [{ x: 1, y: 0, width: 0, height: 0.5 }],
        }) })];
        mocks.extract.mockResolvedValueOnce({ candidates: [] });
        await run({ pageOrders: [1] });
        expect(state.answers.find((item) => item.examQuestionId === 'q1')).toMatchObject({ result: null, awardedScore: null, recognizedAnswer: null, reviewStatus: 'required', regionJson: null });
    });

    it('旧坏区域仍可保护其他页认领的答案，不允许显式替换越页', async () => {
        state.answers = [answer({ reviewStatus: 'pending', regionJson: JSON.stringify({
            pageOrder: 2, candidateId: 'old', regions: [{ x: 1, y: 0, width: 0, height: 0.5 }],
        }) })];
        await run({ pageOrders: [1], replaceReviewed: true });
        expect(state.answers[0]).toMatchObject({ recognizedAnswer: '旧答案', awardedScore: 2 });
        expect(mocks.grade).not.toHaveBeenCalled();
    });

    it('同 checksum 的失败重试保留未匹配候选，重复失败后仍有材料可复核', async () => {
        const unmatched = { ...candidate(1, { sourceShortId: 'UNKNOWN', displayNumber: null }), candidateId: 'unmatched-v1' };
        state.pages[0].recognitionResult = JSON.stringify({ version: 1, status: 'succeeded', candidates: [unmatched], errorCode: null, completedAt: initial.toISOString() });
        mocks.extract.mockRejectedValue(new Error('AI_TIMEOUT_ERROR'));
        for (let index = 0; index < 2; index += 1) {
            const response = await run({ pageOrders: [1] });
            expect(await response.json()).toMatchObject({ status: 'review', failures: [{ pageOrder: 1, error: 'AI_TIMEOUT_ERROR' }] });
            expect(JSON.parse(state.pages[0].recognitionResult!)).toMatchObject({ status: 'failed', errorCode: 'AI_TIMEOUT_ERROR', candidates: [unmatched] });
        }
    });

    it('失败重试保留旧候选 ID 与答案，同时过滤旧信封的退化区域', async () => {
        state.pages[0].recognitionResult = JSON.stringify({ version: 1, status: 'succeeded', candidates: [{
            ...candidate(1, { regions: [{ x: 1, y: 0, width: 0, height: 0.5 }] }), candidateId: 'legacy-candidate',
        }], errorCode: null, completedAt: initial.toISOString() });
        mocks.extract.mockRejectedValueOnce(new Error('AI_TIMEOUT_ERROR'));
        await run({ pageOrders: [1] });
        expect(JSON.parse(state.pages[0].recognitionResult!).candidates[0]).toMatchObject({ candidateId: 'legacy-candidate', recognizedAnswer: '学生答案全文', regions: [] });
    });

    it.each(['empty', 'different'])('首次页事务失败后的信封同时保留旧未匹配候选和来源草稿：本轮 %s', async (kind) => {
        const oldCandidate = { ...candidate(1, { sourceShortId: 'UNKNOWN-A', displayNumber: null }), candidateId: 'candidate-A' };
        state.pages[0].recognitionResult = JSON.stringify({ version: 1, status: 'succeeded', candidates: [oldCandidate], errorCode: null, completedAt: initial.toISOString() });
        const sourceDraft = answer({ reviewStatus: 'required', recognizedAnswer: null, result: null, awardedScore: null,
            regionJson: JSON.stringify({ pageOrder: 1, candidateId: 'candidate-A', regions: [] }),
        });
        state.answers = [sourceDraft];
        mocks.extract.mockResolvedValueOnce({ candidates: kind === 'empty' ? [] : [candidate(2)] });
        mocks.pageUpdate.mockRejectedValueOnce(new Error('首次页事务写入失败'));
        const response = await run({ pageOrders: [1] });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ failures: [{ pageOrder: 1, error: 'EXAM_PAGE_SAVE_FAILED' }], status: 'review' });
        const envelope = JSON.parse(state.pages[0].recognitionResult!);
        expect(envelope).toMatchObject({ status: 'failed', candidates: expect.arrayContaining([oldCandidate]) });
        expect(envelope.candidates).toHaveLength(kind === 'empty' ? 1 : 2);
        if (kind === 'different') expect(envelope.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ sourceShortId: 'SHORT2' })]));
        expect(state.answers.find((item) => item.id === sourceDraft.id)).toEqual(sourceDraft);
    });

    it('失败信封按稳定 candidateId 合并去重，重复提取同候选只保留一份', async () => {
        mocks.extract.mockResolvedValue({ candidates: [candidate(1, { sourceShortId: 'UNKNOWN-A', displayNumber: null })] });
        await run({ pageOrders: [1] });
        const originalCandidates = JSON.parse(state.pages[0].recognitionResult!).candidates;
        expect(originalCandidates).toHaveLength(1);
        mocks.pageUpdate.mockRejectedValueOnce(new Error('首次页事务写入失败'));
        await run({ pageOrders: [1] });
        expect(JSON.parse(state.pages[0].recognitionResult!)).toMatchObject({ status: 'failed', candidates: originalCandidates });
    });

    it.each([false, true])('来源草稿即使答案和判定都为空仍可复核：旧坏区域=%s', async (badRegion) => {
        state.answers = [answer({ recognizedAnswer: null, result: null, awardedScore: null, gradingSource: null,
            reviewStatus: 'required', regionJson: JSON.stringify({ pageOrder: 1, candidateId: 'source',
                regions: badRegion ? [{ x: 1, y: 0, width: 0, height: 0.5 }] : [],
            }),
        })];
        mocks.extract.mockRejectedValueOnce(new Error('AI_TIMEOUT_ERROR'));
        const response = await run({ pageOrders: [1] });
        expect(await response.json()).toMatchObject({ status: 'review' });
        expect(state.answers[0]).toMatchObject({ recognizedAnswer: null, result: null, reviewStatus: 'required' });
    });

    it('没有来源、答案和判定的空占位不算可复核识别结果', async () => {
        state.answers = [answer({ recognizedAnswer: null, result: null, awardedScore: null, gradingSource: null, reviewStatus: 'required', regionJson: null })];
        mocks.extract.mockRejectedValueOnce(new Error('AI_TIMEOUT_ERROR'));
        expect(await (await run({ pageOrders: [1] })).json()).toMatchObject({ status: 'failed' });
    });

    it('耗时响应可恢复且编排函数对外可用', async () => {
        expect(recognizeExamAttemptPages).toBeTypeOf('function');
        const id = 'abcdefabcdefabcdefabcdefabcdefab';
        const response = await POST(request({ pageOrders: [1], expectedUpdatedAt: initial.toISOString() }, id), params);
        expect(response.status).toBe(200);
        expect(getStoredResponse(id)).toMatchObject({ state: 'done', status: 200, body: { status: 'review' } });
    });
});
