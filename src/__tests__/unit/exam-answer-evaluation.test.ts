// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DUMMY_KEY, startMockAI } from '../../../e2e/support/mock-ai.mjs';

const execute = promisify(execFile);
let directory: string;
let mock: Awaited<ReturnType<typeof startMockAI>>;
const script = resolve('scripts/evaluate-exam-answer-extraction.mjs');
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'exam-evaluation-test-')); mock = await startMockAI(); });
afterAll(async () => { await mock.close(); await rm(directory, { recursive: true, force: true }); });
async function run(args: string[], env: Record<string, string> = {}) {
    try { const result = await execute(process.execPath, ['--conditions=react-server', script, ...args], { env: { ...process.env, ...env } }); return { code: 0, ...result }; }
    catch (error) { const failure = error as Error & { code: number; stdout: string; stderr: string }; return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr }; }
}

async function syntheticManifest() {
    const input = join(directory, 'synthetic.json');
    await writeFile(input, JSON.stringify({ samples: [{ image: resolve('src/__tests__/fixtures/images/math_test.png'), paperId: 'synthetic-paper', subject: '数学', handwriting: '合成',
            questions: Array.from({ length: 5 }, (_, index) => ({ id: `q${index + 1}`, displayNumber: index + 1, sourceShortId: `SRC00${index + 1}`, questionText: '合成题' })),
            expected: [{ questionId: 'q1', normalizedAnswer: '低置信度答案' }, { questionId: 'q2', normalizedAnswer: '故意不同的答案' }, { questionId: 'q3', normalizedAnswer: '未检出' }] }] }));
    return input;
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
        for (const value of ['{', JSON.stringify({ samples: [] }), JSON.stringify({ samples: [{ image: 'missing.png', paperId: 'p1', questions: [question], expected: [{ questionId: 'unknown', normalizedAnswer: 'a' }] }] }), JSON.stringify({ samples: [{ image: 'missing.png', paperId: 'p1', questions: [question], expected: [{ questionId: 'q1', normalizedAnswer: 'a' }, { questionId: 'q1', normalizedAnswer: 'b' }] }] }), JSON.stringify({ samples: [{ image: 'missing.png', paperId: 'p1', questions: [question], expected: [{ questionId: 'q1', normalizedAnswer: 'a' }] }] })]) {
            await writeFile(path, value);
            const result = await run(['--manifest', path, '--output', join(directory, 'must-not-exist.json')]);
            expect(result.code).toBe(2);
            expect(result.stderr).toContain('评测输入无效');
        }
        await expect(readFile(join(directory, 'must-not-exist.json'))).rejects.toThrow();
    });
    it('复用真实提供商提取和确定性匹配，分别统计匹配率与匹配且答案一致率', async () => {
        await fetch(`${mock.origin}/control/evaluation`, { method: 'POST', body: '{}' });
        const input = await syntheticManifest();
        const output = join(directory, 'report.json');
        const result = await run(['--manifest', input, '--output', output], { EVALUATION_PROVIDER: 'openai', EVALUATION_BASE_URL: `${mock.origin}/cases/evaluation/v1`, EVALUATION_API_KEY: DUMMY_KEY, EVALUATION_MODEL: 'e2e-mock-model' });
        expect(result.code, result.stderr).toBe(0);
        const report = JSON.parse(await readFile(output, 'utf8'));
        expect(report).toMatchObject({ expectedCount: 3, matchedCount: 2, exactAnswerCount: 1, matchingAccuracy: 2 / 3, matchedExactAnswerAccuracy: 1 / 3, recommendedTarget: 0.95, meetsRecommendedTarget: false });
        expect(JSON.stringify(report)).not.toContain(DUMMY_KEY);
        expect(JSON.stringify(report)).not.toContain('base64');
    });
    it('提供商失败退出 3，不回显 Key 或上游响应正文', async () => {
        await fetch(`${mock.origin}/control/evaluation-fail`, { method: 'POST', body: JSON.stringify({ extractionFailOnCall: 1 }) });
        const result = await run(['--manifest', await syntheticManifest(), '--output', join(directory, 'failed.json')], { EVALUATION_PROVIDER: 'openai', EVALUATION_BASE_URL: `${mock.origin}/cases/evaluation-fail/v1`, EVALUATION_API_KEY: DUMMY_KEY, EVALUATION_MODEL: 'e2e-mock-model' });
        expect(result.code).toBe(3);
        expect(result.stderr).toContain('提取失败');
        expect(result.stderr).not.toContain(DUMMY_KEY);
        await expect(readFile(join(directory, 'failed.json'))).rejects.toThrow();
    });
});
