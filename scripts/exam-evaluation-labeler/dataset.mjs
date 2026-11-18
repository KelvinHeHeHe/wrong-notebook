import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { validateEvaluationManifest } from '../exam-evaluation/manifest.mjs';

const execute = promisify(execFile);
const DRAFT_NAME = '.exam-answer-labeler.json';
const MANIFEST_NAME = 'manifest.json';
const PREVIOUS_MANIFEST_NAME = 'manifest.previous.json';
const IMAGE_EXTENSIONS = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp']]);
const writeLocks = new Map();

export class DatasetError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DatasetError';
        this.code = code;
    }
}

const fail = (code, message) => { throw new DatasetError(code, message); };
const inside = (root, candidate) => {
    const path = relative(root, candidate);
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};
const overlaps = (left, right) => inside(left, right) || inside(right, left);
const safeRelative = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !isAbsolute(value) && !value.split(/[\\/]/u).includes('..');

async function locked(path, operation) {
    const previous = writeLocks.get(path) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    writeLocks.set(path, current);
    try { return await current; }
    finally { if (writeLocks.get(path) === current) writeLocks.delete(path); }
}

async function atomicWrite(path, content) {
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
    } catch (error) {
        try { await rm(temporary, { force: true }); } catch { /* best effort */ }
        throw error;
    }
}

export async function resolveRepositoryBoundaries(repositoryRoot) {
    const root = await realpath(repositoryRoot);
    const [{ stdout: commonOutput }, { stdout: worktreeOutput }] = await Promise.all([
        execute('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
        execute('git', ['-C', root, 'worktree', 'list', '--porcelain']),
    ]);
    const candidates = [root, commonOutput.trim(), ...worktreeOutput.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))];
    const boundaries = [];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const path = await realpath(resolve(root, candidate));
        if (!boundaries.includes(path)) boundaries.push(path);
    }
    return boundaries.sort();
}

export async function discoverDatasetImages({ datasetRoot, maxDepth = 8, maxEntries = 10000, maxImages = 1000 } = {}) {
    const root = await realpath(datasetRoot);
    let photos;
    try { photos = await realpath(join(root, 'photos')); }
    catch { fail('DATASET_INVALID', '私有目录缺少 photos 子目录'); }
    if (!inside(root, photos)) fail('DATASET_BOUNDARY', 'photos 必须位于私有数据集内');
    if (!(await stat(photos)).isDirectory()) fail('DATASET_INVALID', 'photos 必须是目录');
    const images = [];
    let entries = 0;
    async function walk(directory, depth) {
        const items = await readdir(directory, { withFileTypes: true });
        for (const item of items) {
            if (item.name.startsWith('.')) continue;
            entries++;
            if (entries > maxEntries) fail('DATASET_LIMIT', '数据集目录项超过限制');
            const absolutePath = join(directory, item.name);
            const info = await lstat(absolutePath);
            if (info.isSymbolicLink()) continue;
            if (info.isDirectory()) {
                if (depth >= maxDepth) fail('DATASET_LIMIT', '数据集目录深度超过限制');
                await walk(absolutePath, depth + 1);
                continue;
            }
            if (!info.isFile()) continue;
            const mimeType = IMAGE_EXTENSIONS.get(extname(item.name).toLowerCase());
            if (!mimeType) continue;
            if (info.size === 0 || info.size > 20 * 1024 * 1024) fail('DATASET_IMAGE', '图片大小必须为 1 字节～20 MiB');
            images.push({ absolutePath, relativePath: relative(root, absolutePath).split(sep).join('/'), mimeType, size: info.size });
            if (images.length > maxImages) fail('DATASET_LIMIT', '数据集图片超过限制');
        }
    }
    await walk(photos, 0);
    if (!images.length) fail('DATASET_INVALID', 'photos 中没有支持的图片');
    return images.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
}

export async function openDataset({ datasetPath, repositoryRoot }) {
    if (!isAbsolute(datasetPath)) fail('DATASET_INVALID', '数据集路径必须是绝对路径');
    const root = await realpath(datasetPath);
    if (!(await stat(root)).isDirectory()) fail('DATASET_INVALID', '数据集路径必须是目录');
    const boundaries = await resolveRepositoryBoundaries(repositoryRoot);
    if (boundaries.some((boundary) => overlaps(boundary, root))) fail('DATASET_BOUNDARY', '数据集必须位于源码和 Git 工作树之外');
    const images = await discoverDatasetImages({ datasetRoot: root });
    return {
        root,
        images,
        draftPath: join(root, DRAFT_NAME),
        manifestPath: join(root, MANIFEST_NAME),
        previousManifestPath: join(root, PREVIOUS_MANIFEST_NAME),
    };
}

function defaultSample(image) {
    return {
        image,
        missing: false,
        paperId: '',
        grade: null,
        subject: '',
        handwriting: '',
        photoQuality: '',
        language: 'zh',
        questions: [],
        expected: [],
    };
}

function cleanQuestion(value) {
    return {
        id: typeof value?.id === 'string' ? value.id : '',
        displayNumber: Number.isInteger(value?.displayNumber) ? value.displayNumber : 0,
        sourceShortId: typeof value?.sourceShortId === 'string' ? value.sourceShortId : '',
        questionText: typeof value?.questionText === 'string' ? value.questionText : '',
    };
}

function cleanExpected(value) {
    return {
        questionId: typeof value?.questionId === 'string' ? value.questionId : '',
        normalizedAnswer: typeof value?.normalizedAnswer === 'string' ? value.normalizedAnswer : '',
        questionType: typeof value?.questionType === 'string' ? value.questionType : '',
        regions: Array.isArray(value?.regions) ? value.regions.slice(0, 4).map((region) => ({
            x: region?.x, y: region?.y, width: region?.width, height: region?.height,
        })) : [],
    };
}

function cleanSample(value, presentImages) {
    if (!safeRelative(value?.image)) fail('DRAFT_INVALID', '草稿包含无效图片路径');
    return {
        image: value.image.split('\\').join('/'),
        missing: !presentImages.has(value.image.split('\\').join('/')),
        paperId: typeof value.paperId === 'string' ? value.paperId : '',
        grade: Number.isInteger(value.grade) ? value.grade : null,
        subject: typeof value.subject === 'string' ? value.subject : '',
        handwriting: typeof value.handwriting === 'string' ? value.handwriting : '',
        photoQuality: typeof value.photoQuality === 'string' ? value.photoQuality : '',
        language: value.language === 'en' ? 'en' : 'zh',
        questions: Array.isArray(value.questions) ? value.questions.slice(0, 100).map(cleanQuestion) : [],
        expected: Array.isArray(value.expected) ? value.expected.slice(0, 100).map(cleanExpected) : [],
    };
}

async function readStoredDraft(context) {
    try {
        const value = JSON.parse(await readFile(context.draftPath, 'utf8'));
        if (value?.version !== 1 || !Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.samples) || value.samples.length > 1000) fail('DRAFT_INVALID', '草稿格式无效');
        const presentImages = new Set(context.images.map((image) => image.relativePath));
        const samples = value.samples.map((sample) => cleanSample(sample, presentImages));
        if (new Set(samples.map((sample) => sample.image)).size !== samples.length) fail('DRAFT_INVALID', '草稿图片路径重复');
        return { version: 1, revision: value.revision, samples };
    } catch (error) {
        if (error.code === 'ENOENT') return { version: 1, revision: 0, samples: [] };
        if (error instanceof DatasetError) throw error;
        fail('DRAFT_INVALID', '草稿无法读取');
    }
}

export async function loadDatasetDraft(context) {
    const stored = await readStoredDraft(context);
    const byImage = new Map(stored.samples.map((sample) => [sample.image, sample]));
    for (const image of context.images) if (!byImage.has(image.relativePath)) byImage.set(image.relativePath, defaultSample(image.relativePath));
    return { version: 1, revision: stored.revision, samples: [...byImage.values()].sort((left, right) => left.image.localeCompare(right.image, 'en')) };
}

export async function saveDatasetDraft(context, draft, expectedRevision) {
    return locked(context.draftPath, async () => {
        const stored = await readStoredDraft(context);
        if (!Number.isInteger(expectedRevision) || stored.revision !== expectedRevision) fail('DRAFT_CONFLICT', '草稿已被其他标签页更新');
        if (draft?.version !== 1 || !Array.isArray(draft.samples) || draft.samples.length > 1000) fail('DRAFT_INVALID', '草稿格式无效');
        const presentImages = new Set(context.images.map((image) => image.relativePath));
        const samples = draft.samples.map((sample) => cleanSample(sample, presentImages));
        if (new Set(samples.map((sample) => sample.image)).size !== samples.length) fail('DRAFT_INVALID', '草稿图片路径重复');
        const saved = { version: 1, revision: stored.revision + 1, samples };
        await atomicWrite(context.draftPath, `${JSON.stringify(saved, null, 2)}\n`);
        return saved;
    });
}

function formalSample(sample) {
    return {
        image: sample.image,
        paperId: sample.paperId,
        grade: sample.grade,
        subject: sample.subject,
        handwriting: sample.handwriting,
        photoQuality: sample.photoQuality,
        language: sample.language,
        questions: sample.questions,
        expected: sample.expected,
    };
}

export async function exportDatasetManifest(context, expectedRevision) {
    return locked(context.draftPath, async () => {
        const draft = await readStoredDraft(context);
        if (!Number.isInteger(expectedRevision) || draft.revision !== expectedRevision) fail('DRAFT_CONFLICT', '草稿已被其他标签页更新');
        const presentImages = new Set(context.images.map((image) => image.relativePath));
        if (draft.samples.some((sample) => sample.missing) || draft.samples.length !== presentImages.size || draft.samples.some((sample) => !presentImages.has(sample.image))) {
            fail('MANIFEST_INVALID', '存在缺失或未标注的图片');
        }
        let manifest;
        try { manifest = validateEvaluationManifest({ samples: draft.samples.map(formalSample) }, { requireStrata: true }); }
        catch { fail('MANIFEST_INVALID', '草稿尚未满足正式评测要求'); }
        const content = `${JSON.stringify(manifest, null, 2)}\n`;
        try {
            const previous = await readFile(context.manifestPath, 'utf8');
            await atomicWrite(context.previousManifestPath, previous);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await atomicWrite(context.manifestPath, content);
        return {
            revision: draft.revision,
            sampleCount: manifest.samples.length,
            expectedCount: manifest.samples.reduce((count, sample) => count + sample.expected.length, 0),
        };
    });
}
