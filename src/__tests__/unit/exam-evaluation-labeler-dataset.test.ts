// @vitest-environment node
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    discoverDatasetImages,
    exportDatasetManifest,
    loadDatasetDraft,
    openDataset,
    resolveRepositoryBoundaries,
    saveDatasetDraft,
} from '../../../scripts/exam-evaluation-labeler/dataset.mjs';

const repositoryRoot = resolve('.');
let temporaryRoot: string;
let datasetPath: string;
let photosPath: string;

async function image(relativePath: string, bytes = 16) {
    const path = join(datasetPath, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, Buffer.alloc(bytes, 1));
    return path;
}

async function completeDraft() {
    const context = await openDataset({ datasetPath, repositoryRoot });
    const draft = await loadDatasetDraft(context);
    draft.samples[0] = {
        ...draft.samples[0],
        paperId: 'private-paper',
        grade: 3,
        subject: '数学',
        handwriting: '清晰',
        photoQuality: '阴影',
        language: 'zh',
        questions: [{ id: 'q1', displayNumber: 1, sourceShortId: 'PRIVATE001', questionText: '已脱敏题目' }],
        expected: [{ questionId: 'q1', normalizedAnswer: '7', questionType: 'calculation', regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }] }],
    };
    return { context, draft };
}

beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'exam-labeler-dataset-'));
    datasetPath = join(temporaryRoot, 'private-dataset');
    photosPath = join(datasetPath, 'photos');
    await mkdir(photosPath, { recursive: true });
    await image('photos/page-1.jpg');
});

afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
});

describe('家庭样本评测私有数据集', () => {
    it('拒绝源码、Git common dir、已注册工作树及其符号链接作为数据集', async () => {
        const boundaries = await resolveRepositoryBoundaries(repositoryRoot);
        expect(boundaries).toContain(await realpath(repositoryRoot));
        for (const boundary of boundaries) {
            await expect(openDataset({ datasetPath: boundary, repositoryRoot })).rejects.toMatchObject({ code: 'DATASET_BOUNDARY' });
        }
        const link = join(temporaryRoot, 'repository-link');
        await symlink(repositoryRoot, link);
        await expect(openDataset({ datasetPath: link, repositoryRoot })).rejects.toMatchObject({ code: 'DATASET_BOUNDARY' });
    });

    it('只发现普通非隐藏图片，路径稳定排序且不跟随符号链接', async () => {
        await image('photos/nested/page-2.png');
        await image('photos/.hidden/page-3.webp');
        await symlink(join(photosPath, 'page-1.jpg'), join(photosPath, 'linked.jpg'));
        await writeFile(join(photosPath, 'notes.txt'), 'private note');
        const images = await discoverDatasetImages({ datasetRoot: datasetPath });
        expect(images.map((entry) => entry.relativePath)).toEqual(['photos/nested/page-2.png', 'photos/page-1.jpg']);
        expect(images.every((entry) => !entry.absolutePath.includes('..'))).toBe(true);
    });

    it('限制目录深度、总条目、图片数量和单图大小', async () => {
        let deep = 'photos';
        for (let index = 0; index < 9; index++) deep += `/level-${index}`;
        await image(`${deep}/too-deep.jpg`);
        await expect(discoverDatasetImages({ datasetRoot: datasetPath })).rejects.toMatchObject({ code: 'DATASET_LIMIT' });
        await rm(join(datasetPath, 'photos', 'level-0'), { recursive: true, force: true });
        await image('photos/page-2.jpg');
        await expect(discoverDatasetImages({ datasetRoot: datasetPath, maxEntries: 1 })).rejects.toMatchObject({ code: 'DATASET_LIMIT' });
        await expect(discoverDatasetImages({ datasetRoot: datasetPath, maxImages: 1 })).rejects.toMatchObject({ code: 'DATASET_LIMIT' });
        const empty = await image('photos/empty.jpg', 0);
        await expect(discoverDatasetImages({ datasetRoot: datasetPath })).rejects.toMatchObject({ code: 'DATASET_IMAGE' });
        await unlink(empty);
        const large = await image('photos/large.webp');
        await truncate(large, 20 * 1024 * 1024 + 1);
        await expect(discoverDatasetImages({ datasetRoot: datasetPath })).rejects.toMatchObject({ code: 'DATASET_IMAGE' });
    });

    it('按相对路径恢复草稿，合并新增图片并标记已移除图片', async () => {
        let context = await openDataset({ datasetPath, repositoryRoot });
        let draft = await loadDatasetDraft(context);
        expect(draft).toMatchObject({ version: 1, revision: 0, samples: [{ image: 'photos/page-1.jpg', missing: false }] });
        draft.samples[0].paperId = 'private-paper';
        const saved = await saveDatasetDraft(context, draft, 0);
        expect(saved.revision).toBe(1);

        await image('photos/page-2.png');
        await unlink(join(photosPath, 'page-1.jpg'));
        context = await openDataset({ datasetPath, repositoryRoot });
        draft = await loadDatasetDraft(context);
        expect(draft.samples).toEqual(expect.arrayContaining([
            expect.objectContaining({ image: 'photos/page-1.jpg', paperId: 'private-paper', missing: true }),
            expect.objectContaining({ image: 'photos/page-2.png', missing: false }),
        ]));
        expect(JSON.stringify(draft)).not.toContain(await realpath(datasetPath));
    });

    it('用 revision 阻止两个客户端静默覆盖同一份草稿', async () => {
        const context = await openDataset({ datasetPath, repositoryRoot });
        const first = await loadDatasetDraft(context);
        const second = structuredClone(first);
        first.samples[0].paperId = 'first-client';
        second.samples[0].paperId = 'second-client';
        const results = await Promise.allSettled([
            saveDatasetDraft(context, first, 0),
            saveDatasetDraft(context, second, 0),
        ]);
        expect(results[0]).toMatchObject({ status: 'fulfilled' });
        expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'DRAFT_CONFLICT' } });
        expect(await readFile(join(datasetPath, '.exam-answer-labeler.json'), 'utf8')).toContain('first-client');
    });

    it('允许保存未完成草稿，但严格导出拒绝缺失分层与区域', async () => {
        const context = await openDataset({ datasetPath, repositoryRoot });
        const draft = await loadDatasetDraft(context);
        const saved = await saveDatasetDraft(context, draft, 0);
        await expect(exportDatasetManifest(context, saved.revision)).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
        await expect(readFile(join(datasetPath, 'manifest.json'))).rejects.toThrow();
    });

    it('以 0600 原子导出正式 manifest，并在替换前完整保存单一上一版本', async () => {
        const { context, draft } = await completeDraft();
        const saved = await saveDatasetDraft(context, draft, 0);
        const oldManifest = '{"samples":[{"old":true}]}\n';
        await writeFile(join(datasetPath, 'manifest.json'), oldManifest);
        await chmod(join(datasetPath, 'manifest.json'), 0o644);

        const result = await exportDatasetManifest(context, saved.revision);
        const manifestText = await readFile(join(datasetPath, 'manifest.json'), 'utf8');
        expect(result).toMatchObject({ sampleCount: 1, expectedCount: 1, revision: saved.revision });
        expect(JSON.parse(manifestText)).toMatchObject({ samples: [{ image: 'photos/page-1.jpg', grade: 3, expected: [{ questionType: 'calculation' }] }] });
        expect(manifestText).not.toContain(temporaryRoot);
        expect(manifestText).not.toContain('revision');
        expect(await readFile(join(datasetPath, 'manifest.previous.json'), 'utf8')).toBe(oldManifest);
        expect((await lstat(join(datasetPath, 'manifest.json'))).mode & 0o777).toBe(0o600);
        expect((await lstat(join(datasetPath, 'manifest.previous.json'))).mode & 0o777).toBe(0o600);
    });
});
