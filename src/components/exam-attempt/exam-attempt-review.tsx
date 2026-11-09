"use client";

import Link from 'next/link';

import { BackgroundTasksButton } from '@/components/background-tasks-button';
import { AttemptAnswerCard } from '@/components/exam-attempt/attempt-answer-card';
import { UnmatchedCandidates } from '@/components/exam-attempt/unmatched-candidates';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoading } from '@/components/ui/page-loading';
import { useLanguage } from '@/contexts/LanguageContext';
import { parseAttemptPageRecognition, summarizeExamAttemptScores } from '@/lib/exam/exam-attempt';
import { answerDraft, reviewIssues, validDraft } from '@/lib/exam/exam-attempt-review-client';
import { useExamAttemptReview } from '@/lib/hooks/use-exam-attempt-review';
import { en } from '@/lib/i18n/en';
import { usePageTitle } from '@/lib/page-title';

interface ExamAttemptReviewProps { attemptId: string }

export function ExamAttemptReview({ attemptId }: ExamAttemptReviewProps) {
    const { t, language } = useLanguage();
    const parentText = t.examAttempt ?? en.examAttempt;
    const text = parentText.review ?? en.examAttempt.review;
    const review = useExamAttemptReview(attemptId, language);
    const { data, drafts, busy, phase, error, notice, stale } = review;
    usePageTitle(text.title, data?.paper.title);
    if (!data) return error ? <main className="mx-auto max-w-4xl space-y-4 p-4"><p role="alert">{text[error]}</p><Button disabled={busy} onClick={() => void review.reload()}>{text.reload}</Button></main> : <PageLoading label={t.common.loading} />;
    const { attempt, paper } = data;
    const questions = paper.questions.filter((question) => question.status === 'ready').sort((left, right) => left.order - right.order);
    const answers = attempt.answers.filter((answer) => questions.some((question) => question.id === answer.examQuestionId));
    const scores = summarizeExamAttemptScores(answers);
    const required = answers.filter((answer) => answer.reviewStatus === 'required').length;
    const issues = reviewIssues(paper, answers, drafts);
    const dirty = Object.keys(drafts).length > 0;
    const confirmed = attempt.status === 'confirmed';
    const disabled = busy || stale || confirmed;
    const invalidStatus = attempt.status !== 'review' || paper.status !== 'ready';
    const canConfirm = !disabled && !invalidStatus && questions.length > 0 && issues.length === 0;
    const phaseLabel = phase === 'save' || phase === 'saveAll' ? text.saving : phase === 'regrade' ? text.regrading : phase === 'retry' ? text.retrying : phase === 'map' ? text.mapping : phase === 'confirm' ? text.confirming : null;
    return <main className="mx-auto min-h-screen max-w-4xl space-y-6 px-4 py-6 pb-72 md:px-8 md:pb-52">
        <Link href={`/exams/${attempt.paperId}`} className="inline-block text-sm underline underline-offset-4">{text.back}</Link>
        <PageHeader title={text.title} description={paper.title} />
        <section aria-label={text.title} className="space-y-2 rounded-xl border bg-muted/30 p-4">
            <p>{parentText.takenAt}：<time dateTime={attempt.takenAt}>{new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US').format(new Date(attempt.takenAt))}</time></p>
            <p>{parentText.statuses[attempt.status]}</p>
            <p>{text.pageProgress.replace('{done}', String(attempt.pages.filter((page) => page.recognitionResult && parseAttemptPageRecognition(page.recognitionResult)?.status === 'succeeded').length)).replace('{total}', String(attempt.pages.length))}</p>
            <p className="font-semibold">{parentText.score.replace('{score}', scores.totalScore?.toString() ?? '—').replace('{max}', scores.maxScore?.toString() ?? '—')}</p>
            <p>{text.required.replace('{count}', String(required))}</p>
            {attempt.comment && <p className="whitespace-pre-wrap break-words text-sm">{attempt.comment}</p>}
        </section>
        {error && <div role="alert" className="space-y-2 text-destructive"><p>{text[error]}</p>{stale && <Button variant="outline" disabled={busy} onClick={() => void review.reload()}>{text.reload}</Button>}</div>}
        <p role="status" aria-live="polite" className="text-sm">{phaseLabel ?? (notice ? text[notice] : '')}</p>
        {questions.map((question) => {
            const answer = answers.find((item) => item.examQuestionId === question.id);
            return <AttemptAnswerCard key={question.id} question={question} answer={answer} pages={attempt.pages} draft={answer ? drafts[answer.id] ?? answerDraft(answer) : null} disabled={disabled} confirmed={confirmed} onEdit={(field, value) => answer && review.edit(answer.id, field, value)} onSave={() => answer && void review.save(answer.id)} onRegrade={() => answer && void review.regrade(answer.id)} />;
        })}
        {dirty && <p className="text-sm text-muted-foreground">{text.saveFirst}</p>}
        <UnmatchedCandidates pages={attempt.pages} answers={answers} questions={questions} disabled={disabled || dirty} onMap={(...args) => void review.mapCandidate(...args)} onRetry={(order) => void review.retryPage(order)} />
        {!confirmed && <section id="attempt-confirm-issues" aria-label={text.preflight} className="space-y-2 text-sm">
            {(issues.length > 0 || invalidStatus || !questions.length) && <h2 className="font-semibold">{text.preflight}</h2>}
            {invalidStatus && <p>{text.invalidStatus}</p>}{!questions.length && <p>{text.noQuestions}</p>}
            <ul className="space-y-1">{issues.map((issue) => <li key={`${issue.questionId}:${issue.reason}`}>{text.question.replace('{number}', String(issue.number))}：{text[issue.reason]}</li>)}</ul>
        </section>}
        <footer className="fixed inset-x-0 bottom-[calc(4rem+1px+env(safe-area-inset-bottom))] z-50 border-t bg-background/95 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur md:bottom-0">
            <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-end gap-3">
                <BackgroundTasksButton inline />
                {confirmed ? <p role="status">{text.confirmed}</p> : <>
                    <Button type="button" variant="outline" disabled={disabled || !dirty || Object.values(drafts).some((draft) => !validDraft(draft))} onClick={() => void review.saveAll()}>{text.saveAll}</Button>
                    <Button type="button" disabled={!canConfirm} aria-describedby="attempt-confirm-issues" onClick={() => { if (canConfirm) void review.confirm(); }}>{phase === 'confirm' ? text.confirming : text.confirm}</Button>
                </>}
            </div>
        </footer>
    </main>;
}
