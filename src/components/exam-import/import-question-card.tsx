"use client";

import { useState } from 'react';
import { ArrowDown, ArrowUp, Crop, Trash2 } from 'lucide-react';

import { RegionEditorDialog } from '@/components/import-batch/region-editor-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import type { DraftRegion } from '@/lib/question-split/draft';

export interface ImportedQuestionFormValue {
    key: string;
    id?: string;
    externalNumber: string;
    pageNumber: number;
    regions: DraftRegion[];
    questionText: string;
    answerText: string;
    analysis: string;
    questionType: string;
    score: string;
}

interface ImportQuestionCardProps {
    question: ImportedQuestionFormValue;
    pageImage: string;
    canMoveUp: boolean;
    canMoveDown: boolean;
    onChange: (question: ImportedQuestionFormValue) => void;
    onMove: (offset: -1 | 1) => void;
    onDelete: () => void;
}

export function ImportQuestionCard({
    question,
    pageImage,
    canMoveUp,
    canMoveDown,
    onChange,
    onMove,
    onDelete,
}: ImportQuestionCardProps) {
    const { t } = useLanguage();
    const text = t.examImport.review;
    const [editingRegion, setEditingRegion] = useState(false);
    const fieldId = (field: string) => `${question.key}-${field}`;
    const update = (patch: Partial<ImportedQuestionFormValue>) => onChange({ ...question, ...patch });

    return (
        <Card data-question-key={question.key} className="rounded-xl">
            <CardHeader className="space-y-3 pb-3">
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base">{text.questionCard.replace('{number}', question.externalNumber || '—')}</CardTitle>
                    <div className="flex gap-1">
                        <Button type="button" variant="outline" size="icon-sm" disabled={!canMoveUp} aria-label={text.moveQuestionUp} onClick={() => onMove(-1)}><ArrowUp /></Button>
                        <Button type="button" variant="outline" size="icon-sm" disabled={!canMoveDown} aria-label={text.moveQuestionDown} onClick={() => onMove(1)}><ArrowDown /></Button>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={text.deleteQuestion} onClick={onDelete}><Trash2 /></Button>
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="space-y-1">
                        <Label htmlFor={fieldId('number')}>{text.externalNumber}</Label>
                        <Input id={fieldId('number')} name="externalNumber" maxLength={20} value={question.externalNumber} onChange={(event) => update({ externalNumber: event.target.value })} />
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor={fieldId('score')}>{text.score}</Label>
                        <Input id={fieldId('score')} name="score" type="number" min="0" max="1000" step="0.1" value={question.score} onChange={(event) => update({ score: event.target.value })} />
                    </div>
                    <div className="col-span-2 space-y-1">
                        <Label htmlFor={fieldId('type')}>{text.questionType}</Label>
                        <Input id={fieldId('type')} name="questionType" maxLength={200} value={question.questionType} onChange={(event) => update({ questionType: event.target.value })} />
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="space-y-1">
                    <Label htmlFor={fieldId('question')}>{text.questionText}</Label>
                    <textarea id={fieldId('question')} name="questionText" required rows={5} value={question.questionText} onChange={(event) => update({ questionText: event.target.value })} className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                        <Label htmlFor={fieldId('answer')}>{text.answerText}</Label>
                        <textarea id={fieldId('answer')} name="answerText" rows={3} value={question.answerText} onChange={(event) => update({ answerText: event.target.value })} className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor={fieldId('analysis')}>{text.analysis}</Label>
                        <textarea id={fieldId('analysis')} name="analysis" rows={3} value={question.analysis} onChange={(event) => update({ analysis: event.target.value })} className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
                    </div>
                </div>
                <Button type="button" variant="outline" size="sm" aria-label={text.editRegion} onClick={() => setEditingRegion(true)}>
                    <Crop />{text.editRegionCount.replace('{count}', String(question.regions.length))}
                </Button>
                {editingRegion && (
                    <RegionEditorDialog
                        key={question.key}
                        open
                        imageUrl={pageImage}
                        regions={question.regions}
                        onClose={() => setEditingRegion(false)}
                        onSave={(regions) => {
                            update({ regions });
                            setEditingRegion(false);
                        }}
                    />
                )}
            </CardContent>
        </Card>
    );
}
