import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { HANDWRITING_QUALITIES, PHOTO_QUALITIES, QUESTION_TYPE_KEYS, SUBJECTS } from './strata.mjs';

export { HANDWRITING_QUALITIES, PHOTO_QUALITIES, QUESTION_TYPE_KEYS, SUBJECTS } from './strata.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 20000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const member = (value, values) => typeof value === 'string' && values.includes(value);
const invalid = (message) => { throw new Error(message); };

function validateStrata(sample, index, requireStrata) {
    if (sample.grade !== undefined && (!Number.isInteger(sample.grade) || sample.grade < 1 || sample.grade > 6)) invalid(`第 ${index + 1} 页 grade 必须为 1～6`);
    if (requireStrata && sample.subject !== undefined && !member(sample.subject, SUBJECTS)) invalid(`第 ${index + 1} 页 subject 无效`);
    if (requireStrata && sample.handwriting !== undefined && !member(sample.handwriting, HANDWRITING_QUALITIES)) invalid(`第 ${index + 1} 页 handwriting 无效`);
    if (sample.photoQuality !== undefined && !member(sample.photoQuality, PHOTO_QUALITIES)) invalid(`第 ${index + 1} 页 photoQuality 无效`);
    if (requireStrata && (sample.grade === undefined || sample.subject === undefined || sample.handwriting === undefined || sample.photoQuality === undefined)) {
        invalid(`第 ${index + 1} 页缺少完整分层字段`);
    }
    return {
        grade: sample.grade,
        subject: member(sample.subject, SUBJECTS) ? sample.subject : undefined,
        handwriting: member(sample.handwriting, HANDWRITING_QUALITIES) ? sample.handwriting : undefined,
        photoQuality: sample.photoQuality,
    };
}

export function validateEvaluationManifest(value, { requireStrata = false } = {}) {
    if (!object(value) || !Array.isArray(value.samples) || !value.samples.length || value.samples.length > 1000) invalid('samples 必须包含 1～1000 页');
    const samples = value.samples.map((sample, index) => {
        if (!object(sample) || !text(sample.image, 4096) || !text(sample.paperId, 200) || !Array.isArray(sample.questions) || !sample.questions.length || sample.questions.length > 100 || !Array.isArray(sample.expected) || !sample.expected.length) invalid(`第 ${index + 1} 页缺少 image、paperId、questions 或 expected`);
        const strata = validateStrata(sample, index, requireStrata);
        const ids = new Set();
        const numbers = new Set();
        const shortIds = new Set();
        for (const question of sample.questions) {
            if (!object(question) || !text(question.id, 200) || !text(question.sourceShortId, 200) || !text(question.questionText) || !Number.isInteger(question.displayNumber) || question.displayNumber < 1 || ids.has(question.id) || numbers.has(question.displayNumber) || shortIds.has(question.sourceShortId)) invalid(`第 ${index + 1} 页候选题无效或标识重复`);
            ids.add(question.id); numbers.add(question.displayNumber); shortIds.add(question.sourceShortId);
        }
        const expectedIds = new Set();
        for (const expected of sample.expected) {
            if (!object(expected) || !ids.has(expected.questionId) || expectedIds.has(expected.questionId) || typeof expected.normalizedAnswer !== 'string' || expected.normalizedAnswer.length > 20000) invalid(`第 ${index + 1} 页期望题目未知、重复或答案无效`);
            if (expected.questionType !== undefined && !member(expected.questionType, QUESTION_TYPE_KEYS)) invalid(`第 ${index + 1} 页 questionType 无效`);
            if (requireStrata && expected.questionType === undefined) invalid(`第 ${index + 1} 页期望题目缺少 questionType`);
            if (!Array.isArray(expected.regions) || expected.regions.length < 1 || expected.regions.length > 4 || expected.regions.some((region) => !object(region) ||
                !['x', 'y', 'width', 'height'].every((key) => typeof region[key] === 'number' && Number.isFinite(region[key])) ||
                region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > 1 || region.y + region.height > 1)) invalid(`第 ${index + 1} 页人工标注区域必须为 1～4 个有效归一化框`);
            expectedIds.add(expected.questionId);
        }
        if (sample.language !== undefined && !['zh', 'en'].includes(sample.language)) invalid('language 只能为 zh 或 en');
        return { ...sample, ...strata, questions: sample.questions.map((question) => ({ ...question })), expected: sample.expected.map((expected) => ({ ...expected, regions: expected.regions.map((region) => ({ ...region })) })) };
    });
    return { samples };
}

function inside(root, candidate) {
    const fromRoot = relative(root, candidate);
    return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

export async function resolveEvaluationInputs({ manifestPath, outputPath, repositoryRoot }) {
    const manifest = await realpath(resolve(manifestPath));
    const outputParent = await realpath(dirname(resolve(outputPath)));
    const output = resolve(outputParent, basename(outputPath));
    const sourceRoot = await realpath(repositoryRoot);
    if (inside(sourceRoot, output)) invalid('报告必须放在仓库外的私有目录');
    if (output === manifest) invalid('报告不能覆盖 manifest');
    if ((await stat(manifest)).size > 10 * 1024 * 1024) invalid('manifest 超过 10 MiB');
    const parsed = JSON.parse(await readFile(manifest, 'utf8'));
    const validated = validateEvaluationManifest(parsed);
    const samples = [];
    for (const sample of validated.samples) {
        const image = await realpath(resolve(dirname(manifest), sample.image));
        if (image === output || !['.jpg', '.jpeg', '.png', '.webp'].includes(extname(image).toLowerCase())) invalid('只支持本地 JPEG、PNG、WebP 图片');
        const info = await stat(image);
        if (!info.isFile() || info.size === 0 || info.size > 20 * 1024 * 1024) invalid('图片必须为 1 字节～20 MiB 的普通文件');
        samples.push({ ...sample, image });
    }
    try { await stat(output); invalid('报告已存在，请指定新路径'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { samples, output };
}
