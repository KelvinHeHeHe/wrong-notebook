import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamImportForm } from '@/components/exam-import/exam-import-form';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { apiClient } from '@/lib/api-client';
import { prepareExamImportFiles } from '@/lib/exam/exam-import-client';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

vi.mock('@/lib/exam/exam-import-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/exam/exam-import-client')>();
    return { ...actual, prepareExamImportFiles: vi.fn() };
});

vi.mock('@/lib/api-client', () => ({
    apiClient: {
        get: vi.fn(),
        post: vi.fn(),
    },
}));

const preparedPages = [
    { order: 1, role: 'questions' as const, imageData: 'data:image/jpeg;base64,YQ==', mimeType: 'image/jpeg' as const, width: 1000, height: 1400, sourceName: '1.jpg' },
    { order: 2, role: 'questions' as const, imageData: 'data:image/jpeg;base64,Yg==', mimeType: 'image/jpeg' as const, width: 1000, height: 1400, sourceName: '2.jpg' },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'subject-1', name: '数学', userId: 'user-1', createdAt: '', updatedAt: '' },
    ]);
    vi.mocked(prepareExamImportFiles).mockResolvedValue(preparedPages);
    vi.mocked(apiClient.post)
        .mockResolvedValueOnce({ paperId: 'paper-1' })
        .mockResolvedValueOnce({
            status: 'review',
            successes: [{ pageOrder: 1, questionCount: 3 }],
            failures: [{ pageOrder: 2, error: 'AI_TIMEOUT_ERROR' }],
        });
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
});

async function flush() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('ExamImportForm', () => {
    it('准备页图、创建草稿、整卷识别后跳转并保留失败页数量', async () => {
        await act(async () => root.render(<LanguageProvider><ExamImportForm /></LanguageProvider>));
        await flush();

        const title = container.querySelector('input[name="title"]') as HTMLInputElement;
        const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
        const file = new File(['image'], '1.jpg', { type: 'image/jpeg' });
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, '家庭周测');
            title.dispatchEvent(new Event('input', { bubbles: true }));
            Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await flush();

        expect(container.textContent).toContain('共 2 页');
        const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
        await act(async () => submit.click());
        await flush();

        expect(apiClient.post).toHaveBeenNthCalledWith(1, '/api/exams/import', expect.objectContaining({
            title: '家庭周测',
            subjectId: 'subject-1',
            sourceFileName: '1.jpg',
            pages: preparedPages.map(({ sourceName: _sourceName, ...page }) => page),
        }));
        expect(apiClient.post).toHaveBeenNthCalledWith(2, '/api/exams/paper-1/recognize', {
            pageOrders: [1, 2],
            language: 'zh',
        }, { recoverable: true, timeout: 600_000 });
        expect(pushMock).toHaveBeenCalledWith('/exams/paper-1/import?failed=1');
    });
});
