// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import type { User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined, service: vi.fn(), grade: vi.fn(), schedule: vi.fn(), log: vi.fn(), session: { user: { email: 'review@example.com' }, expires: '2099-01-01' } }));
vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/ai', () => ({ getAIService: mocks.service }));
vi.mock('@/lib/mastery', () => ({ scheduleMasteryEvaluation: mocks.schedule }));
vi.mock('@/lib/config', () => ({ getAppConfig: () => ({ aiDailyLimit: 100 }), getAppTimeZone: () => 'Asia/Shanghai' }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.log, error: mocks.log }) }));
vi.unmock('@/lib/ai-consent-store');

import { PATCH } from '@/app/api/exam-attempts/[id]/answers/[answerId]/route';
import { POST as CONFIRM } from '@/app/api/exam-attempts/[id]/confirm/route';
import { recognizeExamAttemptPages } from '@/lib/exam/exam-attempt-recognition';
import { getStoredResponse } from '@/lib/recoverable-response';

let database: PrismaClient;
let directory: string;
let user: User;
const initial = new Date('2026-11-08T08:00:00Z');
const regions = [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }];
const candidate = { candidateId: 'saved-candidate', sourceShortId: null, displayNumber: null, recognizedAnswer: '持久化答案', notAttempted: false, confidence: 0.73, regions };

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'wrong-notebook-attempt-review-'));
    const url = `file:${join(directory, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
    database = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = database;
}, 120000);
beforeEach(async () => {
    vi.clearAllMocks();
    await database.user.deleteMany();
    user = await database.user.create({ data: { email: 'review@example.com', password: 'test', aiDataConsentAt: new Date() } });
    mocks.service.mockResolvedValue({ gradeAnswer: mocks.grade });
    mocks.grade.mockResolvedValue({ correct: true, reason: '判分理由' });
    mocks.schedule.mockImplementation(() => undefined);
});
afterAll(async () => { await database?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true }); });

async function fixture() {
    const paper = await database.examPaper.create({ data: { userId: user.id, title: '复核', status: 'ready', scope: 'all', difficulty: 'medium', requestedCount: 1, subjectIds: '[]', questions: { create: { id: 'q1', sourceShortId: 'Q00001', order: 1, status: 'ready', questionText: '秘密题干', answerText: '标准答案', analysis: '解析', score: 5 } } } });
    const attempt = await database.examAttempt.create({ data: { userId: user.id, paperId: paper.id, status: 'review', takenAt: initial, updatedAt: initial,
        pages: { create: { order: 1, checksum: 'checksum', imageData: 'data:image/png;base64,QUJD', mimeType: 'image/png', recognitionResult: JSON.stringify({ version: 1, status: 'failed', candidates: [candidate], errorCode: 'RETRY_FAILED', completedAt: initial.toISOString() }) } },
        answers: { create: { id: 'answer1', examQuestionId: 'q1', recognizedAnswer: '旧答案', result: 'wrong', awardedScore: 0, maxScore: 5, reviewStatus: 'required' } },
    } });
    return attempt;
}
function request(body: unknown, method = 'PATCH', requestId?: string) {
    return new Request('http://localhost/api/exam-attempts/review', { method, headers: { 'Content-Type': 'application/json', ...(requestId ? { 'X-Request-Id': requestId } : {}) }, body: JSON.stringify(body) });
}
function patch(id: string, body: Record<string, unknown> = {}, answerId = 'answer1', requestId?: string) {
    return PATCH(request({ expectedUpdatedAt: initial.toISOString(), ...body }, 'PATCH', requestId), { params: Promise.resolve({ id, answerId }) });
}
function confirm(id: string, body: Record<string, unknown> = {}) {
    return CONFIRM(request({ expectedUpdatedAt: initial.toISOString(), ...body }, 'POST'), { params: Promise.resolve({ id }) });
}
const savedAnswer = () => database.examAttemptAnswer.findUniqueOrThrow({ where: { id: 'answer1' } });

describe('纸质作答人工复核 API', () => {
    it('保存人工部分分与备注，推进版本且不改变学习历史', async () => {
        const attempt = await fixture();
        const response = await patch(attempt.id, { recognizedAnswer: '修正答案', result: 'wrong', awardedScore: 2.5, maxScore: 5, gradingReason: '人工备注' });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.updatedAt).not.toBe(initial.toISOString());
        expect(body.updatedAt).toBe((await database.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).updatedAt.toISOString());
        expect(await savedAnswer()).toMatchObject({ recognizedAnswer: '修正答案', result: 'wrong', awardedScore: 2.5, maxScore: 5, gradingReason: '人工备注', gradingSource: 'manual', reviewStatus: 'reviewed' });
        expect(await database.practiceRecord.count()).toBe(0);
        expect(await database.errorItem.count()).toBe(0);
        expect(await database.aiUsage.count()).toBe(0);
    });
    it.each(['attempt-owner', 'paper-owner', 'answer-attempt', 'answer-paper', 'confirmed', 'stale'])('拒绝越权、不属于本卷的答案、确认态或过期版本：%s', async (kind) => {
        const attempt = await fixture();
        const other = await database.user.create({ data: { email: 'other@example.com', password: 'test' } });
        if (kind === 'attempt-owner') await database.examAttempt.update({ where: { id: attempt.id }, data: { userId: other.id } });
        if (kind === 'paper-owner') await database.examPaper.update({ where: { id: attempt.paperId }, data: { userId: other.id } });
        if (kind === 'answer-attempt') {
            const second = await database.examAttempt.create({ data: { userId: user.id, paperId: attempt.paperId, takenAt: initial } });
            await database.examAttemptAnswer.update({ where: { id: 'answer1' }, data: { attemptId: second.id } });
        }
        if (kind === 'answer-paper') {
            const second = await database.examPaper.create({ data: { userId: user.id, title: '他卷', scope: 'all', difficulty: 'medium', requestedCount: 1, subjectIds: '[]' } });
            await database.examQuestion.update({ where: { id: 'q1' }, data: { paperId: second.id } });
        }
        if (kind === 'confirmed') await database.examAttempt.update({ where: { id: attempt.id }, data: { status: 'confirmed' } });
        const response = await patch(attempt.id, { recognizedAnswer: '不能写入', ...(kind === 'stale' ? { expectedUpdatedAt: '2020-01-01T00:00:00Z' } : {}) });
        expect(response.status).toBe(['confirmed', 'stale'].includes(kind) ? 409 : 404);
        expect((await savedAnswer()).recognizedAnswer).toBe('旧答案');
        expect(await database.aiUsage.count()).toBe(0);
    });
    it.each([{ awardedScore: -1 }, { awardedScore: 5.1 }, { awardedScore: 1.25 }, { maxScore: 0 }, { maxScore: 1001 }, { maxScore: 2.55 }, { maxScore: null, awardedScore: 2 }, { result: 'invalid' }, { expectedUpdatedAt: 'bad' }, { expectedUpdatedAt: undefined }, { confidence: 1 }, { regionJson: '{}' }, { candidateRef: { pageOrder: 1, candidateId: 'saved-candidate', recognizedAnswer: '伪造' } }])('拒绝非法分数、字段或版本：%j', async (body) => {
        const attempt = await fixture();
        expect((await patch(attempt.id, body)).status).toBe(400);
        expect((await savedAnswer()).reviewStatus).toBe('required');
        expect((await database.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).updatedAt).toEqual(initial);
    });
    it('仅修改满分时仍校验合并后的原得分', async () => {
        const attempt = await fixture();
        await database.examAttemptAnswer.update({ where: { id: 'answer1' }, data: { awardedScore: 4 } });
        expect((await patch(attempt.id, { maxScore: 3 })).status).toBe(400);
        expect((await savedAnswer()).maxScore).toBe(5);
    });
    it('人工保存也拒绝数据库中已有的非法满分', async () => {
        const attempt = await fixture();
        await database.examAttemptAnswer.update({ where: { id: 'answer1' }, data: { maxScore: 2.55 } });
        expect((await patch(attempt.id, { recognizedAnswer: '修正答案' })).status).toBe(400);
        expect((await savedAnswer()).reviewStatus).toBe('required');
    });
    it('候选映射只复制持久化信封中的答案、来源区域和置信度', async () => {
        const attempt = await fixture();
        expect((await patch(attempt.id, { candidateRef: { pageOrder: 1, candidateId: 'saved-candidate' }, recognizedAnswer: '客户端伪造答案' })).status).toBe(200);
        expect(await savedAnswer()).toMatchObject({ recognizedAnswer: '持久化答案', confidence: 0.73, gradingSource: 'manual', reviewStatus: 'reviewed', regionJson: JSON.stringify({ pageOrder: 1, candidateId: 'saved-candidate', regions }) });
    });
    it.each([{ pageOrder: 2, candidateId: 'saved-candidate' }, { pageOrder: 1, candidateId: 'forged' }])('拒绝非本作答页中的候选：%j', async (candidateRef) => {
        const attempt = await fixture();
        expect((await patch(attempt.id, { candidateRef })).status).toBe(400);
        expect((await savedAnswer()).regionJson).toBeNull();
    });
    it('同一候选不能映射给另一道题', async () => {
        const attempt = await fixture();
        await database.examQuestion.create({ data: { id: 'q2', sourceShortId: 'Q00002', paperId: attempt.paperId, order: 2 } });
        await database.examAttemptAnswer.create({ data: { attemptId: attempt.id, examQuestionId: 'q2', regionJson: JSON.stringify({ pageOrder: 1, candidateId: 'saved-candidate', regions }) } });
        expect((await patch(attempt.id, { candidateRef: { pageOrder: 1, candidateId: 'saved-candidate' } })).status).toBe(409);
        expect((await savedAnswer()).regionJson).toBeNull();
    });
    it('相同版本并发手工保存仅一个成功', async () => {
        const attempt = await fixture();
        const results = await Promise.all([patch(attempt.id, { recognizedAnswer: '甲' }), patch(attempt.id, { recognizedAnswer: '乙' })]);
        expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    });
    it.each([
        { status: 'recognizing', changes: { recognizedAnswer: '人工答案' } },
        { status: 'recognizing', changes: { candidateRef: { pageOrder: 1, candidateId: 'saved-candidate' } } },
        { status: 'recognizing', changes: { regrade: true } },
        { status: 'uploaded', changes: { recognizedAnswer: '人工答案' } },
        { status: 'failed', changes: { recognizedAnswer: '人工答案' } },
    ])('人工接管后原子转 review：%j', async ({ status, changes }) => {
        const attempt = await fixture();
        await database.examAttempt.update({ where: { id: attempt.id }, data: { status, updatedAt: initial } });
        expect((await patch(attempt.id, changes)).status).toBe(200);
        expect((await database.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe('review');
    });
    it('人工接管正在识别的作答后，Task 5 迟到评分不得覆盖或遗留 recognizing', async () => {
        const attempt = await fixture();
        mocks.service.mockResolvedValueOnce({ gradeAnswer: mocks.grade, extractExamPageAnswers: async () => ({ candidates: [{ ...candidate, displayNumber: 1 }] }) });
        mocks.grade.mockImplementationOnce(async () => {
            const current = await database.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
            expect((await patch(attempt.id, { expectedUpdatedAt: current.updatedAt.toISOString(), recognizedAnswer: '人工接管答案', result: 'wrong', awardedScore: 2 })).status).toBe(200);
            return { correct: true, reason: '迟到识别评分' };
        });
        const response = await recognizeExamAttemptPages({ attemptId: attempt.id, user, pageOrders: [1], language: 'zh', expectedUpdatedAt: initial.toISOString() });
        expect(response).toMatchObject({ status: 'review', successes: [], failures: [{ pageOrder: 1, error: 'EXAM_ATTEMPT_CHANGED' }] });
        expect(await savedAnswer()).toMatchObject({ recognizedAnswer: '人工接管答案', awardedScore: 2, gradingSource: 'manual', reviewStatus: 'reviewed' });
    });
    it('重判只计一次真实 grade 额度并保持 required，使用修正答案及持久题干', async () => {
        const attempt = await fixture();
        const response = await patch(attempt.id, { recognizedAnswer: '修正答案', regrade: true });
        expect(response.status).toBe(200);
        expect(await savedAnswer()).toMatchObject({ recognizedAnswer: '修正答案', result: 'correct', awardedScore: 5, maxScore: 5, gradingSource: 'ai', gradingReason: '判分理由', reviewStatus: 'required' });
        expect(await database.aiUsage.count({ where: { userId: user.id, kind: 'grade' } })).toBe(1);
        expect(mocks.service).toHaveBeenCalledExactlyOnceWith({ userId: user.id, kind: 'grade' });
        expect(mocks.grade).toHaveBeenCalledExactlyOnceWith({ questionText: '秘密题干', answerText: '标准答案', analysis: '解析', userAnswer: '修正答案', language: 'zh' });
        expect((await response.json()).updatedAt).toBe((await database.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).updatedAt.toISOString());
    });
    it('相同版本并发重判只有 CAS 所有者消费一次额度', async () => {
        const attempt = await fixture();
        const responses = await Promise.all([patch(attempt.id, { regrade: true }), patch(attempt.id, { regrade: true })]);
        expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
        expect(await database.aiUsage.count()).toBe(1);
        expect(mocks.grade).toHaveBeenCalledTimes(1);
    });
    it('重判降低满分时清除旧得分，AI 建议分使用新满分', async () => {
        const attempt = await fixture();
        await database.examAttemptAnswer.update({ where: { id: 'answer1' }, data: { awardedScore: 5 } });
        expect((await patch(attempt.id, { maxScore: 3, regrade: true })).status).toBe(200);
        expect(await savedAnswer()).toMatchObject({ maxScore: 3, awardedScore: 3, reviewStatus: 'required' });
    });
    it.each(['manual', 'confirmed', 'upload'])('重判等待后的二次 CAS 拒绝覆盖并发操作：%s', async (kind) => {
        const attempt = await fixture();
        mocks.grade.mockImplementationOnce(async () => {
            const current = await database.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
            if (kind === 'manual') expect((await patch(attempt.id, { expectedUpdatedAt: current.updatedAt.toISOString(), recognizedAnswer: '较新人工答案', awardedScore: 3 })).status).toBe(200);
            else await database.examAttempt.update({ where: { id: attempt.id }, data: { status: kind === 'confirmed' ? 'confirmed' : 'uploaded', updatedAt: new Date(current.updatedAt.getTime() + 1) } });
            return { correct: true, reason: '迟到判分' };
        });
        const response = await patch(attempt.id, { regrade: true });
        expect(response.status).toBe(409);
        expect((await savedAnswer()).gradingReason).not.toBe('迟到判分');
        if (kind === 'manual') expect(await savedAnswer()).toMatchObject({ recognizedAnswer: '较新人工答案', awardedScore: 3, reviewStatus: 'reviewed' });
    });
    it('额度拒绝不调用 AI，保留修正草稿与最新可重试版本', async () => {
        const attempt = await fixture();
        await database.user.update({ where: { id: user.id }, data: { aiDataConsentAt: null } });
        const response = await patch(attempt.id, { recognizedAnswer: '修正答案', regrade: true });
        expect(response.status).toBe(403);
        expect(await savedAnswer()).toMatchObject({ recognizedAnswer: '修正答案', reviewStatus: 'required', result: null, awardedScore: null });
        expect((await response.json()).updatedAt).toBe((await database.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).updatedAt.toISOString());
        expect(mocks.service).not.toHaveBeenCalled();
        expect(await database.aiUsage.count()).toBe(0);
    });
    it('AI 失败保留 required 草稿，响应可恢复且日志脱敏', async () => {
        const attempt = await fixture();
        mocks.grade.mockRejectedValueOnce(new Error('秘密题干 标准答案 修正答案 QUJD'));
        const requestId = 'abcdabcdabcdabcdabcdabcdabcdabcd';
        const response = await patch(attempt.id, { recognizedAnswer: '修正答案', regrade: true }, 'answer1', requestId);
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.updatedAt).toBe((await database.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).updatedAt.toISOString());
        expect(await savedAnswer()).toMatchObject({ recognizedAnswer: '修正答案', result: null, awardedScore: null, reviewStatus: 'required' });
        expect(JSON.stringify(mocks.log.mock.calls)).not.toMatch(/秘密题干|标准答案|修正答案|QUJD/);
        expect(getStoredResponse(requestId)).toMatchObject({ state: 'done', status: 500, body });
    });
    it('确认领域错误沿用响应且不调度 mastery', async () => {
        const attempt = await fixture();
        const response = await confirm(attempt.id);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ message: 'EXAM_ATTEMPT_REVIEW_REQUIRED', code: 'VALIDATION_ERROR' });
        expect(mocks.schedule).not.toHaveBeenCalled();
        expect(await database.practiceRecord.count()).toBe(0);
    });
    it('确认提交后才调度实际错题，重复确认返回相同摘要且不重复调度', async () => {
        const attempt = await fixture();
        const item = await database.errorItem.create({ data: { userId: user.id, originalImageUrl: '', questionText: '原错题' } });
        await database.examQuestion.update({ where: { id: 'q1' }, data: { errorItemId: item.id } });
        await database.examAttemptAnswer.update({ where: { id: 'answer1' }, data: { reviewStatus: 'reviewed' } });
        let scheduledState: Promise<unknown> | undefined;
        mocks.schedule.mockImplementation((ids: string[]) => { scheduledState = Promise.all([database.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } }), database.practiceRecord.count()]); expect(ids).toEqual([item.id]); });
        const responses = await Promise.all([confirm(attempt.id), confirm(attempt.id)]);
        expect(responses.map((response) => response.status)).toEqual([200, 200]);
        const [first, repeated] = await Promise.all(responses.map((response) => response.json()));
        expect(first).toEqual(repeated);
        expect(first).toMatchObject({ status: 'confirmed', totalScore: 0, maxScore: 5, updatedAt: expect.any(String) });
        expect(await scheduledState).toEqual([expect.objectContaining({ status: 'confirmed' }), 1]);
        expect(mocks.schedule).toHaveBeenCalledTimes(1);
        expect(await database.practiceRecord.count()).toBe(1);
        expect((await patch(attempt.id, { recognizedAnswer: '不允许', expectedUpdatedAt: first.updatedAt })).status).toBe(409);
    });
    it('确认事务失败时不调度 mastery 并回滚历史', async () => {
        const attempt = await fixture();
        await database.examAttemptAnswer.update({ where: { id: 'answer1' }, data: { reviewStatus: 'reviewed', result: 'correct', awardedScore: 5 } });
        await database.$executeRawUnsafe("CREATE TRIGGER reject_review_confirm BEFORE UPDATE ON ExamAttempt WHEN NEW.status = 'confirmed' BEGIN SELECT RAISE(ABORT, '模拟失败'); END");
        try { expect((await confirm(attempt.id)).status).toBe(500); } finally { await database.$executeRawUnsafe('DROP TRIGGER reject_review_confirm'); }
        expect(mocks.schedule).not.toHaveBeenCalled();
        expect(await database.practiceRecord.count()).toBe(0);
    });
    it('正确外部题确认没有受影响错题时不调度，confirm 拒绝额外字段', async () => {
        const attempt = await fixture();
        expect((await confirm(attempt.id, { totalScore: 100 })).status).toBe(400);
        await database.examAttemptAnswer.update({ where: { id: 'answer1' }, data: { reviewStatus: 'reviewed', result: 'correct', awardedScore: 5 } });
        expect((await confirm(attempt.id)).status).toBe(200);
        expect(mocks.schedule).not.toHaveBeenCalled();
    });
});
