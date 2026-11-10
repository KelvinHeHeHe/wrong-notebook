"use client";

import type { KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import {
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    CHART_AXIS_COLOR,
    CHART_GRID_COLOR,
    EXAM_TREND_COLOR,
} from "@/components/stats/chart-colors";

import type { ExamTrendPoint } from "@/types/api";

interface ExamTrendDotProps {
    cx?: number;
    cy?: number;
    payload?: ExamTrendPoint;
}

interface ExamTrendTooltipProps {
    active?: boolean;
    payload?: Array<{ payload?: ExamTrendPoint }>;
}

function replaceTokens(template: string, values: Record<string, string>): string {
    return Object.entries(values).reduce(
        (result, [key, value]) => result.replace(`{${key}}`, value),
        template,
    );
}

function formatRate(rate: number): string {
    return Number.isInteger(rate) ? rate.toFixed(0) : rate.toFixed(1);
}

export function ExamTrendDot({ cx, cy, payload }: ExamTrendDotProps) {
    const router = useRouter();
    const { t } = useLanguage();
    if (cx === undefined || cy === undefined || !payload) return null;

    const pointAria = t.stats?.examTrends?.pointAria
        || "{title}, {date}, score rate {rate}%";
    const ariaLabel = replaceTokens(pointAria, {
        title: payload.paperTitle,
        date: payload.dateLabel,
        rate: formatRate(payload.rate),
    });
    const openAttempt = () => router.push(`/exam-attempts/${payload.attemptId}`);
    const handleKeyDown = (event: KeyboardEvent<SVGCircleElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openAttempt();
    };

    return (
        <circle
            cx={cx}
            cy={cy}
            r={5}
            fill={EXAM_TREND_COLOR}
            stroke="var(--background)"
            strokeWidth={2}
            role="link"
            tabIndex={0}
            aria-label={ariaLabel}
            className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={openAttempt}
            onKeyDown={handleKeyDown}
        />
    );
}

export function ExamTrendTooltip({ active, payload }: ExamTrendTooltipProps) {
    const { t } = useLanguage();
    const point = payload?.[0]?.payload;
    if (!active || !point) return null;

    const wrongTemplate = t.stats?.examTrends?.wrongCount || "{count} incorrect";
    return (
        <div className="rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
            <p className="font-medium">{point.paperTitle}</p>
            <p className="text-xs text-muted-foreground">{point.dateLabel}</p>
            <div className="mt-2 space-y-1">
                <p>{t.stats?.examTrends?.score || "Score"}: {point.totalScore} / {point.maxScore}</p>
                <p>{t.stats?.examTrends?.rate || "Score Rate"}: {formatRate(point.rate)}%</p>
                <p>{replaceTokens(wrongTemplate, { count: String(point.wrongCount) })}</p>
            </div>
        </div>
    );
}

export function ExamTrendChart({ points }: { points: ExamTrendPoint[] }) {
    const { t } = useLanguage();
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t.stats?.examTrends?.chartTitle || "Score Rate Trend"}</CardTitle>
            </CardHeader>
            <CardContent className="h-[320px] px-2 sm:px-6">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={points} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_COLOR} />
                        <XAxis
                            dataKey="dateLabel"
                            axisLine={false}
                            tickLine={false}
                            tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }}
                            minTickGap={20}
                        />
                        <YAxis
                            domain={[0, 100]}
                            tickFormatter={value => `${value}%`}
                            axisLine={false}
                            tickLine={false}
                            tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }}
                            width={42}
                        />
                        <Tooltip content={<ExamTrendTooltip />} />
                        <Line
                            type="monotone"
                            dataKey="rate"
                            stroke={EXAM_TREND_COLOR}
                            strokeWidth={2.5}
                            dot={<ExamTrendDot />}
                            activeDot={<ExamTrendDot />}
                            isAnimationActive={false}
                        />
                    </LineChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    );
}
