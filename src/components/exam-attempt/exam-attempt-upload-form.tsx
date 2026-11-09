"use client";

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, Upload } from 'lucide-react';

import { PagePreviewList } from '@/components/exam-import/page-preview-list';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTimeZone } from '@/contexts/TimeZoneContext';
import { answeredDateToISOString, formatDateTime } from '@/lib/date-time';
import { en } from '@/lib/i18n/en';
import { useExamAttemptUpload } from '@/lib/hooks/use-exam-attempt-upload';

interface ExamAttemptUploadFormProps {
    paperId: string;
}

export function ExamAttemptUploadForm({ paperId }: ExamAttemptUploadFormProps) {
    const { t, language } = useLanguage();
    const { timeZone } = useTimeZone();
    const text = t.examAttempt ?? en.examAttempt;
    const flow = useExamAttemptUpload(paperId, language);
    const [takenAt, setTakenAt] = useState(() => formatDateTime(new Date(), 'yyyy-MM-dd', timeZone));
    const [comment, setComment] = useState('');
    const submitText = flow.phase === 'creating' ? text.creating : flow.phase === 'uploading' ? text.uploading : flow.phase === 'recognizing' ? text.recognizing : text.submit;

    return (
        <Card>
            <CardContent className="pt-6">
                <form className="space-y-6" onSubmit={(event) => {
                    event.preventDefault();
                    if (takenAt) void flow.submit({ takenAt: answeredDateToISOString(takenAt, timeZone), ...(comment.trim() ? { comment: comment.trim() } : {}) });
                }}>
                    <fieldset disabled={flow.busy || !!flow.attemptId} className="space-y-6">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="attempt-taken-at">{text.takenAt}</Label>
                                <Input id="attempt-taken-at" type="date" required value={takenAt} onChange={(event) => setTakenAt(event.target.value)} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="attempt-comment">{text.comment}</Label>
                                <Input id="attempt-comment" maxLength={500} value={comment} onChange={(event) => setComment(event.target.value)} />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="attempt-photos">{text.photos}</Label>
                            <Input id="attempt-photos" type="file" accept="image/*" multiple capture="environment" onChange={(event) => {
                                const files = Array.from(event.target.files ?? []);
                                event.target.value = '';
                                if (files.length) void flow.prepareFiles(files);
                            }} />
                            <p className="text-xs text-muted-foreground">{text.photoHint}</p>
                        </div>
                        {flow.pages.length > 0 && <div className="space-y-3">
                            <h2 className="font-medium">{text.pageCount.replace('{count}', String(flow.pages.length))}</h2>
                            <PagePreviewList pages={flow.pages.map((page) => ({ ...page, role: 'questions' }))} pageLabel={t.examImport.pageNumber} moveUpLabel={t.examImport.moveUp} moveDownLabel={t.examImport.moveDown} removeLabel={t.examImport.remove} onMove={flow.movePage} onRemove={flow.removePage} />
                        </div>}
                    </fieldset>
                    {flow.phase === 'preparing' && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{text.preparing}</p>}
                    {flow.error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{text.errors[flow.error as keyof typeof text.errors] ?? text.error}</p>}
                    {flow.attemptId && flow.phase === 'error' && <p className="text-sm">{text.resumeHint} <Link className="underline" href={`/exam-attempts/${flow.attemptId}`}>{text.continueReview}</Link></p>}
                    <Button type="submit" className="w-full sm:w-auto" disabled={flow.busy || !takenAt || flow.pages.length === 0}>
                        {flow.busy ? <Loader2 className="animate-spin" /> : <Upload />}{submitText}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
