#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveEvaluationInputs } from './exam-evaluation/manifest.mjs';
import { buildEvaluationReport } from './exam-evaluation/report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const fail = (message) => { throw new Error(message); };
const text = (value, max = 20000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const normalize = (value) => (value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');

function inputPaths(args) {
    if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--output' || !args[1] || !args[3]) {
        fail('用法：node --conditions=react-server scripts/evaluate-exam-answer-extraction.mjs --manifest <本地 JSON> --output <新报告 JSON>');
    }
    return { manifestPath: args[1], outputPath: args[3] };
}

const MIN_REGION_IOU = 0.5;
function regionIoU(left, right) {
    const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
    const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
    const intersection = width * height;
    return intersection / (left.width * left.height + right.width * right.height - intersection);
}

/** 只按人工框与模型框定位答案，不读取题号、短码、文字或候选顺序；歧义不猜测。 */
function pairByRegions(expected, candidates) {
    const scores = expected.map((truth) => candidates.map((candidate) => Math.max(0, ...truth.regions.flatMap((region) => candidate.regions.map((box) => regionIoU(region, box))))));
    const uniqueBest = (values) => {
        const best = Math.max(0, ...values);
        const indices = values.flatMap((value, index) => value >= MIN_REGION_IOU && Math.abs(value - best) < 1e-9 ? [index] : []);
        return indices.length === 1 ? indices[0] : -1;
    };
    return scores.map((row, expectedIndex) => {
        const candidateIndex = uniqueBest(row);
        return candidateIndex >= 0 && uniqueBest(scores.map((values) => values[candidateIndex])) === expectedIndex ? candidates[candidateIndex] : null;
    });
}

function runtime() {
    require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'node', jsx: 'react-jsx' } });
    require('tsconfig-paths').register({ baseUrl: root, paths: { '@/*': ['src/*'] } });
    const provider = process.env.EVALUATION_PROVIDER;
    const apiKey = process.env.EVALUATION_API_KEY;
    const model = process.env.EVALUATION_MODEL;
    const baseUrl = process.env.EVALUATION_BASE_URL;
    if (!['openai', 'azure', 'gemini', 'anthropic'].includes(provider) || !text(apiKey, 4096) || !text(model, 200)) fail('需设置 EVALUATION_PROVIDER、EVALUATION_API_KEY 和 EVALUATION_MODEL');
    if (baseUrl) { const url = new URL(baseUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('EVALUATION_BASE_URL 无效'); }
    let service;
    const config = { apiKey, model, baseUrl };
    if (provider === 'openai') service = new (require('../src/lib/ai/openai-provider.ts').OpenAIProvider)(config);
    if (provider === 'gemini') service = new (require('../src/lib/ai/gemini-provider.ts').GeminiProvider)(config);
    if (provider === 'anthropic') service = new (require('../src/lib/ai/anthropic-provider.ts').AnthropicProvider)(config);
    if (provider === 'azure') {
        if (!baseUrl || !text(process.env.EVALUATION_AZURE_DEPLOYMENT, 200)) fail('Azure 还需要 EVALUATION_BASE_URL 和 EVALUATION_AZURE_DEPLOYMENT');
        service = new (require('../src/lib/ai/azure-provider.ts').AzureOpenAIProvider)({ apiKey, model, endpoint: baseUrl, deploymentName: process.env.EVALUATION_AZURE_DEPLOYMENT, apiVersion: process.env.EVALUATION_AZURE_API_VERSION });
    }
    return { service, ...require('../src/lib/exam/exam-attempt.ts'), provider, model };
}

async function main() {
    let input;
    let engine;
    try { input = await resolveEvaluationInputs({ ...inputPaths(process.argv.slice(2)), repositoryRoot: root }); }
    catch (error) { process.stderr.write(`评测输入无效：${error.code ? '无法读取输入或输出目录' : error instanceof SyntaxError ? 'manifest 不是有效 JSON' : error.message}\n`); return 2; }
    try { engine = runtime(); }
    catch { process.stderr.write('评测配置无效：检查 Provider、模型、环境变量及 --conditions=react-server\n'); return 2; }
    const results = [];
    for (const [index, sample] of input.samples.entries()) {
        try {
            const image = await readFile(sample.image);
            const extension = extname(sample.image).toLowerCase();
            const mimeType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
            const extraction = await engine.service.extractExamPageAnswers({ imageBase64: image.toString('base64'), mimeType, questions: sample.questions, language: sample.language ?? 'zh' });
            const recognition = engine.buildAttemptPageRecognition(index + 1, extraction, new Date().toISOString());
            const matching = engine.matchExamAnswerCandidates(recognition.candidates, sample.questions);
            const paired = pairByRegions(sample.expected, recognition.candidates);
            for (const [expectedIndex, expected] of sample.expected.entries()) {
                const candidate = paired[expectedIndex];
                const match = candidate && matching.matches.find((item) => item.candidateId === candidate.candidateId);
                const matched = Boolean(match && match.questionId === expected.questionId);
                const exact = matched && normalize(candidate.recognizedAnswer) === normalize(expected.normalizedAnswer);
                // 报告只保存定位标识与布尔结论，避免复制照片、学生答案及绝对路径。
                results.push({
                    sample: index + 1,
                    paperId: sample.paperId,
                    questionId: expected.questionId,
                    matched,
                    exact,
                    grade: sample.grade === undefined ? 'unlabeled' : String(sample.grade),
                    subject: sample.subject ?? 'unlabeled',
                    questionType: expected.questionType ?? 'unlabeled',
                    handwriting: sample.handwriting ?? 'unlabeled',
                    photoQuality: sample.photoQuality ?? 'unlabeled',
                });
            }
        } catch { process.stderr.write(`第 ${index + 1} 页提取失败；未生成报告，请检查模型配置或重试\n`); return 3; }
    }
    const report = buildEvaluationReport({ provider: engine.provider, model: engine.model, results });
    try { await writeFile(input.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { process.stderr.write('报告写入失败；请检查目标路径和权限\n'); return 4; }
    process.stdout.write(`评测 ${report.expectedCount} 题；匹配正确率 ${(report.matchingAccuracy * 100).toFixed(2)}%；匹配且答案完全一致率 ${(report.matchedExactAnswerAccuracy * 100).toFixed(2)}%\n`);
    return 0;
}
process.exitCode = await main();
