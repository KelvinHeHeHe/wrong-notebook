"use client";

import { useEffect, useState } from 'react';
import { Loader2, ScanLine, Upload } from 'lucide-react';

import { PagePreviewList } from '@/components/exam-import/page-preview-list';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { apiClient } from '@/lib/api-client';
import { examDateToISOString } from '@/lib/exam/exam-import-client';
import { useExamImport } from '@/lib/hooks/use-exam-import';
import type { Notebook } from '@/types/api';

export function ExamImportForm() {
    const { t, language } = useLanguage();
    const text = t.examImport;
    const flow = useExamImport(language);
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [title, setTitle] = useState('');
    const [subjectId, setSubjectId] = useState('');
    const [gradeSemester, setGradeSemester] = useState('');
    const [examType, setExamType] = useState('');
    const [examDate, setExamDate] = useState('');
    const [totalScore, setTotalScore] = useState('');

    useEffect(() => {
        apiClient.get<Notebook[]>('/api/notebooks')
            .then((data) => {
                setNotebooks(data);
                if (data.length > 0) setSubjectId(data[0].id);
            })
            .catch(() => setNotebooks([]));
    }, []);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        await flow.submit({
            title: title.trim(),
            subjectId,
            gradeSemester: gradeSemester.trim() || null,
            examType: examType ? examType as 'unit' | 'midterm' | 'final' | 'daily' | 'other' : null,
            examDate: examDateToISOString(examDate),
            totalScore: totalScore ? Number(totalScore) : null,
        });
    };

    const busy = flow.phase === 'preparing' || flow.phase === 'creating' || flow.phase === 'recognizing';
    const submitText = flow.phase === 'creating'
        ? text.creating
        : flow.phase === 'recognizing'
            ? text.recognizing
            : text.create;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg"><ScanLine className="h-5 w-5" />{text.metadata}</CardTitle>
            </CardHeader>
            <CardContent>
                <form onSubmit={submit} className="space-y-6">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2 sm:col-span-2">
                            <Label htmlFor="exam-import-title">{text.paperTitle}</Label>
                            <Input id="exam-import-title" name="title" required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="exam-import-notebook">{text.notebook}</Label>
                            <select id="exam-import-notebook" name="subjectId" required value={subjectId} onChange={(event) => setSubjectId(event.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs">
                                <option value="">{text.selectNotebook}</option>
                                {notebooks.map((notebook) => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}
                            </select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="exam-import-grade">{text.gradeSemester}</Label>
                            <Input id="exam-import-grade" name="gradeSemester" maxLength={50} value={gradeSemester} onChange={(event) => setGradeSemester(event.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="exam-import-type">{text.examType}</Label>
                            <select id="exam-import-type" name="examType" value={examType} onChange={(event) => setExamType(event.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs">
                                <option value="">{text.examTypes.unspecified}</option>
                                <option value="unit">{text.examTypes.unit}</option>
                                <option value="midterm">{text.examTypes.midterm}</option>
                                <option value="final">{text.examTypes.final}</option>
                                <option value="daily">{text.examTypes.daily}</option>
                                <option value="other">{text.examTypes.other}</option>
                            </select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="exam-import-date">{text.examDate}</Label>
                            <Input id="exam-import-date" name="examDate" type="date" value={examDate} onChange={(event) => setExamDate(event.target.value)} />
                        </div>
                        <div className="space-y-2 sm:col-span-2">
                            <Label htmlFor="exam-import-score">{text.totalScore}</Label>
                            <Input id="exam-import-score" name="totalScore" type="number" min="0" max="20000" step="0.1" value={totalScore} onChange={(event) => setTotalScore(event.target.value)} />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="exam-import-files">{text.files}</Label>
                        <Input id="exam-import-files" type="file" accept="application/pdf,image/*,.heic,.heif" multiple disabled={busy} onChange={(event) => flow.prepareFiles(Array.from(event.target.files ?? []))} />
                        <p className="text-xs text-muted-foreground">{text.fileHint}</p>
                    </div>

                    {flow.phase === 'preparing' && <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{text.preparing}</p>}
                    {flow.error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{text.errors[flow.error as keyof typeof text.errors] ?? text.error}</p>}
                    {flow.pages.length > 0 && (
                        <div className="space-y-3">
                            <h2 className="font-medium">{text.pageCount.replace('{count}', String(flow.pages.length))}</h2>
                            <PagePreviewList
                                pages={flow.pages}
                                pageLabel={text.pageNumber}
                                moveUpLabel={text.moveUp}
                                moveDownLabel={text.moveDown}
                                removeLabel={text.remove}
                                onMove={flow.movePage}
                                onRemove={flow.removePage}
                            />
                        </div>
                    )}

                    <Button type="submit" className="w-full sm:w-auto" disabled={busy || !title.trim() || !subjectId || flow.pages.length === 0}>
                        {busy ? <Loader2 className="animate-spin" /> : <Upload />}
                        {submitText}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
