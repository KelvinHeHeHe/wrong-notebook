import { describe, expect, it, vi } from 'vitest';

import {
    createAndRecognizeExamImport,
    examDateToISOString,
    prepareExamImportFiles,
} from '@/lib/exam/exam-import-client';
import type { ExamImportPreparationDeps } from '@/lib/exam/exam-import-client';

const jpeg = (value: string) => `data:image/jpeg;base64,${value}`;

describe('prepareExamImportFiles', () => {
    it('考试日期按纯 UTC 日期保存，不受 Mac 本地时区影响', () => {
        expect(examDateToISOString('2026-11-08')).toBe('2026-11-08T00:00:00.000Z');
        expect(examDateToISOString('')).toBeNull();
    });

    it('文字型 PDF 仍按完整页序渲染为页图，不走文本提取', async () => {
        const document = { numPages: 3, getPage: vi.fn() };
        const loadPdfDocument = vi.fn().mockResolvedValue(document);
        const renderPdf = vi.fn().mockResolvedValue([
            { pageNumber: 1, dataUrl: jpeg('YQ=='), width: 1000, height: 1400, bytes: 1 },
            { pageNumber: 2, dataUrl: jpeg('Yg=='), width: 1000, height: 1400, bytes: 1 },
            { pageNumber: 3, dataUrl: jpeg('Yw=='), width: 1000, height: 1400, bytes: 1 },
        ]);
        const file = new File(['pdf with selectable text'], '期中测试.pdf', { type: 'application/pdf' });

        const pages = await prepareExamImportFiles([file], { loadPdfDocument, renderPdf });

        expect(loadPdfDocument).toHaveBeenCalledWith(file);
        expect(renderPdf).toHaveBeenCalledWith(document, expect.objectContaining({ pages: [1, 2, 3] }));
        expect(pages.map((page) => ({ order: page.order, sourceName: page.sourceName }))).toEqual([
            { order: 1, sourceName: '期中测试.pdf · 1' },
            { order: 2, sourceName: '期中测试.pdf · 2' },
            { order: 3, sourceName: '期中测试.pdf · 3' },
        ]);
    });

    it('照片按选择顺序压缩并生成连续物理页序', async () => {
        const calls: string[] = [];
        const preparePhoto: ExamImportPreparationDeps['preparePhoto'] = vi.fn(async (file) => {
            calls.push(file.name);
            return {
                dataUrl: jpeg(file.name.includes('2') ? 'YQ==' : 'Yg=='),
                width: 1200,
                height: 1600,
            };
        });
        const files = [
            new File(['a'], '第2页.jpg', { type: 'image/jpeg' }),
            new File(['b'], '第1页.png', { type: 'image/png' }),
        ];

        const pages = await prepareExamImportFiles(files, { preparePhoto });

        expect(calls).toEqual(['第2页.jpg', '第1页.png']);
        expect(pages.map((page) => [page.order, page.sourceName, page.mimeType])).toEqual([
            [1, '第2页.jpg', 'image/jpeg'],
            [2, '第1页.png', 'image/jpeg'],
        ]);
    });

    it('拒绝混合 PDF 与照片', async () => {
        const files = [
            new File(['pdf'], '试卷.pdf', { type: 'application/pdf' }),
            new File(['image'], '补拍.jpg', { type: 'image/jpeg' }),
        ];

        await expect(prepareExamImportFiles(files)).rejects.toThrow('EXAM_IMPORT_MIXED_FILES');
    });

    it('拒绝超过 20 页的照片或 PDF', async () => {
        const photos = Array.from({ length: 21 }, (_, index) => (
            new File(['image'], `${index + 1}.jpg`, { type: 'image/jpeg' })
        ));
        await expect(prepareExamImportFiles(photos)).rejects.toThrow('EXAM_IMPORT_TOO_MANY_PAGES');

        const pdf = new File(['pdf'], '长试卷.pdf', { type: 'application/pdf' });
        await expect(prepareExamImportFiles([pdf], {
            loadPdfDocument: vi.fn().mockResolvedValue({ numPages: 21, getPage: vi.fn() }),
        })).rejects.toThrow('EXAM_IMPORT_TOO_MANY_PAGES');
    });
});

describe('createAndRecognizeExamImport', () => {
    it('整卷识别出现单页失败时保留成功与失败结果', async () => {
        const createExam = vi.fn().mockResolvedValue({ paperId: 'paper-1' });
        const recognizePages = vi.fn().mockResolvedValue({
            status: 'review',
            successes: [{ pageOrder: 1, questionCount: 4 }],
            failures: [{ pageOrder: 2, error: 'AI_TIMEOUT_ERROR' }],
        });

        const result = await createAndRecognizeExamImport({
            title: '期中测试',
            subjectId: 'subject-1',
            language: 'zh',
            pages: [
                { order: 1, role: 'questions', imageData: jpeg('YQ=='), mimeType: 'image/jpeg', width: 1000, height: 1400, sourceName: '1.jpg' },
                { order: 2, role: 'questions', imageData: jpeg('Yg=='), mimeType: 'image/jpeg', width: 1000, height: 1400, sourceName: '2.jpg' },
            ],
        }, { createExam, recognizePages });

        expect(recognizePages).toHaveBeenCalledWith('paper-1', [1, 2], 'zh');
        expect(result).toEqual({
            paperId: 'paper-1',
            status: 'review',
            successes: [{ pageOrder: 1, questionCount: 4 }],
            failures: [{ pageOrder: 2, error: 'AI_TIMEOUT_ERROR' }],
        });
    });
});
