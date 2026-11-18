import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { O_NOFOLLOW, O_RDONLY } from 'node:constants';
import { open, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DatasetError, exportDatasetManifest, loadDatasetDraft, openDataset, saveDatasetDraft } from './dataset.mjs';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const STATIC_ASSETS = new Map([
    ['/', { path: resolve(moduleDirectory, 'ui/index.html'), type: 'text/html; charset=utf-8' }],
    ['/ui/styles.css', { path: resolve(moduleDirectory, 'ui/styles.css'), type: 'text/css; charset=utf-8' }],
    ['/ui/app.mjs', { path: resolve(moduleDirectory, 'ui/app.mjs'), type: 'text/javascript; charset=utf-8' }],
    ['/ui/model.mjs', { path: resolve(moduleDirectory, 'ui/model.mjs'), type: 'text/javascript; charset=utf-8' }],
    ['/exam-evaluation/strata.mjs', { path: resolve(moduleDirectory, '../exam-evaluation/strata.mjs'), type: 'text/javascript; charset=utf-8' }],
]);
const SECURITY_HEADERS = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
};

export class LabelerError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'LabelerError';
        this.code = code;
    }
}

const fail = (code, message) => { throw new LabelerError(code, message); };
const writeHeaders = (response, headers = {}) => {
    for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...headers })) response.setHeader(name, value);
};
const sendJson = (response, status, value) => {
    writeHeaders(response, { 'Content-Type': 'application/json; charset=utf-8' });
    response.writeHead(status);
    response.end(`${JSON.stringify(value)}\n`);
};
const sendError = (response, status, error) => sendJson(response, status, { error });
const secureEqual = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
};

export function parseLabelerArgs(args) {
    if (!Array.isArray(args) || args.length % 2 !== 0) fail('ARGUMENTS', '参数无效');
    const values = new Map();
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        if (!['--dataset', '--port'].includes(key) || values.has(key) || !args[index + 1]) fail('ARGUMENTS', '参数无效');
        values.set(key, args[index + 1]);
    }
    const datasetPath = values.get('--dataset');
    if (!datasetPath || !isAbsolute(datasetPath)) fail('ARGUMENTS', 'dataset 必须是绝对路径');
    const rawPort = values.get('--port');
    const port = rawPort === undefined ? 0 : Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535 || (rawPort !== undefined && String(port) !== rawPort)) fail('ARGUMENTS', 'port 无效');
    return { datasetPath, port };
}

function imageId(token, relativePath) {
    return createHash('sha256').update(token).update('\0').update(relativePath).digest('base64url').slice(0, 24);
}

async function readWhitelistedImage(image) {
    let handle;
    try {
        handle = await open(image.absolutePath, O_RDONLY | O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > 20 * 1024 * 1024) return null;
        return await handle.readFile();
    } catch {
        return null;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function readJson(request) {
    const type = request.headers['content-type'] ?? '';
    if (!/^application\/json(?:\s*;|$)/iu.test(type)) throw new LabelerError('CONTENT_TYPE', '请求必须是 JSON');
    const length = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new LabelerError('BODY_TOO_LARGE', '请求体过大');
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_JSON_BYTES) { tooLarge = true; continue; }
        chunks.push(chunk);
    }
    if (tooLarge) throw new LabelerError('BODY_TOO_LARGE', '请求体过大');
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new LabelerError('BAD_JSON', 'JSON 无效'); }
}

function statusFor(error) {
    if (error?.code === 'DRAFT_CONFLICT') return [409, 'draft_conflict'];
    if (error?.code === 'MANIFEST_INVALID' || error?.code === 'DRAFT_INVALID') return [422, 'invalid_data'];
    if (error?.code === 'CONTENT_TYPE') return [415, 'content_type'];
    if (error?.code === 'BODY_TOO_LARGE') return [413, 'body_too_large'];
    if (error?.code === 'BAD_JSON') return [400, 'bad_json'];
    return [500, 'internal_error'];
}

export function createLabelerServer({ context, token }) {
    const imagesById = new Map(context.images.map((image) => [imageId(token, image.relativePath), image]));
    return createServer(async (request, response) => {
        const expectedHost = `127.0.0.1:${request.socket.localPort}`;
        if (request.headers.host !== expectedHost) { sendError(response, 421, 'invalid_host'); return; }
        const origin = `http://${expectedHost}`;
        const url = new URL(request.url ?? '/', origin);
        if (url.pathname.startsWith('/api/') && !secureEqual(request.headers['x-evaluation-token'], token)) { sendError(response, 401, 'unauthorized'); return; }
        try {
            const asset = STATIC_ASSETS.get(url.pathname);
            if (asset) {
                if (request.method !== 'GET') { sendError(response, 405, 'method_not_allowed'); return; }
                const content = await readFile(asset.path);
                writeHeaders(response, { 'Content-Type': asset.type, 'Content-Length': String(content.length) });
                response.writeHead(200);
                response.end(content);
                return;
            }
            if (url.pathname === '/api/state') {
                if (request.method !== 'GET') { sendError(response, 405, 'method_not_allowed'); return; }
                const draft = await loadDatasetDraft(context);
                const images = [...imagesById].map(([id, image], index) => ({ id, image: image.relativePath, order: index + 1, mimeType: image.mimeType, size: image.size }));
                sendJson(response, 200, { draft, images, progress: { totalPages: draft.samples.length, expectedCount: draft.samples.reduce((count, sample) => count + sample.expected.length, 0) } });
                return;
            }
            if (url.pathname.startsWith('/api/image/')) {
                if (request.method !== 'GET') { sendError(response, 405, 'method_not_allowed'); return; }
                const id = url.pathname.slice('/api/image/'.length);
                const image = imagesById.get(id);
                if (!image || !id || id.includes('/')) { sendError(response, 404, 'not_found'); return; }
                const content = await readWhitelistedImage(image);
                if (!content) { sendError(response, 404, 'not_found'); return; }
                writeHeaders(response, { 'Content-Type': image.mimeType, 'Content-Length': String(content.length) });
                response.writeHead(200);
                response.end(content);
                return;
            }
            if (url.pathname === '/api/draft' || url.pathname === '/api/export') {
                const expectedMethod = url.pathname === '/api/draft' ? 'PUT' : 'POST';
                if (request.method !== expectedMethod) { sendError(response, 405, 'method_not_allowed'); return; }
                if (request.headers.origin !== origin) { sendError(response, 403, 'invalid_origin'); return; }
                const body = await readJson(request);
                if (url.pathname === '/api/draft') {
                    const saved = await saveDatasetDraft(context, body?.draft, body?.revision);
                    sendJson(response, 200, { revision: saved.revision });
                } else {
                    sendJson(response, 200, await exportDatasetManifest(context, body?.revision));
                }
                return;
            }
            sendError(response, 404, 'not_found');
        } catch (error) {
            const [status, code] = statusFor(error);
            sendError(response, status, code);
        }
    });
}

export async function startLabeler({ datasetPath, repositoryRoot, port = 0, token = randomBytes(32).toString('base64url'), output = process.stdout }) {
    const context = await openDataset({ datasetPath, repositoryRoot });
    const server = createLabelerServer({ context, token });
    await new Promise((resolve_, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve_(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); fail('STARTUP', '服务启动失败'); }
    const origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/#token=${token}`;
    output.write(`发现 ${context.images.length} 张样本图片；标注地址：${url}\n`);
    let closing;
    const close = () => {
        if (!closing) closing = new Promise((resolve_) => {
            server.closeAllConnections();
            server.close(() => resolve_());
        });
        return closing;
    };
    return { server, context, origin, url, token, close };
}
