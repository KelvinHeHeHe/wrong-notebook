import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamTrends } from '@/components/stats/exam-trends';
import type { ExamTrendStatsData } from '@/types/api';

const mocks = vi.hoisted(() => ({
    reload: vi.fn(),
    useStatsData: vi.fn(),
}));

vi.mock('@/lib/hooks/use-stats-data', () => ({
    useStatsData: mocks.useStatsData,
}));

vi.mock('@/contexts/LanguageContext', () => ({
    useLanguage: () => ({
        t: {
            statsState: {
                errorTitle: '加载统计失败',
                errorDesc: '请重试',
                retry: '重试',
            },
            stats: {
                examTrends: {
                    title: '考试趋势',
                    description: '查看已确认考试的成绩变化',
                    examCount: '考试次数',
                    averageRate: '平均得分率',
                    latestRate: '最近一次',
                    changeFromPrevious: '较上一次',
                    totalWrong: '累计错题',
                    changeUnit: '个百分点',
                    emptyTitle: '暂无考试趋势',
                    emptyDescription: '确认一次考试成绩后显示趋势',
                    goToExams: '前往试卷',
                    attemptsTitle: '逐次考试',
                    score: '得分',
                    rate: '得分率',
                    wrongCount: '错题 {count} 道',
                    detailAria: '查看 {title}（{date}，{score} / {maxScore}）的作答详情',
                    loading: '正在加载考试趋势',
                },
            },
        },
    }),
}));

vi.mock('@/components/stats/exam-trend-chart', () => ({
    ExamTrendChart: () => <div data-testid="exam-trend-chart" />,
}));

const data: ExamTrendStatsData = {
    range: '90d',
    summary: {
        examCount: 3,
        averageRate: 73.3,
        latestRate: 90,
        changeFromPrevious: 10,
        wrongCount: 3,
    },
    points: [
        {
            attemptId: 'attempt-1',
            paperId: 'paper-1',
            paperTitle: '家庭数学周测',
            subjectId: 'subject-math',
            subjectName: '数学',
            takenAt: '2026-11-01T01:00:00.000Z',
            dateLabel: '2026-11-01',
            totalScore: 17,
            maxScore: 50,
            rate: 34,
            wrongCount: 2,
        },
        {
            attemptId: 'attempt-2',
            paperId: 'paper-2',
            paperTitle: '英语单元测验',
            subjectId: 'subject-english',
            subjectName: '英语',
            takenAt: '2026-11-02T01:00:00.000Z',
            dateLabel: '2026-11-02',
            totalScore: 8,
            maxScore: 10,
            rate: 80,
            wrongCount: 1,
        },
        {
            attemptId: 'attempt-3',
            paperId: 'paper-3',
            paperTitle: '语文综合练习',
            subjectId: 'subject-chinese',
            subjectName: '语文',
            takenAt: '2026-11-03T01:00:00.000Z',
            dateLabel: '2026-11-03',
            totalScore: 90,
            maxScore: 100,
            rate: 90,
            wrongCount: 0,
        },
    ],
};

let container: HTMLDivElement;
let root: Root;

async function render(state: {
    data: ExamTrendStatsData | null;
    loading?: boolean;
    error?: boolean;
}) {
    mocks.useStatsData.mockReturnValue({
        data: state.data,
        loading: state.loading ?? false,
        error: state.error ?? false,
        reload: mocks.reload,
    });
    await act(async () => root.render(<ExamTrends url="/api/stats/exams" />));
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

describe('ExamTrends', () => {
    it('加载中提供可读状态', async () => {
        await render({ data: null, loading: true });

        expect(container.querySelector('[role="status"]')?.getAttribute('aria-label'))
            .toBe('正在加载考试趋势');
    });

    it('请求失败时可重试', async () => {
        await render({ data: null, error: true });

        const retry = [...container.querySelectorAll('button')]
            .find(button => button.textContent?.includes('重试'));
        expect(retry).toBeDefined();
        await act(async () => retry?.click());
        expect(mocks.reload).toHaveBeenCalledOnce();
    });

    it('无已确认考试时显示空状态和试卷入口', async () => {
        await render({
            data: {
                range: '90d',
                summary: {
                    examCount: 0,
                    averageRate: null,
                    latestRate: null,
                    changeFromPrevious: null,
                    wrongCount: 0,
                },
                points: [],
            },
        });

        expect(container.textContent).toContain('暂无考试趋势');
        expect(container.textContent).toContain('确认一次考试成绩后显示趋势');
        expect(container.querySelector('a')?.getAttribute('href')).toBe('/exams');
    });

    it('直接展示 API 摘要并提供逐次考试详情链接', async () => {
        await render({ data });

        expect(container.textContent).toContain('考试次数3');
        expect(container.textContent).toContain('平均得分率73.3%');
        expect(container.textContent).toContain('最近一次90%');
        expect(container.textContent).toContain('较上一次+10.0 个百分点');
        expect(container.textContent).toContain('累计错题3');
        expect(container.textContent).toContain('家庭数学周测');
        expect(container.textContent).toContain('17 / 50');
        expect(container.textContent).toContain('34%');
        expect(container.textContent).toContain('错题 2 道');
        const detail = [...container.querySelectorAll('a')]
            .find(link => link.getAttribute('href') === '/exam-attempts/attempt-1');
        expect(detail?.getAttribute('aria-label'))
            .toBe('查看 家庭数学周测（2026-11-01，17 / 50）的作答详情');
    });

    it('单次考试不虚构变化，负变化保留负号', async () => {
        const single: ExamTrendStatsData = {
            ...data,
            summary: { ...data.summary, examCount: 1, changeFromPrevious: null },
            points: data.points.slice(0, 1),
        };
        await render({ data: single });
        expect(container.textContent).toContain('较上一次—');

        await render({
            data: {
                ...single,
                summary: { ...single.summary, changeFromPrevious: -5 },
            },
        });
        expect(container.textContent).toContain('较上一次-5.0 个百分点');
    });
});
