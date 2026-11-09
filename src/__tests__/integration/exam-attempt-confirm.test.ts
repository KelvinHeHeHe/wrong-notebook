// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PrismaClient, Prisma, User } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
import { confirmExamAttempt, ExamAttemptConfirmError } from '@/lib/exam/exam-attempt-confirm';

let database: PrismaClient;
let directory: string;
let user: User;
let image: string;
const takenAt = new Date('2026-11-08T08:00:00Z');
const region = JSON.stringify({ pageOrder: 1, candidateId: null, regions: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.5 }] });

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'wrong-notebook-attempt-confirm-'));
    const url = `file:${join(directory, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
    const { PrismaClient } = await import('@prisma/client');
    database = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = database;
    image = `data:image/png;base64,${(await sharp({ create: { width: 100, height: 80, channels: 3, background: '#abcdef' } }).png().toBuffer()).toString('base64')}`;
}, 120000);
beforeEach(async () => {
    await database.user.deleteMany();
    user = await database.user.create({ data: { id: 'u1', email: 'confirm@example.com', password: 'test-only' } });
    await database.subject.create({ data: { id: 'math', userId: user.id, name: '数学' } });
});
afterAll(async () => { await database?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true }); });

async function fixture(answer: Partial<Prisma.ExamAttemptAnswerUncheckedCreateInput> = {}) {
    const paper = await database.examPaper.create({ data: { userId: user.id, title: '回传', status: 'ready', scope: 'all', difficulty: 'medium', mode: 'original', origin: 'imported', requestedCount: 1, subjectIds: '["math"]', subjectId: 'math', gradeSemester: '初一上', questions: { create: { id: 'q1', order: 1, sourceShortId: 'Q00001', status: 'ready', questionText: '求解方程：三倍未知数减六等于九', answerText: 'x=5', analysis: '移项计算', score: 5 } } } });
    const attempt = await database.examAttempt.create({ data: { userId: user.id, paperId: paper.id, status: 'review', takenAt, totalScore: 999, maxScore: 999, pages: { create: { order: 1, imageData: image, mimeType: 'image/png', checksum: 'page-1' } }, answers: { create: { examQuestionId: 'q1', result: 'wrong', recognizedAnswer: 'x=4', awardedScore: 2.5, maxScore: 5, reviewStatus: 'reviewed', gradingSource: 'manual', regionJson: region, ...answer } } } });
    return { attempt, paper, input: { attemptId: attempt.id, user, expectedUpdatedAt: attempt.updatedAt.toISOString() } };
}

async function expectUntouched(attemptId: string) {
    expect(await database.practiceRecord.count()).toBe(0);
    expect(await database.errorItem.count()).toBe(0);
    expect((await database.examAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status).toBe('review');
    expect((await database.examQuestion.findUniqueOrThrow({ where: { id: 'q1' } })).errorItemId).toBeNull();
}

describe('纸质作答确认事务', () => {
    it.each([
        { reviewStatus: 'required' }, { result: null }, { result: '' }, { awardedScore: null },
        { awardedScore: -1 }, { awardedScore: 6 }, { awardedScore: 2.55 }, { maxScore: null }, { maxScore: 0 }, { maxScore: 1001 }, { maxScore: 2.55 }, { reviewStatus: 'invalid' },
    ])('拒绝不完整或非法答案：%j', async (answer) => {
        const { attempt, input } = await fixture(answer);
        await expect(confirmExamAttempt(input)).rejects.toThrow();
        await expectUntouched(attempt.id);
    });
    it('缺少任一道 ready 题答案时拒绝；失败题不参与确认', async () => {
        const { attempt, input, paper } = await fixture();
        await database.examQuestion.create({ data: { paperId: paper.id, order: 2, sourceShortId: 'Q00002', status: 'ready', questionText: '尚未识别的可打印题目' } });
        await expect(confirmExamAttempt(input)).rejects.toThrow();
        await expectUntouched(attempt.id);
    });
    it.each([false, true].flatMap((groupByType) => [null, '', ' \n\t '].map((questionText) => ({ groupByType, questionText }))))('确认只要求可打印题，忽略空题干 ready 与非 ready：%j', async ({ groupByType, questionText }) => {
        const { input, paper } = await fixture({ result: 'correct', awardedScore: 5 });
        await database.examPaper.update({ where: { id: paper.id }, data: { groupByType } });
        const skipped = await database.examQuestion.create({ data: { paperId: paper.id, order: 2, sourceShortId: 'EMPTY', status: 'ready', questionText, score: 900 } });
        await database.examQuestion.createMany({ data: ['failed', 'pending'].map((status, index) => ({ paperId: paper.id, order: index + 3, sourceShortId: status, status, questionText: '非 ready 题目', score: 900 })) });
        // 旧草稿即使保留异常题答案，也不能影响本次打印题集的成绩与历史。
        await database.examAttemptAnswer.create({ data: { attemptId: input.attemptId, examQuestionId: skipped.id, result: 'wrong', awardedScore: 300, maxScore: 900, reviewStatus: 'required' } });
        const result = await confirmExamAttempt(input);
        expect(result.summary).toMatchObject({ status: 'confirmed', totalScore: 5, maxScore: 5 });
        expect((await database.practiceRecord.findMany()).map((record) => record.examQuestionId)).toEqual(['q1']);
        expect(await database.errorItem.count()).toBe(0);
    });
    it.each([null, '', ' \n\t '])('无任何可打印题时明确拒绝确认：%j', async (questionText) => {
        const { attempt, input } = await fixture();
        await database.examQuestion.update({ where: { id: 'q1' }, data: { questionText } });
        try {
            await confirmExamAttempt(input);
            expect.fail('无可打印题不应允许确认');
        } catch (error) {
            expect(error).toBeInstanceOf(ExamAttemptConfirmError);
            if (!(error instanceof ExamAttemptConfirmError)) throw error;
            expect(error.response.status).toBe(400);
            expect(await error.response.json()).toMatchObject({ message: 'EXAM_ATTEMPT_NO_READY_QUESTIONS' });
        }
        await expectUntouched(attempt.id);
    });
    it('正确外部题只写空错题关联的 exam 快照，并从数据库重算成绩', async () => {
        const { input, paper } = await fixture({ result: 'correct', awardedScore: 5, reviewStatus: 'pending' });
        await database.examQuestion.create({ data: { paperId: paper.id, order: 2, sourceShortId: 'FAILED', status: 'failed' } });
        const result = await confirmExamAttempt(input);
        expect(result.summary).toMatchObject({ status: 'confirmed', totalScore: 5, maxScore: 5, takenAt });
        expect(result.affectedErrorItemIds).toEqual([]);
        expect(await database.errorItem.count()).toBe(0);
        expect(await database.practiceRecord.findFirstOrThrow()).toMatchObject({ errorItemId: null, examAttemptId: input.attemptId, examQuestionId: 'q1', source: 'exam', result: 'correct', isCorrect: true, createdAt: takenAt, questionText: '求解方程：三倍未知数减六等于九', answerText: 'x=5', difficulty: null });
    });
    it('错误外部题创建错题、裁图、回写关联，人工部分分计入汇总', async () => {
        const { input } = await fixture();
        const result = await confirmExamAttempt(input);
        const item = await database.errorItem.findFirstOrThrow();
        expect(result.affectedErrorItemIds).toEqual([item.id]);
        expect(result.summary).toMatchObject({ totalScore: 2.5, maxScore: 5 });
        expect(item).toMatchObject({ subjectId: 'math', gradeSemester: '初一上', wrongAnswerText: 'x=4', mistakeStatus: 'wrong_attempt' });
        expect(await sharp(Buffer.from(item.originalImageUrl.split(',')[1], 'base64')).metadata()).toMatchObject({ width: 50, height: 40 });
        expect((await database.examQuestion.findUniqueOrThrow({ where: { id: 'q1' } })).errorItemId).toBe(item.id);
        expect(await database.practiceRecord.findFirstOrThrow()).toMatchObject({ source: 'exam', errorItemId: item.id, wrongAnswerText: 'x=4', originalImageUrl: item.originalImageUrl });
        expect(await database.practiceRecord.count()).toBe(1);
    });
    it('未作答外部题新建错题时保留未作答状态', async () => {
        const { input } = await fixture({ result: 'not_attempted', awardedScore: 0, recognizedAnswer: '' });
        await confirmExamAttempt(input);
        expect(await database.errorItem.findFirstOrThrow()).toMatchObject({ mistakeStatus: 'not_attempted', wrongAnswerText: null });
    });
    it('最终未作答即使有识别文字，新错题仍为未作答并保留练习快照', async () => {
        const { input } = await fixture({ result: 'not_attempted', awardedScore: 0, recognizedAnswer: '不会做' });
        await confirmExamAttempt(input);
        const item = await database.errorItem.findFirstOrThrow();
        expect(item.mistakeStatus).toBe('not_attempted');
        expect(await database.practiceRecord.findFirstOrThrow()).toMatchObject({ errorItemId: item.id, result: 'not_attempted', wrongAnswerText: '不会做' });
    });
    it('未作答按题干判重复用，保留原错题内容且不写 duplicate_import', async () => {
        const { input } = await fixture({ result: 'not_attempted', awardedScore: 0, recognizedAnswer: '不会做' });
        const item = await database.errorItem.create({ data: { userId: user.id, originalImageUrl: '原图', questionText: '求解方程：三倍未知数减六等于九', answerText: '原答案', mistakeStatus: 'wrong_attempt' } });
        const result = await confirmExamAttempt(input);
        expect(result.affectedErrorItemIds).toEqual([item.id]);
        expect(await database.errorItem.count()).toBe(1);
        expect(await database.errorItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ originalImageUrl: '原图', answerText: '原答案', mistakeStatus: 'wrong_attempt' });
        expect(await database.practiceRecord.findFirstOrThrow()).toMatchObject({ source: 'exam', result: 'not_attempted', errorItemId: item.id });
        expect(await database.practiceRecord.count()).toBe(1);
    });
    it('已关联错题直接复用；重复/并发确认不增加历史，重复返回空调度集合', async () => {
        const { input } = await fixture({ result: 'correct', awardedScore: 5 });
        const item = await database.errorItem.create({ data: { userId: user.id, originalImageUrl: '', questionText: '不同题干' } });
        await database.examQuestion.update({ where: { id: 'q1' }, data: { errorItemId: item.id } });
        const results = await Promise.all([confirmExamAttempt(input), confirmExamAttempt(input)]);
        expect(results[0].summary).toEqual(results[1].summary);
        expect(results.map((result) => result.affectedErrorItemIds)).toEqual([[item.id], []]);
        expect(await database.practiceRecord.count()).toBe(1);
        expect(await database.errorItem.count()).toBe(1);
        expect((await confirmExamAttempt(input)).affectedErrorItemIds).toEqual([]);
    });
    it('记录写入失败时回滚新错题、题目关联和确认状态', async () => {
        const { attempt, input } = await fixture();
        await database.$executeRawUnsafe("CREATE TRIGGER reject_confirm_record BEFORE INSERT ON PracticeRecord BEGIN SELECT RAISE(ABORT, '模拟写入失败'); END");
        try { await expect(confirmExamAttempt(input)).rejects.toThrow(); } finally { await database.$executeRawUnsafe('DROP TRIGGER reject_confirm_record'); }
        await expectUntouched(attempt.id);
    });
    it('确认状态写入失败时，已创建的练习记录也全部回滚', async () => {
        const { attempt, input } = await fixture();
        await database.$executeRawUnsafe("CREATE TRIGGER reject_confirm_status BEFORE UPDATE ON ExamAttempt WHEN NEW.status = 'confirmed' BEGIN SELECT RAISE(ABORT, '模拟确认失败'); END");
        try { await expect(confirmExamAttempt(input)).rejects.toThrow(); } finally { await database.$executeRawUnsafe('DROP TRIGGER reject_confirm_status'); }
        await expectUntouched(attempt.id);
        expect((await database.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).updatedAt).toEqual(attempt.updatedAt);
    });
    it('同卷多题按数据库答案汇总，重复错题 ID 仅返回一次', async () => {
        const { input, paper } = await fixture();
        await database.examQuestion.create({ data: { id: 'q2', paperId: paper.id, order: 2, sourceShortId: 'Q00002', status: 'ready', questionText: '求解方程：三倍未知数减六等于九', score: 4 } });
        await database.examAttemptAnswer.create({ data: { attemptId: input.attemptId, examQuestionId: 'q2', result: 'not_attempted', awardedScore: 0, maxScore: 4, reviewStatus: 'reviewed' } });
        const result = await confirmExamAttempt(input);
        expect(result.summary).toMatchObject({ totalScore: 2.5, maxScore: 9 });
        const item = await database.errorItem.findFirstOrThrow();
        expect(result.affectedErrorItemIds).toEqual([item.id]);
        expect(await database.errorItem.count()).toBe(1);
        expect(await database.practiceRecord.count()).toBe(2);
        expect(await database.practiceRecord.count({ where: { source: 'duplicate_import' } })).toBe(0);
    });
    it('区域引用不存在的页时不在其他页套用坐标，回退整页', async () => {
        const { input } = await fixture({ regionJson: region.replace('"pageOrder":1', '"pageOrder":99') });
        await confirmExamAttempt(input);
        expect((await database.errorItem.findFirstOrThrow()).originalImageUrl).toBe(image);
    });
    it('没有区域或区域越界时保存整页图', async () => {
        const { input } = await fixture({ regionJson: region.replace('"width":0.5', '"width":2') });
        await confirmExamAttempt(input);
        expect((await database.errorItem.findFirstOrThrow()).originalImageUrl).toBe(image);
    });
    it('拒绝过期版本、他人作答、非法状态及非 ready 试卷', async () => {
        const { input, paper } = await fixture();
        await expect(confirmExamAttempt({ ...input, expectedUpdatedAt: '2020-01-01T00:00:00Z' })).rejects.toThrow();
        await expect(confirmExamAttempt({ ...input, user: { ...user, id: 'other' } })).rejects.toThrow();
        await database.examAttempt.update({ where: { id: input.attemptId }, data: { status: 'recognizing' } });
        await expect(confirmExamAttempt(input)).rejects.toThrow();
        await database.examAttempt.update({ where: { id: input.attemptId }, data: { status: 'review', updatedAt: new Date(input.expectedUpdatedAt) } });
        await database.examPaper.update({ where: { id: paper.id }, data: { status: 'partial' } });
        await expect(confirmExamAttempt(input)).rejects.toThrow();
    });
});
