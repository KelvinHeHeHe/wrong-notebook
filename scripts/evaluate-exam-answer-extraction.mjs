#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const fail = (message) => { throw new Error(message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 20000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const normalize = (value) => (value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');

async function inputs(args) {
    if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--output' || !args[1] || !args[3]) {
        fail('用法：node --conditions=react-server scripts/evaluate-exam-answer-extraction.mjs --manifest <本地 JSON> --output <新报告 JSON>');
    }
    const manifestPath = await realpath(resolve(args[1]));
    const output = resolve(await realpath(dirname(resolve(args[3]))), args[3].split(sep).pop());
    const fromRoot = relative(await realpath(root), output);
    if (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot)) fail('报告必须放在仓库外的私有目录');
    if (output === manifestPath) fail('报告不能覆盖 manifest');
    if ((await stat(manifestPath)).size > 10 * 1024 * 1024) fail('manifest 超过 10 MiB');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!object(manifest) || !Array.isArray(manifest.samples) || !manifest.samples.length || manifest.samples.length > 1000) fail('samples 必须包含 1～1000 页');
    const samples = [];
    for (const [index, sample] of manifest.samples.entries()) {
        if (!object(sample) || !text(sample.image, 4096) || !text(sample.paperId, 200) || !Array.isArray(sample.questions) || !sample.questions.length || sample.questions.length > 100 || !Array.isArray(sample.expected) || !sample.expected.length) fail(`第 ${index + 1} 页缺少 image、paperId、questions 或 expected`);
        const ids = new Set();
        const numbers = new Set();
        const shortIds = new Set();
        for (const question of sample.questions) {
            if (!object(question) || !text(question.id, 200) || !text(question.sourceShortId, 200) || !text(question.questionText) || !Number.isInteger(question.displayNumber) || question.displayNumber < 1 || ids.has(question.id) || numbers.has(question.displayNumber) || shortIds.has(question.sourceShortId)) fail(`第 ${index + 1} 页候选题无效或标识重复`);
            ids.add(question.id); numbers.add(question.displayNumber); shortIds.add(question.sourceShortId);
        }
        const expectedIds = new Set();
        for (const expected of sample.expected) {
            if (!object(expected) || !ids.has(expected.questionId) || expectedIds.has(expected.questionId) || typeof expected.normalizedAnswer !== 'string' || expected.normalizedAnswer.length > 20000) fail(`第 ${index + 1} 页期望题目未知、重复或答案无效`);
            expectedIds.add(expected.questionId);
        }
        if (sample.language !== undefined && !['zh', 'en'].includes(sample.language)) fail('language 只能为 zh 或 en');
        const image = await realpath(resolve(dirname(manifestPath), sample.image));
        if (image === output || !['.jpg', '.jpeg', '.png', '.webp'].includes(extname(image).toLowerCase())) fail('只支持本地 JPEG、PNG、WebP 图片');
        const info = await stat(image);
        if (!info.isFile() || info.size === 0 || info.size > 20 * 1024 * 1024) fail('图片必须为 1 字节～20 MiB 的普通文件');
        samples.push({ ...sample, image });
    }
    // 在首次模型请求前检查目标，避免误覆盖已有报告。
    try { await stat(output); fail('报告已存在，请指定新路径'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { samples, output };
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
    try { input = await inputs(process.argv.slice(2)); }
    catch (error) { process.stderr.write(`评测输入无效：${error.code ? '无法读取输入或输出目录' : error instanceof SyntaxError ? 'manifest 不是有效 JSON' : error.message}\n`); return 2; }
    try { engine = runtime(); }
    catch { process.stderr.write('评测配置无效：检查 Provider、模型、环境变量及 --conditions=react-server\n'); return 2; }
    const results = [];
    let matchedCount = 0;
    let exactAnswerCount = 0;
    for (const [index, sample] of input.samples.entries()) {
        try {
            const image = await readFile(sample.image);
            const extension = extname(sample.image).toLowerCase();
            const mimeType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
            const extraction = await engine.service.extractExamPageAnswers({ imageBase64: image.toString('base64'), mimeType, questions: sample.questions, language: sample.language ?? 'zh' });
            const recognition = engine.buildAttemptPageRecognition(index + 1, extraction, new Date().toISOString());
            const matching = engine.matchExamAnswerCandidates(recognition.candidates, sample.questions);
            for (const expected of sample.expected) {
                const match = matching.matches.find((item) => item.questionId === expected.questionId);
                const candidate = match && recognition.candidates.find((item) => item.candidateId === match.candidateId);
                const matched = Boolean(candidate);
                const exact = matched && normalize(candidate.recognizedAnswer) === normalize(expected.normalizedAnswer);
                if (matched) matchedCount++;
                if (exact) exactAnswerCount++;
                // 报告只保存定位标识与布尔结论，避免复制照片、学生答案及绝对路径。
                results.push({ sample: index + 1, paperId: sample.paperId, questionId: expected.questionId, matched, exact });
            }
        } catch { process.stderr.write(`第 ${index + 1} 页提取失败；未生成报告，请检查模型配置或重试\n`); return 3; }
    }
    const expectedCount = results.length;
    const report = { version: 1, provider: engine.provider, model: engine.model, expectedCount, matchedCount, exactAnswerCount,
        matchingAccuracy: matchedCount / expectedCount, matchedExactAnswerAccuracy: exactAnswerCount / expectedCount,
        recommendedTarget: 0.95, meetsRecommendedTarget: exactAnswerCount / expectedCount >= 0.95,
        minimumEvaluationSize: 60, sufficientSampleSize: expectedCount >= 60, results };
    try { await writeFile(input.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { process.stderr.write('报告写入失败；请检查目标路径和权限\n'); return 4; }
    process.stdout.write(`评测 ${expectedCount} 题；匹配正确率 ${(report.matchingAccuracy * 100).toFixed(2)}%；匹配且答案完全一致率 ${(report.matchedExactAnswerAccuracy * 100).toFixed(2)}%\n`);
    return 0;
}
process.exitCode = await main();
