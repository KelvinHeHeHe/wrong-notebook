"use client";

import { ExamImportForm } from '@/components/exam-import/exam-import-form';
import { PageHeader } from '@/components/ui/page-header';
import { useLanguage } from '@/contexts/LanguageContext';
import { usePageTitle } from '@/lib/page-title';

export default function ExamImportPage() {
    const { t } = useLanguage();
    usePageTitle(t.examImport.title);

    return (
        <main className="mx-auto min-h-screen max-w-4xl px-4 py-6 md:px-8 md:py-8">
            <div className="space-y-6">
                <PageHeader title={t.examImport.title} description={t.examImport.subtitle} backHref="/exams" />
                <ExamImportForm />
            </div>
        </main>
    );
}
