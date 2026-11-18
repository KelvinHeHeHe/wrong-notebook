// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseLabelerArgs, startLabeler } from '../../../scripts/exam-evaluation-labeler/server.mjs';

const repositoryRoot = resolve('.');
const token = 'fixed-test-token';
let temporaryRoot: string;
let datasetPath: string;
let output: string;
let running: Awaited<ReturnType<typeof startLabeler>> | undefined;

async function rawRequest(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    if (!running) throw new Error('server not started');
    const address = running.server.address() as AddressInfo;
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve_, reject) => {
        const client = request({ hostname: '127.0.0.1', port: address.port, path, method: options.method ?? 'GET', headers: options.headers }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve_({ status: response.statusCode ?? 0, headers: response.headers, body }));
        });
        client.on('error', reject);
        if (options.body !== undefined) client.write(options.body);
        client.end();
    });
}

function authorizedHeaders(extra: Record<string, string> = {}) {
    if (!running) throw new Error('server not started');
    return { Host: new URL(running.origin).host, 'X-Evaluation-Token': token, ...extra };
}

beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'exam-labeler-server-'));
    datasetPath = join(temporaryRoot, 'private-dataset');
    await mkdir(join(datasetPath, 'photos'), { recursive: true });
    await writeFile(join(datasetPath, 'photos', 'private-page.jpg'), Buffer.alloc(32, 1));
    output = '';
    running = await startLabeler({ datasetPath, repositoryRoot, token, output: { write: (value: string) => { output += value; return true; } } });
});

afterEach(async () => {
    await running?.close();
    running = undefined;
    await rm(temporaryRoot, { recursive: true, force: true });
});

describe('家庭样本评测标注服务', () => {
    it('只接受绝对 dataset 和合法 port，拒绝未知、重复或不完整参数', () => {
        expect(parseLabelerArgs(['--dataset', '/private/evaluation'])).toEqual({ datasetPath: '/private/evaluation', port: 0 });
        expect(parseLabelerArgs(['--port', '4317', '--dataset', '/private/evaluation'])).toEqual({ datasetPath: '/private/evaluation', port: 4317 });
        for (const args of [[], ['--dataset', 'relative'], ['--dataset'], ['--dataset', '/a', '--dataset', '/b'], ['--dataset', '/a', '--port', '-1'], ['--dataset', '/a', '--port', '65536'], ['--dataset', '/a', '--unknown', 'x']]) {
            expect(() => parseLabelerArgs(args)).toThrow(expect.objectContaining({ code: 'ARGUMENTS' }));
        }
    });

    it('npm 正式入口会执行标注器并拒绝无效参数', async () => {
        const child = spawn('npm', ['run', '--silent', 'eval:label', '--', '--dataset', 'relative'], {
            cwd: repositoryRoot,
            env: { ...process.env, NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve_) => {
            child.once('exit', (code, signal) => resolve_({ code, signal }));
        });

        expect(exit).toEqual({ code: 2, signal: null });
        expect(stderr).toContain('标注器启动失败');
    });

    it('真实 CLI 完成草稿导出并在 SIGTERM 后正常退出', async () => {
        const child = spawn(process.execPath, [resolve(repositoryRoot, 'scripts/exam-evaluation-labeler.mjs'), '--dataset', datasetPath], {
            cwd: repositoryRoot,
            env: { ...process.env, NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve_) => {
            child.once('exit', (code, signal) => resolve_({ code, signal }));
        });
        const url = await new Promise<URL>((resolve_, reject) => {
            const timeout = setTimeout(() => reject(new Error(`标注器未输出启动地址：${stderr}`)), 10_000);
            const inspect = () => {
                const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/u);
                if (!match) return;
                clearTimeout(timeout);
                resolve_(new URL(match[0]));
            };
            child.stdout.on('data', inspect);
            child.once('exit', (code) => {
                clearTimeout(timeout);
                reject(new Error(`标注器提前退出（${code}）：${stderr}`));
            });
        });
        try {
            const token = new URLSearchParams(url.hash.slice(1)).get('token');
            const headers = { 'X-Evaluation-Token': token ?? '' };
            const stateResponse = await fetch(new URL('/api/state', url), { headers });
            expect(stateResponse.status).toBe(200);
            const state = await stateResponse.json() as { draft: { revision: number; samples: Array<Record<string, unknown>> } };
            Object.assign(state.draft.samples[0], {
                paperId: 'paper-cli-1', grade: 3, subject: '数学', handwriting: '清晰', photoQuality: '清晰', language: 'zh',
                questions: [{ id: 'q1', displayNumber: 1, sourceShortId: 'CLI001', questionText: '脱敏题目' }],
                expected: [{ questionId: 'q1', normalizedAnswer: 'private-cli-answer', questionType: 'calculation', regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }] }],
            });
            const writeHeaders = { ...headers, Origin: url.origin, 'Content-Type': 'application/json' };
            const draftResponse = await fetch(new URL('/api/draft', url), {
                method: 'PUT', headers: writeHeaders, body: JSON.stringify({ revision: state.draft.revision, draft: state.draft }),
            });
            expect(draftResponse.status).toBe(200);
            const saved = await draftResponse.json() as { revision: number };
            const exportResponse = await fetch(new URL('/api/export', url), {
                method: 'POST', headers: writeHeaders, body: JSON.stringify({ revision: saved.revision }),
            });
            expect(exportResponse.status).toBe(200);
            expect((await stat(join(datasetPath, 'manifest.json'))).mode & 0o777).toBe(0o600);
            expect(JSON.parse(await readFile(join(datasetPath, 'manifest.json'), 'utf8'))).toMatchObject({ samples: [{ paperId: 'paper-cli-1' }] });
        } finally {
            child.kill('SIGTERM');
        }
        await expect(exit).resolves.toEqual({ code: 0, signal: null });
        expect(`${stdout}\n${stderr}`).not.toContain(datasetPath);
        expect(`${stdout}\n${stderr}`).not.toContain('private-page.jpg');
        expect(`${stdout}\n${stderr}`).not.toContain('private-cli-answer');
    }, 20_000);

    it('固定监听 127.0.0.1，用 fragment 输出令牌且不打印私有目录', () => {
        const address = running!.server.address() as AddressInfo;
        expect(address.address).toBe('127.0.0.1');
        expect(running!.url).toBe(`${running!.origin}/#token=${token}`);
        expect(output).toContain(running!.url);
        expect(output).toContain('1 张');
        expect(output).not.toContain(datasetPath);
        expect(output).not.toContain('private-page.jpg');
    });

    it('只提供固定标注界面资源并为 HTML、CSS 和模块设置安全 MIME', async () => {
        const resources = [
            ['/', 'text/html; charset=utf-8'],
            ['/ui/styles.css', 'text/css; charset=utf-8'],
            ['/ui/app.mjs', 'text/javascript; charset=utf-8'],
            ['/ui/model.mjs', 'text/javascript; charset=utf-8'],
            ['/exam-evaluation/strata.mjs', 'text/javascript; charset=utf-8'],
        ] as const;
        for (const [path, contentType] of resources) {
            const response = await rawRequest(path, { headers: { Host: new URL(running!.origin).host } });
            expect(response.status).toBe(200);
            expect(response.headers['content-type']).toBe(contentType);
            expect(response.headers['content-security-policy']).toContain("script-src 'self'");
        }
        expect((await rawRequest('/ui/../dataset.mjs', { headers: { Host: new URL(running!.origin).host } })).status).toBe(404);
    });

    it('所有 API 都要求正确令牌，并严格拒绝错误 Host', async () => {
        expect((await rawRequest('/api/state', { headers: { Host: new URL(running!.origin).host } })).status).toBe(401);
        expect((await rawRequest('/api/state', { headers: { Host: new URL(running!.origin).host, 'X-Evaluation-Token': 'wrong' } })).status).toBe(401);
        expect((await rawRequest('/api/state', { headers: { Host: 'attacker.example', 'X-Evaluation-Token': token } })).status).toBe(421);
    });

    it('state 不含绝对路径，图片只按白名单 ID 提供并带安全响应头', async () => {
        const stateResponse = await rawRequest('/api/state', { headers: authorizedHeaders() });
        expect(stateResponse.status).toBe(200);
        const state = JSON.parse(stateResponse.body);
        expect(state).toMatchObject({ draft: { version: 1, revision: 0 }, images: [{ order: 1, mimeType: 'image/jpeg' }] });
        expect(stateResponse.body).not.toContain(datasetPath);
        expect(stateResponse.headers['access-control-allow-origin']).toBeUndefined();
        expect(stateResponse.headers['content-security-policy']).toContain("default-src 'self'");
        expect(stateResponse.headers['referrer-policy']).toBe('no-referrer');
        expect(stateResponse.headers['x-content-type-options']).toBe('nosniff');

        const imageResponse = await rawRequest(`/api/image/${state.images[0].id}`, { headers: authorizedHeaders() });
        expect(imageResponse.status).toBe(200);
        expect(imageResponse.headers['content-type']).toBe('image/jpeg');
        expect((await rawRequest('/api/image/unknown', { headers: authorizedHeaders() })).status).toBe(404);
        expect((await rawRequest('/api/image/..%2Fmanifest.json', { headers: authorizedHeaders() })).status).toBe(404);
    });

    it('拒绝启动后被替换为数据集外符号链接的白名单图片', async () => {
        const state = JSON.parse((await rawRequest('/api/state', { headers: authorizedHeaders() })).body);
        const secret = join(temporaryRoot, 'must-not-leak.txt');
        await writeFile(secret, 'outside-dataset-secret');
        const photo = join(datasetPath, 'photos', 'private-page.jpg');
        await unlink(photo);
        await symlink(secret, photo);
        const response = await rawRequest(`/api/image/${state.images[0].id}`, { headers: authorizedHeaders() });
        expect(response.status).toBe(404);
        expect(response.body).not.toContain('outside-dataset-secret');
    });

    it('拒绝启动后被替换为数据集外符号链接的中间目录', async () => {
        await running?.close();
        running = undefined;
        await rm(join(datasetPath, 'photos', 'private-page.jpg'));
        const nested = join(datasetPath, 'photos', 'nested');
        await mkdir(nested);
        await writeFile(join(nested, 'page.jpg'), Buffer.alloc(32, 1));
        output = '';
        running = await startLabeler({ datasetPath, repositoryRoot, token, output: { write: (value: string) => { output += value; return true; } } });
        const state = JSON.parse((await rawRequest('/api/state', { headers: authorizedHeaders() })).body);
        const outside = join(temporaryRoot, 'outside');
        await mkdir(outside);
        await writeFile(join(outside, 'page.jpg'), 'outside-parent-secret');
        await rm(nested, { recursive: true });
        await symlink(outside, nested);
        const response = await rawRequest(`/api/image/${state.images[0].id}`, { headers: authorizedHeaders() });
        expect(response.status).toBe(404);
        expect(response.body).not.toContain('outside-parent-secret');
    });

    it('写请求要求精确 Origin 和 JSON Content-Type，并限制请求体为 2 MiB', async () => {
        const host = new URL(running!.origin).host;
        const base = authorizedHeaders({ 'Content-Type': 'application/json' });
        expect((await rawRequest('/api/draft', { method: 'PUT', headers: { ...base, Origin: 'https://attacker.example' }, body: '{}' })).status).toBe(403);
        expect((await rawRequest('/api/draft', { method: 'PUT', headers: { ...authorizedHeaders(), Origin: running!.origin, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
        expect((await rawRequest('/api/draft', { method: 'PUT', headers: { Host: host, 'X-Evaluation-Token': token, Origin: running!.origin, 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024 + 1) }, body: '' })).status).toBe(413);
    });

    it('保存草稿并把过期 revision 映射为 409，错误不回显私有正文', async () => {
        const state = JSON.parse((await rawRequest('/api/state', { headers: authorizedHeaders() })).body);
        state.draft.samples[0].paperId = 'private-answer-marker';
        const headers = authorizedHeaders({ Origin: running!.origin, 'Content-Type': 'application/json' });
        const first = await rawRequest('/api/draft', { method: 'PUT', headers, body: JSON.stringify({ revision: 0, draft: state.draft }) });
        expect(first.status).toBe(200);
        expect(JSON.parse(first.body)).toMatchObject({ revision: 1 });
        const conflict = await rawRequest('/api/draft', { method: 'PUT', headers, body: JSON.stringify({ revision: 0, draft: state.draft }) });
        expect(conflict.status).toBe(409);
        expect(conflict.body).not.toContain('private-answer-marker');
        expect(conflict.body).not.toContain(datasetPath);
    });
});
