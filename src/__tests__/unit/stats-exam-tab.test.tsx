import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import StatsPage from '@/app/stats/page';

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

vi.mock('@/lib/page-title', () => ({ usePageTitle: vi.fn() }));
vi.mock('@/contexts/LanguageContext', () => ({
    useLanguage: () => ({
        t: {
            stats: {
                title: '练习统计',
                headerTitle: '统计中心',
                headerDesc: '学习数据',
                tagManagement: '知识点',
                examTrends: { tabTitle: '考试趋势' },
            },
            wrongAnswerStats: { title: '错题统计' },
        },
    }),
}));

vi.mock('@/components/stats/stats-filter-bar', () => ({
    StatsFilterBar: ({ defaultRange }: { defaultRange?: string }) => (
        <div data-stats-filter data-default-range={defaultRange} />
    ),
}));
vi.mock('@/components/stats/exam-trends', () => ({
    ExamTrends: ({ url }: { url: string }) => <div data-exam-trends-url={url} />,
}));
vi.mock('@/components/stats/wrong-answer-stats', () => ({
    WrongAnswerStats: () => <div data-wrong-stats />,
}));
vi.mock('@/components/stats/practice-stats', () => ({
    PracticeStats: () => <div data-practice-stats />,
}));
vi.mock('@/components/stats/activity-heatmap', () => ({
    ActivityHeatmap: () => <div data-activity-heatmap />,
}));
vi.mock('@/components/stats/repeated-mistakes-card', () => ({
    RepeatedMistakesCard: () => <div data-repeated-mistakes />,
}));
vi.mock('@/components/tags/tag-management', () => ({
    TagManagement: () => <div data-tag-management />,
}));

let container: HTMLDivElement;
let root: Root;

async function render(query: string) {
    navigation.query = query;
    await act(async () => root.render(<StatsPage />));
}

function tab(label: string): HTMLButtonElement {
    const element = [...container.querySelectorAll('button[role="tab"]')]
        .find(button => button.textContent?.includes(label));
    if (!(element instanceof HTMLButtonElement)) throw new Error(`未找到标签：${label}`);
    return element;
}

beforeEach(() => {
    vi.clearAllMocks();
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

describe('统计中心考试趋势标签', () => {
    it('考试标签使用 90 天默认值且默认 API 不携带范围参数', async () => {
        await render('tab=exams');

        expect(container.querySelectorAll('button[role="tab"]')).toHaveLength(4);
        expect(tab('考试趋势').getAttribute('aria-selected')).toBe('true');
        expect(container.querySelector('[data-stats-filter]')?.getAttribute('data-default-range'))
            .toBe('90d');
        expect(container.querySelector('[data-exam-trends-url]')?.getAttribute('data-exam-trends-url'))
            .toBe('/api/stats/exams');
    });

    it('考试标签把显式范围和学科映射到接口参数', async () => {
        await render('tab=exams&range=30d&subject=math');

        expect(container.querySelector('[data-exam-trends-url]')?.getAttribute('data-exam-trends-url'))
            .toBe('/api/stats/exams?range=30d&subjectId=math');
    });

    it('既有统计标签仍以 30 天为默认值', async () => {
        await render('tab=practice');

        expect(tab('练习统计').getAttribute('aria-selected')).toBe('true');
        expect(container.querySelector('[data-stats-filter]')?.getAttribute('data-default-range'))
            .toBe('30d');
    });

    it('旧 tag-stats 链接仍映射到知识点标签', async () => {
        await render('tab=tag-stats');

        expect(tab('知识点').getAttribute('aria-selected')).toBe('true');
        expect(container.querySelector('[data-tag-management]')).not.toBeNull();
        expect(container.querySelector('[data-stats-filter]')).toBeNull();
    });

    it('移动端四个标签使用两列布局', async () => {
        await render('tab=exams');

        expect(container.querySelector('[role="tablist"]')?.className).toContain('grid-cols-2');
        expect(container.querySelector('[role="tablist"]')?.className).toContain('sm:inline-flex');
    });
});
