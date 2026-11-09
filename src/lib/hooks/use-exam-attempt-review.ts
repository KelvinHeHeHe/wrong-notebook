"use client";

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ApiError, apiClient } from '@/lib/api-client';
import { answerDraft, draftChanges, validDraft } from '@/lib/exam/exam-attempt-review-client';
import type { ExamAnswerDraft } from '@/lib/exam/exam-attempt-review-client';
import type { ExamAttemptAnswerUpdate, ExamAttemptAnswerUpdateResponse, ExamAttemptDetail, ExamPaperDetail } from '@/types/api';

type Phase = 'save' | 'saveAll' | 'map' | 'unmap' | 'regrade' | 'retry' | 'confirm' | 'reload' | null;
type Notice = 'saved' | 'mappedNotice' | 'unmappedNotice' | 'regraded' | 'retried' | null;
type Failure = 'loadFailed' | 'conflict' | 'error' | 'refreshFailed' | 'candidateNotMapped' | null;
interface ReviewData { attempt: ExamAttemptDetail; paper: ExamPaperDetail }
interface ReviewState {
    id: string;
    data: ReviewData | null;
    drafts: Record<string, ExamAnswerDraft>;
    phase: Phase;
    notice: Notice;
    error: Failure;
    stale: boolean;
}

export function useExamAttemptReview(attemptId: string, language: 'zh' | 'en') {
    const router = useRouter();
    const [state, setState] = useState<ReviewState>({ id: attemptId, data: null, drafts: {}, phase: null, notice: null, error: null, stale: false });
    const current = useRef<ReviewData | null>(null);
    const generation = useRef(0);
    const locked = useRef(false);
    const isCurrent = (token: number) => generation.current === token;
    const update = (patch: Partial<ReviewState>) => setState((value) => ({ ...value, ...patch }));

    useEffect(() => {
        const token = ++generation.current;
        locked.current = true;
        current.current = null;
        const load = async () => {
            try {
                const attempt = await apiClient.get<ExamAttemptDetail>(`/api/exam-attempts/${attemptId}?includePages=1`);
                if (!isCurrent(token)) return;
                const paper = await apiClient.get<ExamPaperDetail>(`/api/exams/${attempt.paperId}`);
                if (!isCurrent(token)) return;
                current.current = { attempt, paper };
                setState({ id: attemptId, data: current.current, drafts: {}, phase: null, notice: null, error: null, stale: false });
            } catch {
                if (isCurrent(token)) setState({ id: attemptId, data: null, drafts: {}, phase: null, notice: null, error: 'loadFailed', stale: true });
            } finally { if (isCurrent(token)) locked.current = false; }
        };
        void load();
        return () => { generation.current += 1; };
    }, [attemptId]);

    const refresh = async (token: number) => {
        const cache = current.current;
        const attempt = await apiClient.get<ExamAttemptDetail>(`/api/exam-attempts/${attemptId}${cache ? '' : '?includePages=1'}`);
        if (!isCurrent(token)) return;
        const paper = await apiClient.get<ExamPaperDetail>(`/api/exams/${attempt.paperId}`);
        if (!isCurrent(token)) return;
        const pages = attempt.pages.map((page) => ({ ...page, imageData: page.imageData ?? cache?.attempt.pages.find((item) => item.id === page.id && item.checksum === page.checksum)?.imageData }));
        current.current = { attempt: { ...attempt, pages }, paper };
        update({ id: attemptId, data: current.current, stale: false });
    };

    const write = async (phase: Phase, operation: (token: number) => Promise<void>, notice: Notice = null) => {
        if (locked.current || !current.current || state.stale || current.current.attempt.status === 'confirmed') return;
        locked.current = true;
        const token = generation.current;
        update({ phase, notice: null, error: null });
        let completed = false;
        try {
            await operation(token);
            if (!isCurrent(token)) return;
            completed = phase === 'confirm';
            update({ notice });
        } catch (error) {
            if (!isCurrent(token)) return;
            // 请求失败也可能已写入服务端；重新读取版本，禁止用旧草稿覆盖已落库结果。
            update({ drafts: {} });
            try {
                await refresh(token);
                if (isCurrent(token)) {
                    const notMapped = error instanceof ApiError && error.status === 400 && error.data && typeof error.data === 'object'
                        && 'message' in error.data && error.data.message === 'EXAM_ATTEMPT_CANDIDATE_NOT_MAPPED';
                    update({ error: error instanceof ApiError && error.status === 409 ? 'conflict' : notMapped ? 'candidateNotMapped' : 'error' });
                }
            } catch { if (isCurrent(token)) update({ error: 'refreshFailed', stale: true }); }
        } finally {
            if (isCurrent(token) && !completed) { locked.current = false; update({ phase: null }); }
        }
    };

    const patchAnswer = async (answerId: string, changes: ExamAttemptAnswerUpdate, token: number) => {
        const data = current.current!;
        const response = await apiClient.patch<ExamAttemptAnswerUpdateResponse>(`/api/exam-attempts/${attemptId}/answers/${answerId}`, { ...changes, expectedUpdatedAt: data.attempt.updatedAt }, { recoverable: true, timeout: 600_000 });
        if (!isCurrent(token)) return;
        current.current = { ...data, attempt: { ...data.attempt, status: 'review', updatedAt: response.updatedAt, answers: data.attempt.answers.map((answer) => answer.id === answerId ? response.answer : answer) } };
        setState((value) => {
            const drafts = { ...value.drafts };
            delete drafts[answerId];
            return { ...value, data: current.current, drafts };
        });
    };

    const edit = (answerId: string, field: keyof ExamAnswerDraft, value: string) => {
        if (locked.current || state.stale || current.current?.attempt.status === 'confirmed') return;
        const answer = current.current?.attempt.answers.find((item) => item.id === answerId);
        if (!answer) return;
        setState((previous) => ({ ...previous, notice: null, drafts: { ...previous.drafts, [answerId]: { ...(previous.drafts[answerId] ?? answerDraft(answer)), [field]: value } } }));
    };
    const save = (answerId: string) => {
        const answer = current.current?.attempt.answers.find((item) => item.id === answerId);
        const draft = state.drafts[answerId] ?? (answer ? answerDraft(answer) : null);
        if (draft && validDraft(draft)) return write('save', (token) => patchAnswer(answerId, draftChanges(draft), token), 'saved');
    };
    const saveAll = () => {
        const drafts = Object.entries(state.drafts);
        if (!drafts.length || drafts.some(([, draft]) => !validDraft(draft))) return;
        return write('saveAll', async (token) => {
            for (const [id, draft] of drafts) {
                if (!isCurrent(token)) return;
                await patchAnswer(id, draftChanges(draft), token);
            }
        }, 'saved');
    };
    const regrade = (answerId: string) => {
        const answer = current.current?.attempt.answers.find((item) => item.id === answerId);
        if (!answer) return;
        const draft = state.drafts[answerId] ?? answerDraft(answer);
        return write('regrade', (token) => patchAnswer(answerId, { recognizedAnswer: draft.recognizedAnswer, maxScore: draftChanges(draft).maxScore, regrade: true }, token), 'regraded');
    };
    const mapCandidate = (answerId: string, pageOrder: number, candidateId: string) => {
        if (Object.keys(state.drafts).length) return;
        return write('map', async (token) => { await patchAnswer(answerId, { candidateRef: { pageOrder, candidateId } }, token); if (isCurrent(token)) await refresh(token); }, 'mappedNotice');
    };
    const unmapCandidate = (answerId: string) => {
        if (Object.keys(state.drafts).length) return;
        return write('unmap', async (token) => {
            await patchAnswer(answerId, { candidateRef: null }, token);
            if (isCurrent(token)) await refresh(token);
        }, 'unmappedNotice');
    };
    const retryPage = (pageOrder: number) => {
        if (Object.keys(state.drafts).length) return;
        return write('retry', async (token) => {
            await apiClient.post(`/api/exam-attempts/${attemptId}/recognize`, { expectedUpdatedAt: current.current!.attempt.updatedAt, pageOrders: [pageOrder], language }, { recoverable: true, timeout: 600_000 });
            if (isCurrent(token)) await refresh(token);
        }, 'retried');
    };
    const confirm = () => write('confirm', async (token) => {
        await apiClient.post(`/api/exam-attempts/${attemptId}/confirm`, { expectedUpdatedAt: current.current!.attempt.updatedAt });
        if (isCurrent(token)) router.push(`/exams/${current.current!.attempt.paperId}`);
    });
    const reload = async () => {
        if (locked.current) return;
        locked.current = true;
        const token = generation.current;
        update({ phase: 'reload', error: null, drafts: {} });
        try { await refresh(token); }
        catch { if (isCurrent(token)) update({ error: 'refreshFailed', stale: true }); }
        finally { if (isCurrent(token)) { locked.current = false; update({ phase: null }); } }
    };
    return { ...(state.id === attemptId ? state : { ...state, data: null, error: null, drafts: {} }), busy: state.phase !== null, edit, save, saveAll, regrade, mapCandidate, unmapCandidate, retryPage, confirm, reload };
}
