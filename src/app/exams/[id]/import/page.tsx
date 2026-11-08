"use client";

import { useParams } from 'next/navigation';

import { ExamImportReview } from '@/components/exam-import/exam-import-review';
import { PageHeader } from '@/components/ui/page-header';
import { useLanguage } from '@/contexts/LanguageContext';
import { usePageTitle } from '@/lib/page-title';

export default function ImportedExamReviewPage() {
    const params = useParams();
    const { t } = useLanguage();
    const paperId = params.id as string;
    usePageTitle(t.examImport.review.title);

    return (
        <main className="mx-auto min-h-screen max-w-5xl px-4 py-6 md:px-8 md:py-8">
            <div className="space-y-6">
                <PageHeader title={t.examImport.review.title} description={t.examImport.review.subtitle} backHref="/exams" />
                <ExamImportReview paperId={paperId} />
            </div>
        </main>
    );
}
