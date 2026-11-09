"use client";

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiClient } from '@/lib/api-client';
import { getApiErrorMessage, getErrorMessage } from '@/lib/error-message';
import { createAndRecognizeExamAttempt, prepareExamAttemptPhotos } from '@/lib/exam/exam-attempt-client';
import { frontendLogger } from '@/lib/frontend-logger';
import type { ExamAttemptUploadCheckpoint, PreparedExamAttemptPhoto } from '@/lib/exam/exam-attempt-client';
import type { CreateExamAttemptInput } from '@/lib/schemas/exam-attempt';
import type { ExamAttemptVersion } from '@/types/api';

type UploadPhase = 'idle' | 'preparing' | 'ready' | 'creating' | 'uploading' | 'recognizing' | 'error' | 'complete';
interface UploadState {
    pages: PreparedExamAttemptPhoto[];
    phase: UploadPhase;
    error: string | null;
    attemptId: string | null;
}
const EMPTY_STATE: UploadState = { pages: [], phase: 'idle', error: null, attemptId: null };

export function useExamAttemptUpload(paperId: string, language: 'zh' | 'en') {
    const router = useRouter();
    const [state, setState] = useState<UploadState>(EMPTY_STATE);
    const { pages, phase } = state;
    const checkpoint = useRef<ExamAttemptUploadCheckpoint | undefined>(undefined);
    const locked = useRef(false);
    const mounted = useRef(false);
    const operationId = useRef(0);

    useEffect(() => {
        mounted.current = true;
        operationId.current += 1;
        checkpoint.current = undefined;
        locked.current = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 试卷身份变化时清空上一份作答，防止复用旧照片与异步结果
        setState(EMPTY_STATE);
        return () => { mounted.current = false; operationId.current += 1; };
    }, [paperId]);

    const isCurrent = (operation: number) => mounted.current && operationId.current === operation;
    const patchState = (patch: Partial<UploadState>) => setState((current) => ({ ...current, ...patch }));

    const prepareFiles = async (files: File[]) => {
        if (!mounted.current || locked.current || checkpoint.current) return;
        const operation = ++operationId.current;
        locked.current = true;
        patchState({ phase: 'preparing', error: null });
        try {
            const prepared = await prepareExamAttemptPhotos(files);
            if (!isCurrent(operation)) return;
            patchState({ pages: prepared, phase: 'ready' });
        } catch (cause) {
            if (!isCurrent(operation)) return;
            patchState({ pages: [], error: getErrorMessage(cause), phase: 'error' });
        } finally {
            if (isCurrent(operation)) locked.current = false;
        }
    };

    const reorder = (next: PreparedExamAttemptPhoto[]) => patchState({ pages: next.map((page, index) => ({ ...page, order: index + 1 })) });
    const movePage = (index: number, offset: -1 | 1) => {
        if (!mounted.current || locked.current || checkpoint.current) return;
        const target = index + offset;
        if (target < 0 || target >= pages.length) return;
        const next = [...pages];
        [next[index], next[target]] = [next[target], next[index]];
        reorder(next);
    };
    const removePage = (index: number) => {
        if (mounted.current && !locked.current && !checkpoint.current) reorder(pages.filter((_, current) => current !== index));
    };

    const submit = async (metadata: CreateExamAttemptInput) => {
        if (!mounted.current || locked.current || pages.length === 0) return;
        const operation = ++operationId.current;
        const assertActive = () => {
            if (!isCurrent(operation)) throw new Error('EXAM_ATTEMPT_OPERATION_CANCELLED');
        };
        locked.current = true;
        let completed = false;
        patchState({ phase: checkpoint.current ? 'uploading' : 'creating', error: null });
        try {
            const result = await createAndRecognizeExamAttempt({ paperId, language, pages, ...metadata, checkpoint: checkpoint.current }, {
                assertActive,
                createAttempt: (id, input) => { assertActive(); return apiClient.post(`/api/exams/${id}/attempts`, input); },
                getAttempt: (id) => { assertActive(); return apiClient.get<ExamAttemptVersion>(`/api/exam-attempts/${id}`); },
                uploadPages: (id, input) => {
                    assertActive();
                    patchState({ phase: 'uploading' });
                    return apiClient.post(`/api/exam-attempts/${id}/pages`, input);
                },
                recognizePages: (id, input) => {
                    assertActive();
                    patchState({ phase: 'recognizing' });
                    return apiClient.post(`/api/exam-attempts/${id}/recognize`, input, { recoverable: true, timeout: 600_000 });
                },
                onCheckpoint: (value) => {
                    assertActive();
                    checkpoint.current = value;
                    patchState({ attemptId: value.attemptId });
                },
            });
            assertActive();
            completed = true;
            patchState({ phase: 'complete' });
            router.push(`/exam-attempts/${result.attemptId}`);
        } catch (cause) {
            if (!isCurrent(operation)) return;
            const message = getApiErrorMessage(cause) ?? getErrorMessage(cause);
            patchState({ error: message, phase: 'error' });
            // 网络错误可能携带请求正文；仅记录固定错误码，不记录照片、答案或异常原文。
            frontendLogger.error('[ExamAttemptUpload]', '纸质作答回传失败', { errorCode: 'EXAM_ATTEMPT_UPLOAD_FAILED' });
        } finally {
            if (isCurrent(operation) && !completed) locked.current = false;
        }
    };

    const busy = ['preparing', 'creating', 'uploading', 'recognizing', 'complete'].includes(phase);
    return { ...state, busy, prepareFiles, movePage, removePage, submit };
}
