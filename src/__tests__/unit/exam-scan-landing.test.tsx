import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamScanLanding } from '@/components/exam/exam-scan-landing';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { apiClient } from '@/lib/api-client';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn() } }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

const render = (requestedVersion: string | null = 'abcdef123456') => act(async () => root.render(
    <LanguageProvider>
        <ExamScanLanding printCode="Ab3xYz91" requestedVersion={requestedVersion} />
    </LanguageProvider>,
));

const resolution = {
    paperId: 'paper-1',
    title: '三年级数学练习',
    printCode: 'Ab3xYz91',
    currentPrintVersion: 'abcdef123456',
};

describe('纸质试卷扫码落地页', () => {
    it('版次一致时替换到既有纸质回传页面', async () => {
        vi.mocked(apiClient.get).mockResolvedValue({ ...resolution, versionMatches: true });

        await render();

        expect(apiClient.get).toHaveBeenCalledWith('/api/exams/print-code/Ab3xYz91', {
            params: { v: 'abcdef123456' },
        });
        expect(navigation.replace).toHaveBeenCalledWith('/exams/paper-1/attempts/new');
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('版次不一致时明确警告，用户确认后才进入回传', async () => {
        vi.mocked(apiClient.get).mockResolvedValue({ ...resolution, versionMatches: false });

        await render('deadbeefdead');

        expect(container.textContent).toContain('纸质试卷版本不一致');
        expect(container.textContent).toContain('三年级数学练习');
        expect(container.textContent).toContain('Ab3xYz91');
        expect(container.textContent).toContain('abcdef123456');
        expect(navigation.replace).not.toHaveBeenCalled();

        const button = [...container.querySelectorAll('button')]
            .find((element) => element.textContent?.includes('仍然上传'));
        expect(button).toBeTruthy();
        await act(async () => button!.click());
        expect(navigation.push).toHaveBeenCalledWith('/exams/paper-1/attempts/new');
    });

    it('未找到、无权访问和网络错误统一显示通用错误', async () => {
        vi.mocked(apiClient.get).mockRejectedValue(new Error('not found'));

        await render();

        expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法找到这份试卷');
        expect(container.textContent).not.toContain('其他账号');
        expect(navigation.push).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
    });
});
