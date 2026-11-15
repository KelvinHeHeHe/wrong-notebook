"use client";

import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";

import type { ExamTrendPoint } from "@/types/api";

function replaceTokens(template: string, values: Record<string, string>): string {
    return Object.entries(values).reduce(
        (result, [key, value]) => result.replace(`{${key}}`, value),
        template,
    );
}

function formatRate(rate: number): string {
    return Number.isInteger(rate) ? rate.toFixed(0) : rate.toFixed(1);
}

export function ExamTrendList({ points }: { points: ExamTrendPoint[] }) {
    const { t } = useLanguage();
    const copy = t.stats?.examTrends;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{copy?.attemptsTitle || "Exam Attempts"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
                {points.map(point => {
                    const detailAria = replaceTokens(
                        copy?.detailAria || "View {title} attempt from {date}, score {score} / {maxScore}",
                        {
                            title: point.paperTitle,
                            date: point.dateLabel,
                            score: String(point.totalScore),
                            maxScore: String(point.maxScore),
                        },
                    );
                    const wrongCount = replaceTokens(
                        copy?.wrongCount || "{count} incorrect",
                        { count: String(point.wrongCount) },
                    );
                    return (
                        <Link
                            key={point.attemptId}
                            href={`/exam-attempts/${point.attemptId}`}
                            aria-label={detailAria}
                            className="grid gap-2 rounded-xl border px-3 py-3 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:px-4"
                        >
                            <div className="min-w-0">
                                <p className="truncate font-medium">{point.paperTitle}</p>
                                <p className="text-xs text-muted-foreground">
                                    {[point.subjectName, point.dateLabel].filter(Boolean).join(' · ')}
                                </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                                <span>{point.totalScore} / {point.maxScore}</span>
                                <span className="font-medium text-primary">{formatRate(point.rate)}%</span>
                            </div>
                            <span className="text-sm text-muted-foreground">{wrongCount}</span>
                        </Link>
                    );
                })}
            </CardContent>
        </Card>
    );
}
