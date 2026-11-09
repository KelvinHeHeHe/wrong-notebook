"use client";

import { useId, useState } from 'react';

import { AttemptRegionPreview } from '@/components/exam-attempt/attempt-region-preview';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { parseAttemptPageRecognition, parseAttemptRegionJson } from '@/lib/exam/exam-attempt';
import { en } from '@/lib/i18n/en';
import type { ExamReviewQuestion } from '@/lib/exam/exam-attempt-review-client';
import type { ExamAttemptAnswerCandidate } from '@/lib/exam/exam-attempt';
import type { ExamAttemptAnswerDetail, ExamAttemptPageDetail } from '@/types/api';

interface UnmatchedCandidatesProps {
    pages: ExamAttemptPageDetail[];
    answers: ExamAttemptAnswerDetail[];
    questions: ExamReviewQuestion[];
    disabled: boolean;
    onMap: (answerId: string, pageOrder: number, candidateId: string) => void;
    onRetry: (pageOrder: number) => void;
    onUnmap: (answerId: string) => void;
}
interface CandidateRowProps extends Pick<UnmatchedCandidatesProps, 'questions' | 'answers' | 'disabled' | 'onMap' | 'onUnmap'> {
    page: ExamAttemptPageDetail;
    candidate: ExamAttemptAnswerCandidate;
    linked: Array<{ answerId: string; displayNumber: number }>;
}
function CandidateRow({ page, candidate, questions, answers, disabled, linked, onMap, onUnmap }: CandidateRowProps) {
    const { t } = useLanguage();
    const text = (t.examAttempt ?? en.examAttempt).review ?? en.examAttempt.review;
    const id = useId();
    const [target, setTarget] = useState('');
    const used = linked.length > 0;
    return <li className="space-y-3 rounded-lg border p-3">
        <p className="whitespace-pre-wrap break-words text-sm">{candidate.recognizedAnswer ?? '—'}</p>
        <AttemptRegionPreview pages={[page]} regionJson={JSON.stringify({ pageOrder: page.order, candidateId: candidate.candidateId, regions: candidate.regions })} />
        <label htmlFor={id} className="block text-sm">{text.target}</label>
        <select id={id} value={target} disabled={disabled || used} onChange={(event) => setTarget(event.target.value)} className="h-11 w-full rounded-md border bg-background px-3 text-sm">
            <option value="">{text.chooseTarget}</option>
            {questions.map((question) => { const answer = answers.find((item) => item.examQuestionId === question.id); return <option key={question.id} value={answer?.id ?? ''} disabled={!answer}>{text.question.replace('{number}', String(question.displayNumber))}</option>; })}
        </select>
        <Button type="button" variant="outline" disabled={disabled || used || !target} onClick={() => onMap(target, page.order, candidate.candidateId)}>{used ? text.mapped : text.map}</Button>
        {linked.map((link) => <div key={link.answerId} className="flex flex-wrap items-center justify-between gap-2">
            <p id={`${id}-${link.answerId}`} className="text-sm">{text.mappedTarget.replace('{number}', String(link.displayNumber))}</p>
            <Button type="button" variant="outline" disabled={disabled} aria-describedby={`${id}-${link.answerId}`} onClick={() => onUnmap(link.answerId)}>{text.unmap}</Button>
        </div>)}
    </li>;
}

export function UnmatchedCandidates({ pages, answers, questions, disabled, onMap, onRetry, onUnmap }: UnmatchedCandidatesProps) {
    const { t } = useLanguage();
    const text = (t.examAttempt ?? en.examAttempt).review ?? en.examAttempt.review;
    const links = answers.flatMap((answer) => {
        const region = parseAttemptRegionJson(answer.regionJson);
        const question = questions.find((item) => item.id === answer.examQuestionId);
        return region?.candidateId && question ? [{ key: `${region.pageOrder}:${region.candidateId}`, answerId: answer.id, displayNumber: question.displayNumber }] : [];
    });
    return <section aria-label={text.candidates} className="space-y-4">
        <h2 className="text-lg font-semibold">{text.candidates}</h2>
        {pages.map((page) => {
            const recognition = page.recognitionResult ? parseAttemptPageRecognition(page.recognitionResult) : null;
            return <section key={page.id} aria-label={text.page.replace('{number}', String(page.order))} className="space-y-3 rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="font-semibold">{text.page.replace('{number}', String(page.order))}</h3>
                    <Button type="button" variant="outline" disabled={disabled} onClick={() => onRetry(page.order)}>{text.retryPage.replace('{number}', String(page.order))}</Button>
                </div>
                <p className="text-sm text-muted-foreground">{recognition?.status === 'failed' ? text.pageFailed : recognition?.status === 'succeeded' ? text.pageSucceeded : text.pagePending}</p>
                {recognition?.candidates.length ? <ul className="grid gap-3 sm:grid-cols-2">{recognition.candidates.map((candidate, index) => <CandidateRow key={`${candidate.candidateId}:${index}`} page={page} candidate={candidate} questions={questions} answers={answers} disabled={disabled} linked={links.filter((link) => link.key === `${page.order}:${candidate.candidateId}`)} onMap={onMap} onUnmap={onUnmap} />)}</ul> : <p className="text-sm">{text.noCandidates}</p>}
            </section>;
        })}
    </section>;
}
