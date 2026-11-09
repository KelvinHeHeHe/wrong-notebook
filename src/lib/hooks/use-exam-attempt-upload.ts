"use client";

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiClient } from '@/lib/api-client';
import { getApiErrorMessage, getErrorMessage } from '@/lib/error-message';
import { createAndRecognizeExamAttempt, prepareExamAttemptPhotos } from '@/lib/exam/exam-attempt-client';
import { frontendLogger } from '@/lib/frontend-logger';
import type { ExamAttemptUploadCheckpoint, PreparedExamAttemptPhoto } from '@/lib/exam/exam-attempt-client';
import type { CreateExamAttemptInput } from '@/lib/schemas/exam-attempt';
import type { ExamAttemptVersion } from '@/types/api';

type UploadPhase = 'idle' | 'preparing' | 'ready' | 'creating' | 'uploading' | 'recognizing' | 'error' | 'complete';

export function useExamAttemptUpload(paperId: string, language: 'zh' | 'en') {
    const router = useRouter();
    const [pages, setPages] = useState<PreparedExamAttemptPhoto[]>([]);
    const [phase, setPhase] = useState<UploadPhase>('idle');
    const [error, setError] = useState<string | null>(null);
    const [attemptId, setAttemptId] = useState<string | null>(null);
    const checkpoint = useRef<ExamAttemptUploadCheckpoint | undefined>(undefined);
    const locked = useRef(false);

    const prepareFiles = async (files: File[]) => {
        if (locked.current || checkpoint.current) return;
        locked.current = true;
        setPhase('preparing');
        setError(null);
        try {
            setPages(await prepareExamAttemptPhotos(files));
            setPhase('ready');
        } catch (cause) {
            setPages([]);
            setError(getErrorMessage(cause));
            setPhase('error');
        } finally {
            locked.current = false;
        }
    };

    const reorder = (next: PreparedExamAttemptPhoto[]) => setPages(next.map((page, index) => ({ ...page, order: index + 1 })));
    const movePage = (index: number, offset: -1 | 1) => {
        if (locked.current || checkpoint.current) return;
        const target = index + offset;
        if (target < 0 || target >= pages.length) return;
        const next = [...pages];
        [next[index], next[target]] = [next[target], next[index]];
        reorder(next);
    };
    const removePage = (index: number) => {
        if (!locked.current && !checkpoint.current) reorder(pages.filter((_, current) => current !== index));
    };

    const submit = async (metadata: CreateExamAttemptInput) => {
        if (locked.current || pages.length === 0) return;
        locked.current = true;
        let completed = false;
        setPhase(checkpoint.current ? 'uploading' : 'creating');
        setError(null);
        try {
            const result = await createAndRecognizeExamAttempt({ paperId, language, pages, ...metadata, checkpoint: checkpoint.current }, {
                createAttempt: (id, input) => apiClient.post(`/api/exams/${id}/attempts`, input),
                getAttempt: (id) => apiClient.get<ExamAttemptVersion>(`/api/exam-attempts/${id}`),
                uploadPages: (id, input) => {
                    setPhase('uploading');
                    return apiClient.post(`/api/exam-attempts/${id}/pages`, input);
                },
                recognizePages: (id, input) => {
                    setPhase('recognizing');
                    return apiClient.post(`/api/exam-attempts/${id}/recognize`, input, { recoverable: true, timeout: 600_000 });
                },
                onCheckpoint: (value) => {
                    checkpoint.current = value;
                    setAttemptId(value.attemptId);
                },
            });
            completed = true;
            setPhase('complete');
            router.push(`/exam-attempts/${result.attemptId}`);
        } catch (cause) {
            const message = getApiErrorMessage(cause) ?? getErrorMessage(cause);
            setError(message);
            setPhase('error');
            // 网络错误可能携带请求正文；仅记录固定错误码，不记录照片、答案或异常原文。
            frontendLogger.error('[ExamAttemptUpload]', '纸质作答回传失败', { errorCode: 'EXAM_ATTEMPT_UPLOAD_FAILED' });
        } finally {
            if (!completed) locked.current = false;
        }
    };

    const busy = ['preparing', 'creating', 'uploading', 'recognizing', 'complete'].includes(phase);
    return { pages, phase, busy, error, attemptId, prepareFiles, movePage, removePage, submit };
}
