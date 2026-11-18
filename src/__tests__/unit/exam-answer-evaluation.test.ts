// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ExamPageAnswerCandidate } from '@/lib/ai/exam-answer-extraction';

import { HANDWRITING_QUALITIES, PHOTO_QUALITIES, QUESTION_TYPE_KEYS, SUBJECTS } from '../../../scripts/exam-evaluation/manifest.mjs';

const execute = promisify(execFile);
const dummyKey = 'e2e-dummy-key';
let directory: string;
let origin: string;
let candidates: ExamPageAnswerCandidate[];
let upstreamFails = false;
let requestCount = 0;
const server = createServer(async (request, response) => {
    requestCount++;
    for await (const chunk of request) void chunk;
    response.setHeader('Content-Type', 'application/json');
    if (upstreamFails) { response.writeHead(400); response.end(JSON.stringify({ error: { message: '固定提取失败', type: 'invalid_request_error' } })); return; }
    response.end(JSON.stringify({ id: 'synthetic-extraction', object: 'chat.completion', created: 0, model: 'e2e-mock-model', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ candidates }) }, finish_reason: 'stop' }] }));
});
const script = resolve('scripts/evaluate-exam-answer-extraction.mjs');
const region = (index: number) => ({ x: 0.1, y: 0.05 + index * 0.2, width: 0.5, height: 0.1 });
const candidate = (position: number, questionNumber: number, answer: string): ExamPageAnswerCandidate => ({ sourceShortId: `SRC00${questionNumber}`, displayNumber: questionNumber, recognizedAnswer: answer, notAttempted: false, confidence: 0.95, regions: [region(position)] });
type ExpectedAnswer = {
    questionId: string;
    normalizedAnswer: string;
    questionType?: string;
    regions: ReturnType<typeof region>[];
};
const expected = (position: number, questionNumber: number, answer: string): ExpectedAnswer => ({ questionId: `q${questionNumber}`, normalizedAnswer: answer, regions: [region(position)] });
beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'exam-evaluation-test-'));
    await new Promise<void>((resolve_) => server.listen(0, '127.0.0.1', resolve_));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => { upstreamFails = false; requestCount = 0; candidates = [candidate(0, 1, '低置信度答案'), candidate(1, 2, '另一答案')]; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve_) => server.close(() => resolve_())); await rm(directory, { recursive: true, force: true }); });
async function run(args: string[]) {
    const env = { ...process.env, EVALUATION_PROVIDER: 'openai', EVALUATION_BASE_URL: `${origin}/v1`, EVALUATION_API_KEY: dummyKey, EVALUATION_MODEL: 'e2e-mock-model' };
    try { const result = await execute(process.execPath, ['--conditions=react-server', script, ...args], { env }); return { code: 0, ...result }; }
    catch (error) { const failure = error as Error & { code: number; stdout: string; stderr: string }; return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr }; }
}
async function syntheticManifest(
    answers = [expected(0, 1, '低置信度答案'), expected(1, 2, '故意不同的答案'), expected(2, 3, '未检出')],
    sampleOverrides: Record<string, unknown> = {},
) {
    const input = join(directory, 'synthetic.json');
    await writeFile(input, JSON.stringify({ samples: [{ image: resolve('src/__tests__/fixtures/images/math_test.png'), paperId: 'synthetic-paper',
        questions: Array.from({ length: 5 }, (_, index) => ({ id: `q${index + 1}`, displayNumber: index + 1, sourceShortId: `SRC00${index + 1}`, questionText: '合成题' })), expected: answers, ...sampleOverrides }] }));
    return input;
}
async function evaluate(name: string, answers: ReturnType<typeof expected>[], sampleOverrides: Record<string, unknown> = {}) {
    const input = await syntheticManifest(answers, sampleOverrides);
    const output = join(directory, `${name}.json`);
    const result = await run(['--manifest', input, '--output', output]);
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(await readFile(output, 'utf8'));
}

describe('本地纸质作答提取评测 CLI', () => {
    it('要求显式输入输出路径，错误可读且退出码为 2', async () => {
        const result = await run([]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('--manifest');
        expect(result.stderr).not.toContain('stack');
    });
    it('拒绝损坏 manifest、未知期望题、重复标注和不可读图片，且不写报告', async () => {
        const path = join(directory, 'invalid.json');
        const question = { id: 'q1', displayNumber: 1, sourceShortId: 'SRC001', questionText: '合成题' };
        for (const value of ['{', JSON.stringify({ samples: [] }), JSON.stringify({ samples: [{ image: 'missing.png', paperId: 'p1', questions: [question], expected: [{ ...expected(0, 1, 'a'), questionId: 'unknown' }] }] }), JSON.stringify({ samples: [{ image: 'missing.png', paperId: 'p1', questions: [question], expected: [expected(0, 1, 'a'), expected(1, 1, 'b')] }] }), JSON.stringify({ samples: [{ image: 'missing.png', paperId: 'p1', questions: [question], expected: [expected(0, 1, 'a')] }] })]) {
            await writeFile(path, value);
            const result = await run(['--manifest', path, '--output', join(directory, 'must-not-exist.json')]);
            expect(result.code).toBe(2);
            expect(result.stderr).toContain('评测输入无效');
        }
        await expect(readFile(join(directory, 'must-not-exist.json'))).rejects.toThrow();
    });
    it('独立区域定位后比较应用匹配题 ID，交换两个答案的题号不能获得匹配正确率', async () => {
        candidates = [candidate(0, 2, '甲'), candidate(1, 1, '乙')];
        const report = await evaluate('swapped', [expected(0, 1, '甲'), expected(1, 2, '乙')]);
        expect(report).toMatchObject({ expectedCount: 2, matchedCount: 0, exactAnswerCount: 0, matchingAccuracy: 0, matchedExactAnswerAccuracy: 0 });
    });
    it('漏提、错配和答案错误均按全部人工标注计分母', async () => {
        candidates = [candidate(0, 1, '甲'), candidate(1, 2, '错误文字'), candidate(2, 5, '丙')];
        const report = await evaluate('mixed', [expected(0, 1, '甲'), expected(1, 2, '乙'), expected(2, 3, '丙'), expected(3, 4, '丁')]);
        expect(report).toMatchObject({ expectedCount: 4, matchedCount: 2, exactAnswerCount: 1, matchingAccuracy: 0.5, matchedExactAnswerAccuracy: 0.25 });
    });
    it('配对只依赖区域，支持多个框和候选乱序', async () => {
        candidates = [candidate(1, 2, '乙'), candidate(0, 1, '甲')];
        const truth = [expected(0, 1, '甲'), { ...expected(1, 2, '乙'), regions: [region(1), region(2)] }];
        expect(await evaluate('reordered', truth)).toMatchObject({ matchedCount: 2, exactAnswerCount: 2 });
    });
    it('重叠同分的歧义不猜测', async () => {
        candidates = [candidate(0, 1, '甲'), candidate(0, 2, '乙')];
        expect(await evaluate('ambiguous', [expected(0, 1, '甲'), expected(1, 2, '乙')])).toMatchObject({ matchedCount: 0, exactAnswerCount: 0 });
    });
    it('无人工区域、越界、空框、非数值或过多区域均拒绝并不写报告', async () => {
        for (const regions of [undefined, [], [region(0), region(1), region(2), region(3), region(4)], [{ ...region(0), x: -0.1 }], [{ ...region(0), width: 0 }], [{ ...region(0), x: 0.9 }], [{ ...region(0), y: '0.1' }]]) {
            const input = await syntheticManifest();
            const manifest = JSON.parse(await readFile(input, 'utf8'));
            manifest.samples[0].expected[0].regions = regions;
            await writeFile(input, JSON.stringify(manifest));
            const result = await run(['--manifest', input, '--output', join(directory, 'bad-region.json')]);
            expect(result.code).toBe(2);
            expect(result.stderr).toContain('区域');
        }
        await expect(readFile(join(directory, 'bad-region.json'))).rejects.toThrow();
    });
    it('复用真实提供商和匹配，报告不复制图片、Key 或答案原文', async () => {
        const report = await evaluate('report', [expected(0, 1, '低置信度答案'), expected(1, 2, '故意不同的答案'), expected(2, 3, '未检出')]);
        expect(report).toMatchObject({ version: 3, expectedCount: 3, matchedCount: 2, exactAnswerCount: 1, matchingAccuracy: 2 / 3, matchedExactAnswerAccuracy: 1 / 3, recommendedTarget: 0.95, meetsRecommendedTarget: false });
        expect(JSON.stringify(report)).not.toContain(dummyKey);
        expect(JSON.stringify(report)).not.toContain('base64');
        expect(JSON.stringify(report)).not.toContain('低置信度答案');
    });
    it('提供商失败退出 3，不回显 Key 或上游响应正文', async () => {
        upstreamFails = true;
        const result = await run(['--manifest', await syntheticManifest(), '--output', join(directory, 'failed.json')]);
        expect(result.code).toBe(3);
        expect(result.stderr).toContain('提取失败');
        expect(result.stderr).not.toContain(dummyKey);
        await expect(readFile(join(directory, 'failed.json'))).rejects.toThrow();
    });
    it('旧 manifest 缺少分层字段时仍评测，并把各维度归入 unlabeled', async () => {
        const report = await evaluate('unlabeled', [expected(0, 1, '低置信度答案')]);
        const group = { value: 'unlabeled', expectedCount: 1, matchedCount: 1, exactAnswerCount: 1, matchingAccuracy: 1, matchedExactAnswerAccuracy: 1 };
        for (const dimension of ['grade', 'subject', 'questionType', 'handwriting', 'photoQuality']) {
            expect(report.breakdowns[dimension]).toContainEqual(group);
        }
        expect(report.breakdowns.grade).toHaveLength(7);
        expect(report.breakdowns.subject).toHaveLength(SUBJECTS.length + 1);
        expect(report.breakdowns.questionType).toHaveLength(QUESTION_TYPE_KEYS.length + 1);
        expect(report.breakdowns.handwriting).toHaveLength(HANDWRITING_QUALITIES.length + 1);
        expect(report.breakdowns.photoQuality).toHaveLength(PHOTO_QUALITIES.length + 1);
        expect(report.breakdowns.subject).toContainEqual({ value: '数学', expectedCount: 0, matchedCount: 0, exactAnswerCount: 0, matchingAccuracy: 0, matchedExactAnswerAccuracy: 0 });
    });
    it('旧 manifest 的自由文本分层仍可评测，但不会进入报告枚举', async () => {
        const report = await evaluate('legacy-strata', [expected(0, 1, '低置信度答案')], { subject: '旧自定义学科', handwriting: '合成' });
        expect(report.results[0]).toMatchObject({ subject: 'unlabeled', handwriting: 'unlabeled' });
        expect(JSON.stringify(report)).not.toContain('旧自定义学科');
        expect(JSON.stringify(report)).not.toContain('合成');
    });
    it('完整元数据生成按年级、学科、题型、书写和拍摄质量分层的 v3 报告', async () => {
        const answer = { ...expected(0, 1, '低置信度答案'), questionType: 'calculation' };
        const report = await evaluate('stratified', [answer], { grade: 3, subject: '数学', handwriting: '清晰', photoQuality: '阴影' });
        const metric = { expectedCount: 1, matchedCount: 1, exactAnswerCount: 1, matchingAccuracy: 1, matchedExactAnswerAccuracy: 1 };
        expect(report).toMatchObject({ version: 3, results: [{ grade: '3', subject: '数学', questionType: 'calculation', handwriting: '清晰', photoQuality: '阴影' }] });
        expect(report.breakdowns.grade).toContainEqual({ value: '3', ...metric });
        expect(report.breakdowns.subject).toContainEqual({ value: '数学', ...metric });
        expect(report.breakdowns.questionType).toContainEqual({ value: 'calculation', ...metric });
        expect(report.breakdowns.handwriting).toContainEqual({ value: '清晰', ...metric });
        expect(report.breakdowns.photoQuality).toContainEqual({ value: '阴影', ...metric });
        expect(report.breakdowns.grade).toContainEqual({ value: '1', expectedCount: 0, matchedCount: 0, exactAnswerCount: 0, matchingAccuracy: 0, matchedExactAnswerAccuracy: 0 });
    });
    it('拒绝越界年级和未知题型，且不调用模型', async () => {
        for (const [sampleOverrides, answers] of [
            [{ grade: 7 }, [expected(0, 1, '答案')]],
            [{ grade: 3 }, [{ ...expected(0, 1, '答案'), questionType: '口算题' }]],
        ] as const) {
            const input = await syntheticManifest([...answers], sampleOverrides);
            const result = await run(['--manifest', input, '--output', join(directory, `invalid-strata-${requestCount}.json`)]);
            expect(result.code).toBe(2);
            expect(result.stderr).toContain('评测输入无效');
            expect(requestCount).toBe(0);
        }
    });
    it('全部页面校验完成后才发出第一次模型请求', async () => {
        const input = await syntheticManifest([expected(0, 1, '答案')]);
        const manifest = JSON.parse(await readFile(input, 'utf8'));
        manifest.samples.push({ ...manifest.samples[0], image: 'missing-second-page.png', paperId: 'page-2' });
        await writeFile(input, JSON.stringify(manifest));
        const result = await run(['--manifest', input, '--output', join(directory, 'prevalidated.json')]);
        expect(result.code).toBe(2);
        expect(requestCount).toBe(0);
    });
});
