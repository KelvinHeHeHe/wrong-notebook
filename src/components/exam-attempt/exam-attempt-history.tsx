"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTimeZone } from '@/contexts/TimeZoneContext';
import { en } from '@/lib/i18n/en';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/date-time';
import { sortExamAttemptHistory } from '@/lib/exam/exam-attempt-client';
import { formatExamScore } from '@/lib/exam/exam-score';
import type { ExamAttemptSummary } from '@/types/api';

interface ExamAttemptHistoryProps {
    paperId: string;
}

export function ExamAttemptHistory({ paperId }: ExamAttemptHistoryProps) {
    const { t } = useLanguage();
    const { timeZone } = useTimeZone();
    const text = t.examAttempt ?? en.examAttempt;
    const [attempts, setAttempts] = useState<ExamAttemptSummary[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let active = true;
        apiClient.get<ExamAttemptSummary[]>(`/api/exams/${paperId}/attempts`).then((value) => {
            if (active) setAttempts(sortExamAttemptHistory(Array.isArray(value) ? value : []));
        }).catch(() => { if (active) setFailed(true); });
        return () => { active = false; };
    }, [paperId]);

    return <section aria-label={text.history} className="space-y-3 rounded-xl border p-4">
        <h2 className="font-semibold">{text.history}</h2>
        {failed ? <p role="alert" className="text-sm text-destructive">{text.historyLoadFailed}</p> : attempts === null ? <p className="text-sm text-muted-foreground">{t.common.loading}</p> : attempts.length === 0 ? <p className="text-sm text-muted-foreground">{text.emptyHistory}</p> : <ol className="space-y-3">
            {attempts.map((attempt) => <li key={attempt.id} className="flex flex-col gap-2 border-t pt-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                    <span>{formatDateTime(attempt.takenAt, 'yyyy-MM-dd', timeZone)}</span>
                    <Badge variant="secondary">{text.statuses[attempt.status]}</Badge>
                    <span>{attempt.totalScore === null ? text.unscored : text.score.replace('{score}', formatExamScore(attempt.totalScore)).replace('{max}', attempt.maxScore === null ? '—' : formatExamScore(attempt.maxScore))}</span>
                </div>
                <Link className="shrink-0 underline underline-offset-4" href={`/exam-attempts/${attempt.id}`}>{attempt.status === 'confirmed' ? text.viewAttempt : text.continueReview}</Link>
            </li>)}
        </ol>}
    </section>;
}
