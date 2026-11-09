"use client";

import { useEffect, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { parseAttemptRegionJson } from '@/lib/exam/exam-attempt';
import { en } from '@/lib/i18n/en';
import { renderRegion } from '@/lib/image-pipeline';
import type { ExamAttemptPageDetail } from '@/types/api';

interface AttemptRegionPreviewProps { pages: ExamAttemptPageDetail[]; regionJson: string | null }

/** 仅恢复页序用于整页兜底；坐标必须经过共享 parser 校验。 */
function fallbackPageOrder(raw: string | null): number | null {
    try {
        const value: unknown = JSON.parse(raw ?? 'null');
        const order = value && typeof value === 'object' && 'pageOrder' in value ? value.pageOrder : null;
        return typeof order === 'number' && Number.isInteger(order) && order > 0 ? order : null;
    } catch { return null; }
}

export function AttemptRegionPreview({ pages, regionJson }: AttemptRegionPreviewProps) {
    const { t } = useLanguage();
    const text = (t.examAttempt ?? en.examAttempt).review ?? en.examAttempt.review;
    const id = useId();
    const [open, setOpen] = useState(false);
    const [crop, setCrop] = useState<{ key: string; url: string } | null>(null);
    const parsed = parseAttemptRegionJson(regionJson);
    const page = pages.find((item) => item.order === (parsed?.pageOrder ?? fallbackPageOrder(regionJson))) ?? pages[0];
    const key = `${page?.id}:${page?.checksum}:${regionJson}`;
    const cropped = crop?.key === key ? crop.url : null;
    useEffect(() => {
        if (!open || !page?.imageData) return;
        const region = parseAttemptRegionJson(regionJson);
        if (!region?.regions.length || region.pageOrder !== page.order) return;
        let active = true;
        const image = new Image();
        image.onload = async () => {
            const x = Math.min(...region.regions.map((item) => item.x));
            const y = Math.min(...region.regions.map((item) => item.y));
            const width = Math.max(...region.regions.map((item) => item.x + item.width)) - x;
            const height = Math.max(...region.regions.map((item) => item.y + item.height)) - y;
            try {
                const rendered = await renderRegion({ source: image, width: page.width ?? image.naturalWidth, height: page.height ?? image.naturalHeight }, { x, y, width, height });
                if (active) setCrop({ key, url: rendered.dataUrl });
            } catch { /* 解码或裁图失败保留整页，不记录图片或异常正文。 */ }
        };
        image.src = page.imageData;
        return () => { active = false; image.onload = null; };
    }, [open, key, page, regionJson]);
    return <div className="space-y-2">
        <Button type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? text.hidePreview : text.preview}</Button>
        {open && <div id={id} className="rounded-lg border bg-muted/30 p-2">
            {page?.imageData ? <>
                {!cropped && <p className="mb-2 text-xs text-muted-foreground">{text.fullPage}</p>}
                <img src={cropped ?? page.imageData} alt={text.imageAlt.replace('{number}', String(page.order))} className="h-auto max-h-[70vh] w-full object-contain" draggable={false} />
            </> : <p>{text.noImage}</p>}
        </div>}
    </div>;
}
