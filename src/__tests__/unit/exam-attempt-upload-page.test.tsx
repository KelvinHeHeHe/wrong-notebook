import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewExamAttemptPage from '@/app/exams/[id]/attempts/new/page';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { apiClient } from '@/lib/api-client';

let paperId = 'p1';
vi.mock('next/navigation', () => ({ useParams: () => ({ id: paperId }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/page-header', () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('@/components/exam-attempt/exam-attempt-upload-form', () => ({ ExamAttemptUploadForm: ({ paperId: id }: { paperId: string }) => <form data-paper-id={id} /> }));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn() } }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.resetAllMocks();
    paperId = 'p1';
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<LanguageProvider><NewExamAttemptPage /></LanguageProvider>));

describe('纸质作答上传页面', () => {
    it.each(['partial', 'generating', 'failed', 'review', 'importing'])('直达 %s 试卷时阻止上传', async (status) => {
        vi.mocked(apiClient.get).mockResolvedValue({ id: 'p1', title: '周测', status });
        await render();
        expect(container.querySelector('form')).toBeNull();
        expect(container.querySelector('[role=alert]')?.textContent).toContain('试卷准备完成');
    });
    it('直达 ready 试卷才显示表单；切换试卷时先卸载旧表单等待新状态', async () => {
        vi.mocked(apiClient.get).mockResolvedValueOnce({ id: 'p1', title: '周测', status: 'ready' });
        await render();
        expect(container.querySelector('form')?.getAttribute('data-paper-id')).toBe('p1');
        vi.mocked(apiClient.get).mockReturnValueOnce(new Promise(() => undefined));
        paperId = 'p2';
        await render();
        expect(container.querySelector('form')).toBeNull();
        expect(apiClient.get).toHaveBeenLastCalledWith('/api/exams/p2');
    });
    it('加载失败显示翻译错误并隐藏表单', async () => {
        vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('network'));
        await render();
        expect(container.querySelector('[role=alert]')?.textContent).toContain('试卷加载失败');
        expect(container.querySelector('form')).toBeNull();
    });
});
