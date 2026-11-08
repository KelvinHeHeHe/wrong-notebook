"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { ImportedQuestionFormValue } from '@/components/exam-import/import-question-card';
import { apiClient } from '@/lib/api-client';
import { parseExamRegions } from '@/lib/exam/exam-import';
import { examDateToISOString } from '@/lib/exam/exam-import-client';
import { getApiErrorMessage } from '@/lib/error-message';
import type { Translations } from '@/lib/translations';
import type { ExamPaperDetail, Notebook } from '@/types/api';

function questionToForm(question: ExamPaperDetail['questions'][number]): ImportedQuestionFormValue {
    return {
        key: question.id,
        id: question.id,
        externalNumber: question.externalNumber ?? '',
        pageNumber: question.pageNumber ?? 1,
        regions: parseExamRegions(question.regionJson),
        questionText: question.questionText ?? '',
        answerText: question.answerText ?? '',
        analysis: question.analysis ?? '',
        questionType: question.questionType ?? '',
        score: question.score === null || question.score === undefined ? '' : String(question.score),
    };
}

interface UseExamImportReviewOptions {
    paperId: string;
    language: 'zh' | 'en';
    text: Translations['examImport']['review'];
}

export function useExamImportReview({ paperId, language, text }: UseExamImportReviewOptions) {
    const router = useRouter();
    const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [questions, setQuestions] = useState<ImportedQuestionFormValue[]>([]);
    const [title, setTitle] = useState('');
    const [subjectId, setSubjectId] = useState('');
    const [gradeSemester, setGradeSemester] = useState('');
    const [examType, setExamType] = useState('');
    const [examDate, setExamDate] = useState('');
    const [totalScore, setTotalScore] = useState('');
    const [busy, setBusy] = useState<'save' | 'publish' | `retry-${number}` | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const [loaded, loadedNotebooks] = await Promise.all([
                apiClient.get<ExamPaperDetail>(`/api/exams/${paperId}?includePages=1`),
                apiClient.get<Notebook[]>('/api/notebooks'),
            ]);
            if (loaded.origin !== 'imported' || !loaded.pages) throw new Error('INVALID_IMPORTED_EXAM');
            setPaper(loaded);
            setNotebooks(loadedNotebooks);
            setQuestions(loaded.questions.map(questionToForm));
            setTitle(loaded.title);
            setSubjectId(loaded.subjectId ?? '');
            setGradeSemester(loaded.gradeSemester ?? '');
            setExamType(loaded.examType ?? '');
            setExamDate(loaded.examDate?.slice(0, 10) ?? '');
            setTotalScore(loaded.totalScore === null || loaded.totalScore === undefined ? '' : String(loaded.totalScore));
            setError(null);
        } catch (cause) {
            setError(getApiErrorMessage(cause) ?? text.loadFailed);
        }
    }, [paperId, text.loadFailed]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入校对页后加载服务端草稿
        load();
    }, [load]);

    const pages = useMemo(() => [...(paper?.pages ?? [])].sort((a, b) => a.order - b.order), [paper]);

    const setPageRole = (pageId: string, role: 'questions' | 'answer_key') => {
        const target = pages.find((page) => page.id === pageId);
        setPaper((current) => current ? {
            ...current,
            pages: current.pages?.map((page) => page.id === pageId ? { ...page, role } : page),
        } : current);
        if (target && role === 'answer_key') {
            setQuestions((current) => current.filter((question) => question.pageNumber !== target.order));
        }
    };

    const updateQuestion = (nextQuestion: ImportedQuestionFormValue) => {
        setQuestions((current) => current.map((question) => question.key === nextQuestion.key ? nextQuestion : question));
    };

    const moveQuestion = (key: string, offset: -1 | 1) => {
        const currentIndex = questions.findIndex((question) => question.key === key);
        if (currentIndex < 0) return;
        const indexes = questions
            .map((question, index) => question.pageNumber === questions[currentIndex].pageNumber ? index : -1)
            .filter((index) => index >= 0);
        const target = indexes[indexes.indexOf(currentIndex) + offset];
        if (target === undefined) return;
        setQuestions((current) => {
            const next = [...current];
            [next[currentIndex], next[target]] = [next[target], next[currentIndex]];
            return next;
        });
    };

    const addQuestion = (pageOrder: number) => {
        const nextQuestion: ImportedQuestionFormValue = {
            key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            externalNumber: '', pageNumber: pageOrder,
            regions: [{ x: 0, y: 0, width: 1, height: 1 }],
            questionText: '', answerText: '', analysis: '', questionType: '', score: '',
        };
        setQuestions((current) => {
            const insertAt = current.findIndex((question) => question.pageNumber > pageOrder);
            return insertAt < 0
                ? [...current, nextQuestion]
                : [...current.slice(0, insertAt), nextQuestion, ...current.slice(insertAt)];
        });
    };

    const retryPage = async (pageOrder: number) => {
        setBusy(`retry-${pageOrder}`);
        setError(null);
        try {
            const result = await apiClient.post<{
                failures: Array<{ pageOrder: number; error: string }>;
            }>(`/api/exams/${paperId}/recognize`, {
                pageOrders: [pageOrder], language,
            }, { recoverable: true, timeout: 600_000 });
            if (result.failures.some((failure) => failure.pageOrder === pageOrder)) {
                setError(text.retryFailed);
                return;
            }
            await load();
        } catch (cause) {
            setError(getApiErrorMessage(cause) ?? text.retryFailed);
        } finally {
            setBusy(null);
        }
    };

    const save = async (publish: boolean) => {
        if (!paper || !title.trim() || !subjectId || (publish && questions.some((question) => !question.questionText.trim() || question.regions.length === 0))) {
            setError(text.validationFailed);
            return;
        }
        setBusy(publish ? 'publish' : 'save');
        setError(null);
        setNotice(null);
        try {
            await apiClient.patch(`/api/exams/${paperId}`, {
                kind: 'import-draft', title: title.trim(), subjectId,
                gradeSemester: gradeSemester.trim() || null, examType: examType || null,
                examDate: examDateToISOString(examDate),
                totalScore: totalScore ? Number(totalScore) : null,
                pages: pages.map((page) => ({ id: page.id, order: page.order, role: page.role })),
                questions: questions.map((question) => ({
                    ...(question.id ? { id: question.id } : {}),
                    externalNumber: question.externalNumber.trim() || null,
                    pageNumber: question.pageNumber, regions: question.regions,
                    questionText: question.questionText.trim(),
                    answerText: question.answerText.trim() || null,
                    analysis: question.analysis.trim() || null,
                    questionType: question.questionType.trim() || null,
                    score: question.score === '' ? null : Number(question.score),
                })),
                publish,
            });
            if (publish) {
                router.push(`/exams/${paperId}`);
                return;
            }
            setNotice(text.saved);
            await load();
        } catch (cause) {
            setError(getApiErrorMessage(cause) ?? (publish ? text.publishFailed : text.saveFailed));
        } finally {
            setBusy(null);
        }
    };

    return {
        paper, pages, questions, notebooks, title, subjectId, gradeSemester, examType, examDate, totalScore,
        busy, error, notice, setTitle, setSubjectId, setGradeSemester, setExamType, setExamDate, setTotalScore,
        setPageRole, updateQuestion, moveQuestion, addQuestion,
        deleteQuestion: (key: string) => setQuestions((current) => current.filter((question) => question.key !== key)),
        retryPage, save,
    };
}
