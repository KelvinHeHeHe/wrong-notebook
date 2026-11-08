"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiClient } from '@/lib/api-client';
import { createAndRecognizeExamImport, prepareExamImportFiles } from '@/lib/exam/exam-import-client';
import { getApiErrorMessage, getErrorMessage } from '@/lib/error-message';
import type { PreparedExamImportPage } from '@/lib/exam/exam-import-client';
import type { CreateImportedExamInput } from '@/lib/schemas/exam';

type ImportPhase = 'idle' | 'preparing' | 'ready' | 'creating' | 'recognizing' | 'error';

export type ExamImportMetadata = Omit<CreateImportedExamInput, 'pages' | 'sourceFileName'>;

export function useExamImport(language: 'zh' | 'en') {
    const router = useRouter();
    const [pages, setPages] = useState<PreparedExamImportPage[]>([]);
    const [phase, setPhase] = useState<ImportPhase>('idle');
    const [error, setError] = useState<string | null>(null);
    const [sourceFileName, setSourceFileName] = useState<string | null>(null);

    const prepareFiles = async (files: File[]) => {
        setPhase('preparing');
        setError(null);
        try {
            const prepared = await prepareExamImportFiles(files);
            setPages(prepared);
            setSourceFileName(files.map((file) => file.name).join(', ').slice(0, 255));
            setPhase('ready');
        } catch (cause) {
            setPages([]);
            setSourceFileName(null);
            setError(getErrorMessage(cause));
            setPhase('error');
        }
    };

    const reorder = (nextPages: PreparedExamImportPage[]) => {
        setPages(nextPages.map((page, index) => ({ ...page, order: index + 1 })));
    };

    const movePage = (index: number, offset: -1 | 1) => {
        const target = index + offset;
        if (target < 0 || target >= pages.length) return;
        const next = [...pages];
        [next[index], next[target]] = [next[target], next[index]];
        reorder(next);
    };

    const removePage = (index: number) => reorder(pages.filter((_, pageIndex) => pageIndex !== index));

    const submit = async (metadata: ExamImportMetadata) => {
        if (pages.length === 0) return;
        setPhase('creating');
        setError(null);
        try {
            const result = await createAndRecognizeExamImport({
                ...metadata,
                sourceFileName,
                language,
                pages,
            }, {
                createExam: (input) => apiClient.post<{ paperId: string }, CreateImportedExamInput>('/api/exams/import', input),
                recognizePages: async (paperId, pageOrders, requestLanguage) => {
                    setPhase('recognizing');
                    return apiClient.post(`/api/exams/${paperId}/recognize`, {
                        pageOrders,
                        language: requestLanguage,
                    }, { recoverable: true, timeout: 600_000 });
                },
            });
            router.push(`/exams/${result.paperId}/import?failed=${result.failures.length}`);
        } catch (cause) {
            setError(getApiErrorMessage(cause) ?? getErrorMessage(cause));
            setPhase('error');
        }
    };

    return { pages, phase, error, prepareFiles, movePage, removePage, submit };
}
