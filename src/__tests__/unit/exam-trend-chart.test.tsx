import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ExamTrendChart,
    ExamTrendDot,
    ExamTrendTooltip,
} from '@/components/stats/exam-trend-chart';
import type { ExamTrendPoint } from '@/types/api';

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    chartData: [] as ExamTrendPoint[],
    yDomain: undefined as unknown,
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: mocks.push }),
}));

vi.mock('@/contexts/LanguageContext', () => ({
    useLanguage: () => ({
        t: {
            stats: {
                examTrends: {
                    chartTitle: '得分率趋势',
                    score: '得分',
                    rate: '得分率',
                    wrongCount: '错题 {count} 道',
                    pointAria: '{title}，{date}，得分率 {rate}%',
                },
            },
        },
    }),
}));

vi.mock('recharts', async () => {
    const React = await import('react');
    return {
        ResponsiveContainer: ({ children }: { children: React.ReactNode }) => children,
        LineChart: ({ data, children }: { data: ExamTrendPoint[]; children: React.ReactNode }) => {
            mocks.chartData = data;
            return React.createElement('svg', null, children);
        },
        CartesianGrid: () => null,
        XAxis: () => null,
        YAxis: ({ domain }: { domain: unknown }) => {
            mocks.yDomain = domain;
            return null;
        },
        Tooltip: () => null,
        Line: ({ dot }: {
            dot: React.ReactElement<{
                cx?: number;
                cy?: number;
                payload?: ExamTrendPoint;
            }>;
        }) => React.cloneElement(dot, {
            cx: 20,
            cy: 20,
            payload: mocks.chartData[0],
        }),
    };
});

const point: ExamTrendPoint = {
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
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.yDomain = undefined;
    mocks.chartData = [];
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

describe('ExamTrendChart', () => {
    it('纵轴固定为 0 到 100 且渲染可操作数据点', async () => {
        await act(async () => root.render(<ExamTrendChart points={[point]} />));

        expect(mocks.yDomain).toEqual([0, 100]);
        const dot = container.querySelector('[role="link"]') as SVGCircleElement;
        expect(dot.getAttribute('tabindex')).toBe('0');
        expect(dot.getAttribute('aria-label')).toBe('家庭数学周测，2026-11-01，得分率 34%');

        await act(async () => dot.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(mocks.push).toHaveBeenLastCalledWith('/exam-attempts/attempt-1');
    });

    it('数据点支持 Enter 和 Space 键导航', async () => {
        await act(async () => root.render(
            <svg><ExamTrendDot cx={10} cy={10} payload={point} /></svg>,
        ));
        const dot = container.querySelector('[role="link"]') as SVGCircleElement;

        await act(async () => dot.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
        })));
        await act(async () => dot.dispatchEvent(new KeyboardEvent('keydown', {
            key: ' ',
            bubbles: true,
        })));

        expect(mocks.push).toHaveBeenNthCalledWith(1, '/exam-attempts/attempt-1');
        expect(mocks.push).toHaveBeenNthCalledWith(2, '/exam-attempts/attempt-1');
    });

    it('Tooltip 展示原始得分、得分率和错题数', async () => {
        await act(async () => root.render(
            <ExamTrendTooltip active payload={[{ payload: point }]} />,
        ));

        expect(container.textContent).toContain('家庭数学周测');
        expect(container.textContent).toContain('17 / 50');
        expect(container.textContent).toContain('34%');
        expect(container.textContent).toContain('错题 2 道');
    });
});
