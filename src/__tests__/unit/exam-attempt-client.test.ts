import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api-client';
import { createAndRecognizeExamAttempt, prepareExamAttemptPhotos } from '@/lib/exam/exam-attempt-client';
import type { ExamAttemptUploadCheckpoint, ExamAttemptWorkflowDeps } from '@/lib/exam/exam-attempt-client';

vi.mock('@/lib/image-pipeline', () => ({ prepareImage: vi.fn(), renderRegion: vi.fn() }));
import { prepareImage, renderRegion } from '@/lib/image-pipeline';

const photo = (name = '1.jpg', type = 'image/jpeg') => new File(['image'], name, { type });
const pages = [{ order: 1, imageData: 'data:image/jpeg;base64,YQ==', mimeType: 'image/jpeg' as const, width: 1000, height: 1400, sourceName: '1.jpg' }];
const input = { paperId: 'p1', takenAt: '2026-11-09T00:00:00.000Z', language: 'zh' as const, pages };
const recognition = { status: 'review' as const, updatedAt: 'v3', successes: [{ pageOrder: 1, candidateCount: 1, matchedCount: 1 }], failures: [{ pageOrder: 2, error: 'AI_TIMEOUT_ERROR' }] };
function dependencies() {
    return {
        createAttempt: vi.fn().mockResolvedValue({ attemptId: 'a1', updatedAt: 'v1' }),
        uploadPages: vi.fn().mockResolvedValue({ id: 'a1', status: 'uploaded', updatedAt: 'v2' }),
        recognizePages: vi.fn().mockResolvedValue(recognition),
        getAttempt: vi.fn().mockResolvedValue({ id: 'a1', status: 'uploaded', updatedAt: 'server-latest' }),
    } satisfies ExamAttemptWorkflowDeps;
}

describe('回传照片准备', () => {
    it.each([[[]], [Array.from({ length: 21 }, () => photo())]])('拒绝范围外图片数量', async (files) => {
        await expect(prepareExamAttemptPhotos(files)).rejects.toThrow('EXAM_ATTEMPT_PHOTO_COUNT');
    });
    it.each([photo('scan.pdf', 'image/jpeg'), photo('scan.jpg', 'application/pdf'), photo('x.txt', 'text/plain')])('拒绝 PDF 和非图片', async (file) => {
        await expect(prepareExamAttemptPhotos([file])).rejects.toThrow('EXAM_ATTEMPT_IMAGES_ONLY');
    });
    it('按选择顺序调用方向校正与压缩，并释放原图', async () => {
        const dispose = vi.fn();
        const prepared = { dispose } as unknown as Awaited<ReturnType<typeof prepareImage>>;
        vi.mocked(prepareImage).mockResolvedValue(prepared);
        vi.mocked(renderRegion).mockResolvedValue({ dataUrl: pages[0].imageData, width: 1000, height: 1400 } as Awaited<ReturnType<typeof renderRegion>>);
        const files = [photo('2.heic', 'image/heic'), photo('1.png', 'image/png')];
        const result = await prepareExamAttemptPhotos(files);
        expect(prepareImage).toHaveBeenNthCalledWith(1, files[0]);
        expect(prepareImage).toHaveBeenNthCalledWith(2, files[1]);
        expect(renderRegion).toHaveBeenCalledWith(prepared);
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(result.map((page) => [page.order, page.sourceName, page.mimeType])).toEqual([[1, '2.heic', 'image/jpeg'], [2, '1.png', 'image/jpeg']]);
    });
    it('20 张照片可准备，压缩失败仍释放方向校正后的原图', async () => {
        const preparePhoto = vi.fn().mockResolvedValue({ dataUrl: pages[0].imageData, width: 1000, height: 1400 });
        expect(await prepareExamAttemptPhotos(Array.from({ length: 20 }, () => photo()), { preparePhoto })).toHaveLength(20);
        const dispose = vi.fn();
        vi.mocked(prepareImage).mockResolvedValue({ dispose } as unknown as Awaited<ReturnType<typeof prepareImage>>);
        vi.mocked(renderRegion).mockRejectedValueOnce(new Error('decode'));
        await expect(prepareExamAttemptPhotos([photo()])).rejects.toThrow('decode');
        expect(dispose).toHaveBeenCalledOnce();
    });
});

describe('回传串行流程', () => {
    it('创建→上传→识别逐次传最新服务端版本，保留部分失败', async () => {
        const deps = dependencies();
        const checkpoints: ExamAttemptUploadCheckpoint[] = [];
        const result = await createAndRecognizeExamAttempt(input, { ...deps, onCheckpoint: (value) => checkpoints.push(value) });
        expect(deps.createAttempt).toHaveBeenCalledWith('p1', { takenAt: input.takenAt });
        expect(deps.uploadPages).toHaveBeenCalledWith('a1', { expectedUpdatedAt: 'v1', pages: pages.map(({ sourceName: _name, ...page }) => page) });
        expect(deps.recognizePages).toHaveBeenCalledWith('a1', { expectedUpdatedAt: 'v2', pageOrders: [1], language: 'zh' });
        expect(deps.createAttempt.mock.invocationCallOrder[0]).toBeLessThan(deps.uploadPages.mock.invocationCallOrder[0]);
        expect(deps.uploadPages.mock.invocationCallOrder[0]).toBeLessThan(deps.recognizePages.mock.invocationCallOrder[0]);
        expect(checkpoints.at(-1)).toEqual({ attemptId: 'a1', updatedAt: 'v3', uploaded: true });
        expect(result).toEqual({ attemptId: 'a1', ...recognition });
    });
    it('上传失败后保留创建结果，重试读取服务器版本且不重复创建', async () => {
        const deps = dependencies();
        let checkpoint: ExamAttemptUploadCheckpoint | undefined;
        const onCheckpoint = (value: ExamAttemptUploadCheckpoint) => { checkpoint = value; };
        deps.uploadPages.mockRejectedValueOnce(new Error('network'));
        await expect(createAndRecognizeExamAttempt(input, { ...deps, onCheckpoint })).rejects.toThrow('network');
        expect(checkpoint).toEqual({ attemptId: 'a1', updatedAt: 'v1', uploaded: false });
        await createAndRecognizeExamAttempt({ ...input, checkpoint }, { ...deps, onCheckpoint });
        expect(deps.createAttempt).toHaveBeenCalledOnce();
        expect(deps.getAttempt).toHaveBeenCalledWith('a1');
        expect(deps.uploadPages).toHaveBeenLastCalledWith('a1', expect.objectContaining({ expectedUpdatedAt: 'server-latest' }));
    });
    it('创建失败不上传，允许重新创建', async () => {
        const deps = dependencies();
        deps.createAttempt.mockRejectedValueOnce(new Error('create'));
        await expect(createAndRecognizeExamAttempt(input, deps)).rejects.toThrow('create');
        expect(deps.uploadPages).not.toHaveBeenCalled();
        await createAndRecognizeExamAttempt(input, deps);
        expect(deps.createAttempt).toHaveBeenCalledTimes(2);
    });
});


describe('识别收尾 503', () => {
    const envelope = {
        message: 'EXAM_ATTEMPT_FINALIZE_FAILED', code: 'DATABASE_ERROR',
        details: { phase: 'finalize', retryable: true },
        status: 'review', updatedAt: '2026-11-09T11:00:00.001Z',
        successes: [{ pageOrder: 1, candidateCount: 1, matchedCount: 1 }], failures: [],
    };
    it('真实路由的标准 503 信封保留最新 checkpoint 并返回已有作答，不重新识别', async () => {
        const deps = dependencies();
        const onCheckpoint = vi.fn();
        deps.recognizePages.mockRejectedValueOnce(new ApiError(503, 'Service Unavailable', envelope));
        const result = await createAndRecognizeExamAttempt(input, { ...deps, onCheckpoint });
        expect(result).toMatchObject({ attemptId: 'a1', status: 'review', updatedAt: envelope.updatedAt, successes: envelope.successes, failures: [] });
        expect(onCheckpoint).toHaveBeenLastCalledWith({ attemptId: 'a1', updatedAt: envelope.updatedAt, uploaded: true });
        expect(deps.recognizePages).toHaveBeenCalledOnce();
    });
    it.each([
        { ...envelope, updatedAt: undefined },
        { ...envelope, updatedAt: 'not-a-date' },
        { ...envelope, status: 'recognizing' },
        { ...envelope, status: 'invented' },
        { ...envelope, successes: 'invalid' },
        { ...envelope, failures: undefined },
        { ...envelope, details: { phase: 'finalize', retryable: false } },
        { ...envelope, message: 'EXAM_ATTEMPT_RECOGNITION_FAILED' },
        { ...envelope, code: 'INTERNAL_ERROR' },
    ])('畸形或普通识别失败信封保持抛错', async (body) => {
        const deps = dependencies();
        const error = new ApiError(503, 'Service Unavailable', body);
        deps.recognizePages.mockRejectedValueOnce(error);
        await expect(createAndRecognizeExamAttempt(input, deps)).rejects.toBe(error);
    });
    it.each(['create', 'upload'])('%s 阶段的同形 503 不能误认成已识别', async (stage) => {
        const deps = dependencies();
        const error = new ApiError(503, 'Service Unavailable', envelope);
        (stage === 'create' ? deps.createAttempt : deps.uploadPages).mockRejectedValueOnce(error);
        await expect(createAndRecognizeExamAttempt(input, deps)).rejects.toBe(error);
        expect(deps.recognizePages).not.toHaveBeenCalled();
    });
});
