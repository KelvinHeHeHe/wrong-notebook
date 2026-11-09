"use client";

import { useId } from 'react';

import { AttemptRegionPreview } from '@/components/exam-attempt/attempt-region-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useLanguage } from '@/contexts/LanguageContext';
import { draftChanges, validAwardedScore, validDraft } from '@/lib/exam/exam-attempt-review-client';
import { normalizeExamScore } from '@/lib/exam/exam-score';
import { en } from '@/lib/i18n/en';
import type { ExamAnswerDraft } from '@/lib/exam/exam-attempt-review-client';
import type { ExamAttemptAnswerDetail, ExamAttemptPageDetail, ExamQuestionDetail } from '@/types/api';

interface AttemptAnswerCardProps {
    question: ExamQuestionDetail;
    answer: ExamAttemptAnswerDetail | undefined;
    pages: ExamAttemptPageDetail[];
    draft: ExamAnswerDraft | null;
    disabled: boolean;
    confirmed: boolean;
    onEdit: (field: keyof ExamAnswerDraft, value: string) => void;
    onSave: () => void;
    onRegrade: () => void;
}

export function AttemptAnswerCard({ question, answer, pages, draft, disabled, confirmed, onEdit, onSave, onRegrade }: AttemptAnswerCardProps) {
    const { t } = useLanguage();
    const text = (t.examAttempt ?? en.examAttempt).review ?? en.examAttempt.review;
    const id = useId();
    const changes = draft ? draftChanges(draft) : null;
    const maxValid = changes && normalizeExamScore(changes.maxScore) !== null;
    const scoreValid = changes && validAwardedScore(changes.awardedScore ?? null, changes.maxScore ?? null);
    const status = answer?.reviewStatus;
    return <article aria-labelledby={`${id}-title`} className={`min-w-0 space-y-4 rounded-xl border p-4 ${status === 'required' ? 'border-amber-500' : ''}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`${id}-title`} className="font-semibold">{text.question.replace('{number}', String(question.order))}</h2>
            {answer && <Badge variant={status === 'required' ? 'destructive' : 'secondary'}>{status === 'required' ? text.requiredStatus : status === 'reviewed' ? text.reviewedStatus : text.pendingStatus}</Badge>}
        </div>
        <p className="whitespace-pre-wrap break-words text-sm">{question.questionText}</p>
        <p className="whitespace-pre-wrap break-words text-sm"><strong>{text.answerKey}：</strong>{question.answerText ?? '—'}</p>
        {!answer || !draft ? <p role="status">{text.missingAnswer}</p> : <>
            <p className="text-xs text-muted-foreground">{text.confidence}：{answer.confidence === null ? '—' : `${Math.round(answer.confidence * 100)}%`}</p>
            <AttemptRegionPreview pages={pages} regionJson={answer.regionJson} />
            <fieldset disabled={disabled || confirmed} className="min-w-0 space-y-4">
                <div className="space-y-1"><label htmlFor={`${id}-answer`}>{text.recognizedAnswer}</label><Textarea id={`${id}-answer`} maxLength={20000} value={draft.recognizedAnswer} onChange={(event) => onEdit('recognizedAnswer', event.target.value)} /></div>
                <div className="space-y-1"><label htmlFor={`${id}-result`}>{text.result}</label><select id={`${id}-result`} value={draft.result} onChange={(event) => onEdit('result', event.target.value)} className="h-11 w-full rounded-md border bg-background px-3 text-sm"><option value="">{text.chooseResult}</option>{(['correct', 'wrong', 'not_attempted'] as const).map((result) => <option key={result} value={result}>{text[result]}</option>)}</select></div>
                <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1"><label htmlFor={`${id}-max`}>{text.maxScore}</label><Input id={`${id}-max`} type="number" inputMode="decimal" min="0.1" max="1000" step="0.1" value={draft.maxScore} aria-invalid={!maxValid} aria-describedby={!maxValid ? `${id}-max-error` : undefined} onChange={(event) => onEdit('maxScore', event.target.value)} /></div>
                    <div className="space-y-1"><label htmlFor={`${id}-score`}>{text.awardedScore}</label><Input id={`${id}-score`} type="number" inputMode="decimal" min="0" max={draft.maxScore} step="0.1" value={draft.awardedScore} aria-invalid={!scoreValid} aria-describedby={!scoreValid ? `${id}-score-error` : undefined} onChange={(event) => onEdit('awardedScore', event.target.value)} /></div>
                </div>
                {!maxValid && <p id={`${id}-max-error`} className="text-sm text-destructive">{text.maxInvalid}</p>}
                {!scoreValid && <p id={`${id}-score-error`} className="text-sm text-destructive">{text.scoreInvalid}</p>}
                <div className="space-y-1"><label htmlFor={`${id}-reason`}>{text.reason}</label><Textarea id={`${id}-reason`} maxLength={10000} value={draft.gradingReason} onChange={(event) => onEdit('gradingReason', event.target.value)} /></div>
                {!confirmed && <div className="flex flex-col gap-2 sm:flex-row">
                    <Button type="button" disabled={disabled || !validDraft(draft)} onClick={onSave}>{text.save}</Button>
                    <Button type="button" variant="outline" disabled={disabled || !draft.recognizedAnswer.trim() || !question.answerText?.trim() || !maxValid} onClick={onRegrade}>{text.regrade}</Button>
                </div>}
            </fieldset>
        </>}
    </article>;
}
