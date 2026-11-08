import { prepareImage, renderRegion } from '@/lib/image-pipeline';
import { getPdfjsDefaultParams, loadPdfjsBrowser } from '@/lib/import/file-parsers/pdf/load-pdfjs';
import { MAX_SCAN_PAGES_PER_IMPORT, renderPdfPages } from '@/lib/import/file-parsers/pdf/render-pages';
import type { PdfDocumentProxyLike, RenderedPdfPage, RenderPdfPagesOptions } from '@/lib/import/file-parsers/pdf/render-pages';
import type { CreateImportedExamInput } from '@/lib/schemas/exam';

export interface PreparedExamImportPage {
    order: number;
    role: 'questions';
    imageData: string;
    mimeType: 'image/jpeg';
    width: number;
    height: number;
    sourceName: string;
}

interface PreparedPhoto {
    dataUrl: string;
    width: number;
    height: number;
}

export interface ExamImportPreparationDeps {
    loadPdfDocument?: (file: File) => Promise<PdfDocumentProxyLike>;
    renderPdf?: (document: PdfDocumentProxyLike, options: RenderPdfPagesOptions) => Promise<RenderedPdfPage[]>;
    preparePhoto?: (file: File) => Promise<PreparedPhoto>;
}

export interface ExamRecognitionResult {
    status: 'importing' | 'review' | 'ready';
    successes: Array<{ pageOrder: number; questionCount: number }>;
    failures: Array<{ pageOrder: number; error: string }>;
}

export interface ExamImportWorkflowDeps {
    createExam: (input: CreateImportedExamInput) => Promise<{ paperId: string }>;
    recognizePages: (paperId: string, pageOrders: number[], language: 'zh' | 'en') => Promise<ExamRecognitionResult>;
}

export type ExamImportWorkflowInput = Omit<CreateImportedExamInput, 'pages'> & {
    language: 'zh' | 'en';
    pages: PreparedExamImportPage[];
};

const IMAGE_FILE_PATTERN = /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/i;

/** HTML date 输入是纯日期；固定为 UTC 午夜，避免本地时区换算导致回显前一天。 */
export function examDateToISOString(value: string): string | null {
    return value ? `${value}T00:00:00.000Z` : null;
}

function isPdf(file: File): boolean {
    return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function isImage(file: File): boolean {
    return file.type.startsWith('image/') || IMAGE_FILE_PATTERN.test(file.name);
}

async function loadPdfDocument(file: File): Promise<PdfDocumentProxyLike> {
    const pdfjs = await loadPdfjsBrowser();
    const data = new Uint8Array(await file.arrayBuffer());
    return pdfjs.getDocument({ data, ...getPdfjsDefaultParams() }).promise as Promise<PdfDocumentProxyLike>;
}

async function preparePhoto(file: File): Promise<PreparedPhoto> {
    const prepared = await prepareImage(file);
    try {
        const rendered = await renderRegion(prepared);
        return { dataUrl: rendered.dataUrl, width: rendered.width, height: rendered.height };
    } finally {
        prepared.dispose();
    }
}

/** 把单个 PDF 或一组照片统一准备为受限 JPEG 页图。 */
export async function prepareExamImportFiles(
    inputFiles: Iterable<File>,
    deps: ExamImportPreparationDeps = {},
): Promise<PreparedExamImportPage[]> {
    const files = Array.from(inputFiles);
    if (files.length === 0) throw new Error('EXAM_IMPORT_NO_FILES');

    const pdfFiles = files.filter(isPdf);
    const imageFiles = files.filter(isImage);
    if (pdfFiles.length > 0 && imageFiles.length > 0) throw new Error('EXAM_IMPORT_MIXED_FILES');
    if (pdfFiles.length > 1 || pdfFiles.length + imageFiles.length !== files.length) {
        throw new Error('EXAM_IMPORT_UNSUPPORTED_FILES');
    }

    if (pdfFiles.length === 1) {
        const file = pdfFiles[0];
        const document = await (deps.loadPdfDocument ?? loadPdfDocument)(file);
        if (document.numPages < 1) throw new Error('EXAM_IMPORT_EMPTY_PDF');
        if (document.numPages > MAX_SCAN_PAGES_PER_IMPORT) throw new Error('EXAM_IMPORT_TOO_MANY_PAGES');
        const pageNumbers = Array.from({ length: document.numPages }, (_, index) => index + 1);
        const rendered = await (deps.renderPdf ?? renderPdfPages)(document, { pages: pageNumbers });
        return rendered.map((page, index) => ({
            order: index + 1,
            role: 'questions',
            imageData: page.dataUrl,
            mimeType: 'image/jpeg',
            width: page.width,
            height: page.height,
            sourceName: `${file.name} · ${page.pageNumber}`,
        }));
    }

    if (imageFiles.length > MAX_SCAN_PAGES_PER_IMPORT) throw new Error('EXAM_IMPORT_TOO_MANY_PAGES');
    const photoPreparer = deps.preparePhoto ?? preparePhoto;
    const pages: PreparedExamImportPage[] = [];
    for (let index = 0; index < imageFiles.length; index += 1) {
        const file = imageFiles[index];
        const rendered = await photoPreparer(file);
        pages.push({
            order: index + 1,
            role: 'questions',
            imageData: rendered.dataUrl,
            mimeType: 'image/jpeg',
            width: rendered.width,
            height: rendered.height,
            sourceName: file.name,
        });
    }
    return pages;
}

/** 创建草稿后整卷提交识别；部分失败由服务端返回并原样保留。 */
export async function createAndRecognizeExamImport(
    input: ExamImportWorkflowInput,
    deps: ExamImportWorkflowDeps,
): Promise<ExamRecognitionResult & { paperId: string }> {
    const { language, pages, ...metadata } = input;
    const createInput: CreateImportedExamInput = {
        ...metadata,
        pages: pages.map(({ sourceName: _sourceName, ...page }) => page),
    };
    const { paperId } = await deps.createExam(createInput);
    const recognition = await deps.recognizePages(paperId, pages.map((page) => page.order), language);
    return { paperId, ...recognition };
}
