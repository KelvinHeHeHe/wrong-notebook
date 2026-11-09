import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamAttemptUploadForm } from '@/components/exam-attempt/exam-attempt-upload-form';
import * as languageContext from '@/contexts/LanguageContext';
import { translations } from '@/lib/translations';
import type { Translations } from '@/lib/translations';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { ApiError, apiClient } from '@/lib/api-client';
import { prepareExamAttemptPhotos } from '@/lib/exam/exam-attempt-client';
import { frontendLogger } from '@/lib/frontend-logger';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/exam/exam-attempt-client', async (original) => ({ ...await original<typeof import('@/lib/exam/exam-attempt-client')>(), prepareExamAttemptPhotos: vi.fn() }));
vi.mock('@/lib/api-client', async (original) => ({ ...await original<typeof import('@/lib/api-client')>(), apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/frontend-logger', () => ({ frontendLogger: { error: vi.fn(), warn: vi.fn() } }));
const pages = [1, 2].map((order) => ({ order, imageData: `data:image/jpeg;base64,${order === 1 ? 'YQ==' : 'Yg=='}`, mimeType: 'image/jpeg' as const, width: 1000, height: 1400, sourceName: `${order}.jpg` }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    vi.mocked(prepareExamAttemptPhotos).mockResolvedValue(pages);
    vi.mocked(apiClient.get).mockResolvedValue({ updatedAt: 'fresh', status: 'uploaded' });
    vi.mocked(apiClient.post).mockResolvedValueOnce({ attemptId: 'a1', updatedAt: 'v1' }).mockResolvedValueOnce({ updatedAt: 'v2' }).mockResolvedValueOnce({ status: 'review', updatedAt: 'v3', successes: [], failures: [{ pageOrder: 2, error: 'timeout' }] });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(paperId = 'p1') { await act(async () => root.render(<LanguageProvider><ExamAttemptUploadForm paperId={paperId} /></LanguageProvider>)); }
async function select() {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    await act(async () => { Object.defineProperty(input, 'files', { value: [new File(['image'], '1.jpg', { type: 'image/jpeg' })], configurable: true }); input.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

describe('纸质作答上传表单', () => {
    it('支持手机拍照、预览排序，部分失败仍进入复核', async () => {
        await render();
        const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
        expect(input.accept).toBe('image/*'); expect(input.multiple).toBe(true); expect(input.getAttribute('capture')).toBe('environment');
        await select();
        expect(container.querySelectorAll('li')).toHaveLength(2);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="下移"]')!.click());
        expect(container.querySelector('li')?.textContent).toContain('2.jpg');
        await submit();
        expect(apiClient.post).toHaveBeenNthCalledWith(2, '/api/exam-attempts/a1/pages', expect.objectContaining({ expectedUpdatedAt: 'v1', pages: [expect.objectContaining({ order: 1, imageData: pages[1].imageData }), expect.objectContaining({ order: 2, imageData: pages[0].imageData })] }));
        expect(apiClient.post).toHaveBeenNthCalledWith(3, '/api/exam-attempts/a1/recognize', { pageOrders: [1, 2], language: 'zh', expectedUpdatedAt: 'v2' }, { recoverable: true, timeout: 600_000 });
        expect(push).toHaveBeenCalledWith('/exam-attempts/a1');
        await submit();
        expect(apiClient.post).toHaveBeenCalledTimes(3);
    });
    it('创建进行中阻止重复提交，禁用照片、排序与日期', async () => {
        let resolve!: (value: unknown) => void;
        vi.mocked(apiClient.post).mockReset().mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValueOnce({ updatedAt: 'v2' }).mockResolvedValueOnce({ status: 'review', updatedAt: 'v3', successes: [], failures: [] });
        await render(); await select(); await submit(); await submit();
        expect(apiClient.post).toHaveBeenCalledOnce();
        expect(container.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);
        expect(container.querySelector('fieldset[disabled]')).not.toBeNull();
        await act(async () => resolve({ attemptId: 'a1', updatedAt: 'v1' }));
    });
    it('上传失败显示可重试错误，不泄漏图片，重试复用已创建作答', async () => {
        vi.mocked(apiClient.post).mockReset().mockResolvedValueOnce({ attemptId: 'a1', updatedAt: 'v1' }).mockRejectedValueOnce(new Error(pages[0].imageData)).mockResolvedValueOnce({ updatedAt: 'v2' }).mockResolvedValueOnce({ status: 'review', updatedAt: 'v3', successes: [], failures: [] });
        await render(); await select(); await submit();
        expect(container.querySelector('[role=alert]')).not.toBeNull();
        expect(container.textContent).not.toContain('base64');
        expect(JSON.stringify(vi.mocked(frontendLogger.error).mock.calls)).not.toContain('base64');
        await submit();
        expect(vi.mocked(apiClient.post).mock.calls.filter(([url]) => url === '/api/exams/p1/attempts')).toHaveLength(1);
        expect(push).toHaveBeenCalledWith('/exam-attempts/a1');
    });
    it('文案分组缺失时回退英文', async () => {
        const context = vi.spyOn(languageContext, 'useLanguage').mockReturnValue({ language: 'en', setLanguage: vi.fn(), t: { ...translations.en, examAttempt: undefined } as unknown as Translations });
        try {
            await render();
            expect(container.textContent).toContain('Upload and recognize');
        } finally { context.mockRestore(); }
    });
    it('照片准备失败显示对应翻译并可重新选择', async () => {
        vi.mocked(prepareExamAttemptPhotos).mockRejectedValueOnce(new Error('EXAM_ATTEMPT_IMAGES_ONLY'));
        await render(); await select();
        expect(container.querySelector('[role=alert]')?.textContent).toContain('不支持 PDF');
        await select(); expect(container.querySelectorAll('li')).toHaveLength(2);
    });
});


describe('回传异步生命周期', () => {
    it('卸载后识别返回不导航', async () => {
        let resolve!: (value: unknown) => void;
        vi.mocked(apiClient.post).mockReset().mockResolvedValueOnce({ attemptId: 'old', updatedAt: 'v1' }).mockResolvedValueOnce({ updatedAt: 'v2' }).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
        await render(); await select(); await submit();
        await act(async () => root.render(null));
        await act(async () => resolve({ status: 'review', updatedAt: 'v3', successes: [], failures: [] }));
        expect(push).not.toHaveBeenCalled();
    });
    it.each(['create', 'upload'])('%s 等待期间卸载，不再调用后续 API', async (stage) => {
        let resolve!: (value: unknown) => void;
        const post = vi.mocked(apiClient.post).mockReset();
        if (stage === 'upload') post.mockResolvedValueOnce({ attemptId: 'old', updatedAt: 'v1' });
        post.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
        await render(); await select(); await submit();
        const calls = post.mock.calls.length;
        await act(async () => root.render(null));
        await act(async () => resolve(stage === 'create' ? { attemptId: 'old', updatedAt: 'v1' } : { updatedAt: 'v2' }));
        expect(post).toHaveBeenCalledTimes(calls);
        expect(push).not.toHaveBeenCalled();
    });
    it('切换试卷后可以准备新照片并提交；旧识别迟到不污染新状态或导航', async () => {
        let resolveOld!: (value: unknown) => void;
        vi.mocked(apiClient.post).mockReset().mockResolvedValueOnce({ attemptId: 'old', updatedAt: 'v1' }).mockResolvedValueOnce({ updatedAt: 'v2' }).mockReturnValueOnce(new Promise((done) => { resolveOld = done; }))
            .mockResolvedValueOnce({ attemptId: 'new', updatedAt: 'n1' }).mockResolvedValueOnce({ updatedAt: 'n2' }).mockResolvedValueOnce({ status: 'review', updatedAt: 'n3', successes: [], failures: [] });
        await render(); await select(); await submit();
        await render('p2');
        expect(container.querySelector('fieldset[disabled]')).toBeNull();
        expect(container.querySelectorAll('li')).toHaveLength(0);
        await select(); await submit();
        expect(apiClient.post).toHaveBeenNthCalledWith(4, '/api/exams/p2/attempts', expect.anything());
        expect(push).toHaveBeenCalledExactlyOnceWith('/exam-attempts/new');
        await act(async () => resolveOld({ status: 'review', updatedAt: 'v3', successes: [], failures: [] }));
        expect(push).toHaveBeenCalledExactlyOnceWith('/exam-attempts/new');
        expect(container.querySelector('[role=alert]')).toBeNull();
    });
    it('旧照片准备结果迟到不能覆盖新试卷的照片', async () => {
        let resolveOld!: (value: typeof pages) => void;
        vi.mocked(prepareExamAttemptPhotos).mockReset().mockReturnValueOnce(new Promise((done) => { resolveOld = done; })).mockResolvedValueOnce([{ ...pages[0], sourceName: 'new.jpg' }]);
        await render(); await select();
        await render('p2'); await select();
        await act(async () => resolveOld(pages));
        expect(container.querySelectorAll('li')).toHaveLength(1);
        expect(container.querySelector('li')?.textContent).toContain('new.jpg');
    });
});


describe('收尾失败的复核导航', () => {
    const body = { message: 'EXAM_ATTEMPT_FINALIZE_FAILED', code: 'DATABASE_ERROR', details: { phase: 'finalize', retryable: true }, status: 'review', updatedAt: '2026-11-09T11:00:00.001Z', successes: [{ pageOrder: 1, candidateCount: 1, matchedCount: 1 }], failures: [] };
    it('标准 503 进入已创建作答，期间没有重复识别', async () => {
        vi.mocked(apiClient.post).mockReset().mockResolvedValueOnce({ attemptId: 'a1', updatedAt: '2026-11-09T11:00:00.000Z' }).mockResolvedValueOnce({ updatedAt: '2026-11-09T11:00:00.001Z' }).mockRejectedValueOnce(new ApiError(503, 'Service Unavailable', body));
        await render(); await select(); await submit();
        expect(push).toHaveBeenCalledExactlyOnceWith('/exam-attempts/a1');
        expect(container.querySelector('[role=alert]')).toBeNull();
        expect(apiClient.post).toHaveBeenCalledTimes(3);
    });
    it('缺失版本的 503 保留表单，不误导航', async () => {
        vi.mocked(apiClient.post).mockReset().mockResolvedValueOnce({ attemptId: 'a1', updatedAt: 'v1' }).mockResolvedValueOnce({ updatedAt: 'v2' }).mockRejectedValueOnce(new ApiError(503, 'Service Unavailable', { ...body, updatedAt: undefined }));
        await render(); await select(); await submit();
        expect(push).not.toHaveBeenCalled();
        expect(container.querySelector('[role=alert]')).not.toBeNull();
        expect(container.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(false);
    });
});
