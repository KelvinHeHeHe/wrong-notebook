// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined, service: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('@/lib/ai', () => ({ getAIService: mocks.service }));
vi.mock('@/lib/config', () => ({ getAppConfig: () => ({ aiDailyLimit: 100 }), getAppTimeZone: () => 'Asia/Shanghai' }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.unmock('@/lib/ai-consent-store');

import { ExamAttemptRecognitionError, recognizeExamAttemptPages } from '@/lib/exam/exam-attempt-recognition';
import { confirmExamAttempt, ExamAttemptConfirmError } from '@/lib/exam/exam-attempt-confirm';

let database: PrismaClient;
let directory: string;

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'wrong-notebook-attempt-recognition-'));
    const url = `file:${join(directory, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe',
    });
    database = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = database;
}, 120000);

beforeEach(async () => {
    vi.clearAllMocks();
    await database.user.deleteMany();
    mocks.service.mockResolvedValue({ extractExamPageAnswers: vi.fn(async () => ({ candidates: [] })) });
});

afterAll(async () => {
    await database?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
});

async function fixture(consented = true) {
    const user = await database.user.create({ data: { email: 'recognition@example.com', password: 'test', aiDataConsentAt: consented ? new Date() : null } });
    const paper = await database.examPaper.create({ data: {
        userId: user.id, title: '识别事务回归', status: 'ready', scope: 'all', difficulty: 'medium', requestedCount: 1, subjectIds: '[]',
        questions: { create: { order: 0, sourceShortId: 'SOURCE', status: 'ready', questionText: '题干', answerText: '答案', score: 5 } },
    } });
    const attempt = await database.examAttempt.create({ data: {
        userId: user.id, paperId: paper.id, takenAt: new Date(), status: 'uploaded',
        pages: { create: { order: 1, checksum: 'checksum', imageData: 'data:image/png;base64,QUJD', mimeType: 'image/png' } },
    } });
    return { attemptId: attempt.id, user, pageOrders: [1], language: 'zh' as const, expectedUpdatedAt: attempt.updatedAt.toISOString() };
}

describe('纸质作答识别所有权与真实 SQLite 额度', () => {
    it('跨页同题竞争在真实数据库中强制复核，阻止确认和历史入账', async () => {
        const input = await fixture();
        await database.examAttemptPage.create({ data: { attemptId: input.attemptId, order: 2, checksum: 'second', imageData: 'data:image/png;base64,REVG', mimeType: 'image/png' } });
        mocks.service.mockResolvedValue({
            extractExamPageAnswers: vi.fn(async ({ imageBase64 }: { imageBase64: string }) => ({ candidates: [{
                sourceShortId: 'SOURCE', displayNumber: 1, recognizedAnswer: imageBase64 === 'QUJD' ? 'A' : 'B',
                notAttempted: false, confidence: 0.99, regions: [],
            }] })),
            gradeAnswer: vi.fn(async () => ({ correct: true, reason: '判分完成' })),
        });
        const result = await recognizeExamAttemptPages({ ...input, pageOrders: [1, 2] });
        expect(await database.examAttemptAnswer.findFirst({ where: { attemptId: input.attemptId } })).toMatchObject({ recognizedAnswer: 'A', reviewStatus: 'required', result: 'correct', awardedScore: 5 });
        try {
            await confirmExamAttempt({ ...input, expectedUpdatedAt: result.updatedAt });
            expect.fail('跨页竞争尚未复核，不应允许确认');
        } catch (error) {
            expect(error).toBeInstanceOf(ExamAttemptConfirmError);
            if (!(error instanceof ExamAttemptConfirmError)) throw error;
            expect(await error.response.json()).toMatchObject({ message: 'EXAM_ATTEMPT_REVIEW_REQUIRED' });
        }
        expect(await database.practiceRecord.count()).toBe(0);
        expect(await database.examAttempt.findUnique({ where: { id: input.attemptId } })).toMatchObject({ status: 'review' });
    });
    it('两个相同版本请求竞争真实 CAS，仅新增一条 grade usage', async () => {
        const input = await fixture();
        const results = await Promise.allSettled([recognizeExamAttemptPages(input), recognizeExamAttemptPages(input)]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(ExamAttemptRecognitionError);
        if (rejected?.status === 'rejected') expect((rejected.reason as ExamAttemptRecognitionError).response.status).toBe(409);
        expect(await database.aiUsage.count({ where: { userId: input.user.id, kind: 'grade' } })).toBe(1);
        expect(mocks.service).toHaveBeenCalledTimes(1);
        expect(await database.examAttempt.findUnique({ where: { id: input.attemptId } })).toMatchObject({ status: 'review' });
    });

    it('真实账户拒绝后不生成 usage，释放识别状态并可用返回版本重试', async () => {
        const input = await fixture(false);
        let response: Response | undefined;
        try {
            await recognizeExamAttemptPages(input);
        } catch (error) {
            if (!(error instanceof ExamAttemptRecognitionError)) throw error;
            response = error.response;
        }
        expect(response?.status).toBe(403);
        const body = await response!.json() as { status: string; updatedAt: string };
        expect(body.status).toBe('uploaded');
        expect(body.updatedAt).not.toBe(input.expectedUpdatedAt);
        expect(await database.aiUsage.count({ where: { userId: input.user.id } })).toBe(0);
        const user = await database.user.update({ where: { id: input.user.id }, data: { aiDataConsentAt: new Date() } });
        await expect(recognizeExamAttemptPages({ ...input, user, expectedUpdatedAt: body.updatedAt })).resolves.toMatchObject({ status: 'review' });
        expect(await database.aiUsage.count({ where: { userId: input.user.id, kind: 'grade' } })).toBe(1);
    });
});
