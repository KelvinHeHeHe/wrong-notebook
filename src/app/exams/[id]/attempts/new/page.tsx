"use client";

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

import { ExamAttemptUploadForm } from '@/components/exam-attempt/exam-attempt-upload-form';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoading } from '@/components/ui/page-loading';
import { useLanguage } from '@/contexts/LanguageContext';
import { apiClient } from '@/lib/api-client';
import { en } from '@/lib/i18n/en';
import { usePageTitle } from '@/lib/page-title';
import type { ExamPaperDetail } from '@/types/api';

export default function NewExamAttemptPage() {
    const { id } = useParams<{ id: string }>();
    const { t } = useLanguage();
    const text = t.examAttempt ?? en.examAttempt;
    const [loaded, setLoaded] = useState<{ paperId: string; paper: ExamPaperDetail } | null>(null);
    const [failedId, setFailedId] = useState<string | null>(null);
    const paper = loaded?.paperId === id ? loaded.paper : null;
    const failed = failedId === id;
    usePageTitle(text.title, paper?.title);
    useEffect(() => {
        let active = true;
        apiClient.get<ExamPaperDetail>(`/api/exams/${id}`).then((value) => { if (active) setLoaded({ paperId: id, paper: value }); }).catch(() => { if (active) setFailedId(id); });
        return () => { active = false; };
    }, [id]);

    if (!paper && !failed) return <PageLoading label={t.common.loading} />;
    return <main className="mx-auto min-h-screen max-w-4xl px-4 py-6 md:px-8 md:py-8">
        <div className="space-y-6">
            <PageHeader title={text.title} description={paper?.title} backHref={`/exams/${id}`} />
            <p className="text-sm text-muted-foreground">{text.subtitle}</p>
            {failed ? <p role="alert">{text.loadFailed}</p> : paper?.status !== 'ready' ? <p role="alert">{text.notReady}</p> : <ExamAttemptUploadForm paperId={id} />}
        </div>
    </main>;
}
