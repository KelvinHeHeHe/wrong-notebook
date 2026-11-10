import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatsFilterBar } from '@/components/stats/stats-filter-bar';

const navigation = vi.hoisted(() => ({
    pathname: '/stats',
    query: 'tab=exams',
    replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
    usePathname: () => navigation.pathname,
    useRouter: () => ({ replace: navigation.replace }),
    useSearchParams: () => new URLSearchParams(navigation.query),
}));

vi.mock('@/contexts/LanguageContext', () => ({
    useLanguage: () => ({
        t: {
            stats: {
                range7d: '近 7 天',
                range30d: '近 30 天',
                range90d: '近 90 天',
                range6m: '近 6 个月',
                rangeAll: '全部',
                allSubjects: '全部学科',
                timeRange: '时间范围',
            },
        },
    }),
}));

vi.mock('@/lib/api-client', () => ({
    apiClient: { get: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/lib/frontend-logger', () => ({
    frontendLogger: { warn: vi.fn() },
}));

let container: HTMLDivElement;
let root: Root;

function findRangeButton(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')]
        .find(candidate => candidate.textContent === label);
    if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`未找到范围按钮：${label}`);
    }
    return button;
}

async function render(defaultRange?: '7d' | '30d' | '90d' | '6m' | 'all') {
    await act(async () => {
        root.render(<StatsFilterBar defaultRange={defaultRange} />);
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    navigation.query = 'tab=exams';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe('StatsFilterBar', () => {
    it('考试标签无显式范围时选中调用方的 90 天默认值', async () => {
        await render('90d');

        expect(findRangeButton('近 90 天').getAttribute('aria-pressed')).toBe('true');
        expect(findRangeButton('近 30 天').getAttribute('aria-pressed')).toBe('false');
    });

    it('考试标签选择 30 天时保留显式 URL 参数', async () => {
        await render('90d');

        await act(async () => findRangeButton('近 30 天').click());

        expect(navigation.replace).toHaveBeenCalledWith(
            '/stats?tab=exams&range=30d',
            { scroll: false },
        );
    });

    it('考试标签选回 90 天时删除范围参数', async () => {
        navigation.query = 'tab=exams&range=30d';
        await render('90d');

        await act(async () => findRangeButton('近 90 天').click());

        expect(navigation.replace).toHaveBeenCalledWith('/stats?tab=exams', { scroll: false });
    });

    it('显式范围优先于考试标签默认值', async () => {
        navigation.query = 'tab=exams&range=7d';
        await render('90d');

        expect(findRangeButton('近 7 天').getAttribute('aria-pressed')).toBe('true');
        expect(findRangeButton('近 90 天').getAttribute('aria-pressed')).toBe('false');
    });

    it('未传默认值时仍默认 30 天', async () => {
        navigation.query = 'tab=practice';
        await render();

        expect(findRangeButton('近 30 天').getAttribute('aria-pressed')).toBe('true');
    });
});
