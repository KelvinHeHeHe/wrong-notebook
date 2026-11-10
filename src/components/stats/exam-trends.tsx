"use client";

import Link from "next/link";
import { BarChart3, ClipboardList, Target, TrendingUp, TriangleAlert } from "lucide-react";

import { ExamTrendChart } from "@/components/stats/exam-trend-chart";
import { ExamTrendList } from "@/components/stats/exam-trend-list";
import { StatCard } from "@/components/stats/stat-card";
import { StatsEmpty, StatsError } from "@/components/stats/stats-state";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useStatsData } from "@/lib/hooks/use-stats-data";

import type { ExamTrendStatsData } from "@/types/api";

function formatRate(value: number | null): string {
    if (value === null) return '—';
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

function formatChange(value: number | null, unit: string): string {
    if (value === null) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(1)} ${unit}`;
}

export function ExamTrends({ url }: { url: string }) {
    const { t } = useLanguage();
    const { data, loading, error, reload } = useStatsData<ExamTrendStatsData>(url);
    const copy = t.stats?.examTrends;

    if (loading) {
        return (
            <div
                role="status"
                aria-label={copy?.loading || "Loading exam trends"}
                className="flex justify-center p-8"
            >
                <BarChart3 className="h-8 w-8 animate-pulse text-muted-foreground" />
            </div>
        );
    }
    if (error) return <StatsError onRetry={reload} />;
    if (!data || data.points.length === 0) {
        return (
            <StatsEmpty
                icon={ClipboardList}
                title={copy?.emptyTitle || "No Exam Trends Yet"}
                description={copy?.emptyDescription || "Confirm an exam score to start tracking trends."}
                action={(
                    <Button asChild variant="outline" size="sm">
                        <Link href="/exams">{copy?.goToExams || "Go to Exams"}</Link>
                    </Button>
                )}
            />
        );
    }

    const unit = copy?.changeUnit || "percentage points";
    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl font-bold tracking-tight">{copy?.title || "Exam Trends"}</h2>
                <p className="text-sm text-muted-foreground">
                    {copy?.description || "Track score changes across confirmed exams"}
                </p>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5 lg:gap-4">
                <StatCard title={copy?.examCount || "Exams"} value={data.summary.examCount} icon={ClipboardList} />
                <StatCard title={copy?.averageRate || "Average Score Rate"} value={formatRate(data.summary.averageRate)} icon={Target} />
                <StatCard title={copy?.latestRate || "Latest Score Rate"} value={formatRate(data.summary.latestRate)} icon={BarChart3} />
                <StatCard title={copy?.changeFromPrevious || "Change"} value={formatChange(data.summary.changeFromPrevious, unit)} icon={TrendingUp} />
                <StatCard title={copy?.totalWrong || "Total Incorrect"} value={data.summary.wrongCount} icon={TriangleAlert} />
            </div>
            <ExamTrendChart points={data.points} />
            <ExamTrendList points={data.points} />
        </div>
    );
}
