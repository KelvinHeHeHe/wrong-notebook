"use client";

import Image from 'next/image';
import { AlertTriangle, Loader2, Plus, RefreshCw, Save, Send } from 'lucide-react';

import { ImportQuestionCard } from '@/components/exam-import/import-question-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageLoading } from '@/components/ui/page-loading';
import { useLanguage } from '@/contexts/LanguageContext';
import { useExamImportReview } from '@/lib/hooks/use-exam-import-review';

export function ExamImportReview({ paperId }: { paperId: string }) {
    const { t, language } = useLanguage();
    const text = t.examImport.review;
    const review = useExamImportReview({ paperId, language, text });

    if (!review.paper && !review.error) return <PageLoading label={t.common.loading} />;
    if (!review.paper) return <p role="alert" className="rounded-md bg-destructive/10 p-3 text-destructive">{review.error}</p>;

    return (
        <div className="space-y-6 pb-24">
            <Card>
                <CardHeader><CardTitle className="text-lg">{text.metadata}</CardTitle></CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1 sm:col-span-2"><Label htmlFor="review-title">{t.examImport.paperTitle}</Label><Input id="review-title" value={review.title} onChange={(event) => review.setTitle(event.target.value)} /></div>
                    <div className="space-y-1"><Label htmlFor="review-grade">{t.examImport.gradeSemester}</Label><Input id="review-grade" value={review.gradeSemester} onChange={(event) => review.setGradeSemester(event.target.value)} /></div>
                    <div className="space-y-1">
                        <Label htmlFor="review-type">{t.examImport.examType}</Label>
                        <select id="review-type" value={review.examType} onChange={(event) => review.setExamType(event.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm">
                            <option value="">{t.examImport.examTypes.unspecified}</option>
                            <option value="unit">{t.examImport.examTypes.unit}</option><option value="midterm">{t.examImport.examTypes.midterm}</option><option value="final">{t.examImport.examTypes.final}</option><option value="daily">{t.examImport.examTypes.daily}</option><option value="other">{t.examImport.examTypes.other}</option>
                        </select>
                    </div>
                    <div className="space-y-1"><Label htmlFor="review-date">{t.examImport.examDate}</Label><Input id="review-date" type="date" value={review.examDate} onChange={(event) => review.setExamDate(event.target.value)} /></div>
                    <div className="space-y-1"><Label htmlFor="review-total">{t.examImport.totalScore}</Label><Input id="review-total" type="number" min="0" max="20000" step="0.1" value={review.totalScore} onChange={(event) => review.setTotalScore(event.target.value)} /></div>
                </CardContent>
            </Card>

            {review.error && <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{review.error}</p>}
            {review.notice && <p className="rounded-md bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950/40 dark:text-green-300">{review.notice}</p>}

            {review.pages.map((page) => {
                const pageQuestions = review.questions.filter((question) => question.pageNumber === page.order);
                return (
                    <section key={page.id} className="space-y-3 rounded-2xl border p-3 sm:p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                            <Image src={page.imageData} alt={text.pageImage.replace('{number}', String(page.order))} width={112} height={156} unoptimized className="h-40 w-28 rounded-md border bg-white object-contain" />
                            <div className="min-w-0 flex-1 space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <h2 className="text-lg font-semibold">{text.pageTitle.replace('{number}', String(page.order))}</h2>
                                    <select data-page-order={page.order} value={page.role} onChange={(event) => review.setPageRole(page.id, event.target.value as 'questions' | 'answer_key')} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
                                        <option value="questions">{text.questionPage}</option><option value="answer_key">{text.answerPage}</option>
                                    </select>
                                </div>
                                {page.role === 'questions' && pageQuestions.length === 0 && (
                                    <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                                        <AlertTriangle className="h-4 w-4" /><span>{text.emptyPage.replace('{number}', String(page.order))}</span>
                                        <Button type="button" variant="outline" size="sm" onClick={() => review.retryPage(page.order)} disabled={review.busy === `retry-${page.order}`}>
                                            {review.busy === `retry-${page.order}` ? <Loader2 className="animate-spin" /> : <RefreshCw />}{text.retryPage.replace('{number}', String(page.order))}
                                        </Button>
                                    </div>
                                )}
                                {page.role === 'answer_key' && <p className="text-sm text-muted-foreground">{text.answerPageHint}</p>}
                            </div>
                        </div>
                        {page.role === 'questions' && (
                            <div className="space-y-3">
                                {pageQuestions.map((question, index) => (
                                    <ImportQuestionCard key={question.key} question={question} pageImage={page.imageData}
                                        canMoveUp={index > 0} canMoveDown={index < pageQuestions.length - 1}
                                        onChange={review.updateQuestion} onMove={(offset) => review.moveQuestion(question.key, offset)}
                                        onDelete={() => review.deleteQuestion(question.key)} />
                                ))}
                                <Button type="button" variant="outline" size="sm" onClick={() => review.addQuestion(page.order)}><Plus />{text.addQuestion}</Button>
                            </div>
                        )}
                    </section>
                );
            })}

            <div className="fixed inset-x-0 bottom-16 z-30 border-t bg-background/95 p-3 backdrop-blur md:bottom-0">
                <div className="mx-auto flex max-w-4xl justify-end gap-2">
                    <Button type="button" variant="outline" disabled={review.busy !== null} onClick={() => review.save(false)}>{review.busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />}{text.save}</Button>
                    <Button type="button" disabled={review.busy !== null} onClick={() => review.save(true)}>{review.busy === 'publish' ? <Loader2 className="animate-spin" /> : <Send />}{text.publish}</Button>
                </div>
            </div>
        </div>
    );
}
