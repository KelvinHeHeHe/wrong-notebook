"use client";

import Image from 'next/image';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { PreparedExamImportPage } from '@/lib/exam/exam-import-client';

interface PagePreviewListProps {
    pages: PreparedExamImportPage[];
    pageLabel: string;
    moveUpLabel: string;
    moveDownLabel: string;
    removeLabel: string;
    onMove: (index: number, offset: -1 | 1) => void;
    onRemove: (index: number) => void;
}

export function PagePreviewList({
    pages,
    pageLabel,
    moveUpLabel,
    moveDownLabel,
    removeLabel,
    onMove,
    onRemove,
}: PagePreviewListProps) {
    return (
        <ol className="grid gap-3 sm:grid-cols-2">
            {pages.map((page, index) => (
                <li key={`${page.sourceName}-${index}`} className="flex gap-3 rounded-xl border bg-card p-3">
                    <Image
                        src={page.imageData}
                        alt={`${pageLabel} ${index + 1}`}
                        width={80}
                        height={112}
                        unoptimized
                        className="h-28 w-20 shrink-0 rounded-md border bg-white object-contain"
                    />
                    <div className="min-w-0 flex-1 space-y-2">
                        <div>
                            <p className="font-medium">{pageLabel} {index + 1}</p>
                            <p className="truncate text-xs text-muted-foreground" title={page.sourceName}>{page.sourceName}</p>
                        </div>
                        <div className="flex gap-1">
                            <Button type="button" variant="outline" size="icon-sm" disabled={index === 0} aria-label={moveUpLabel} onClick={() => onMove(index, -1)}>
                                <ArrowUp />
                            </Button>
                            <Button type="button" variant="outline" size="icon-sm" disabled={index === pages.length - 1} aria-label={moveDownLabel} onClick={() => onMove(index, 1)}>
                                <ArrowDown />
                            </Button>
                            <Button type="button" variant="ghost" size="icon-sm" aria-label={removeLabel} onClick={() => onRemove(index)}>
                                <Trash2 />
                            </Button>
                        </div>
                    </div>
                </li>
            ))}
        </ol>
    );
}
