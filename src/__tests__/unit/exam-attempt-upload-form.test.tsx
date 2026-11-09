import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamAttemptUploadForm } from '@/components/exam-attempt/exam-attempt-upload-form';
import * as languageContext from '@/contexts/LanguageContext';
import { translations } from '@/lib/translations';
import type { Translations } from '@/lib/translations';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { apiClient } from '@/lib/api-client';
import { prepareExamAttemptPhotos } from '@/lib/exam/exam-attempt-client';
import { frontendLogger } from '@/lib/frontend-logger';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/exam/exam-attempt-client', async (original) => ({ ...await original<typeof import('@/lib/exam/exam-attempt-client')>(), prepareExamAttemptPhotos: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
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
async function render() { await act(async () => root.render(<LanguageProvider><ExamAttemptUploadForm paperId="p1" /></LanguageProvider>)); }
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
