import type { QuestionSplitResult } from '@/lib/ai/question-split';
import { draftRegionSchema } from '@/lib/question-split/draft';
import type { DraftRegion } from '@/lib/question-split/draft';

export interface ImportedQuestionDraft {
    order: number;
    sourceShortId: string;
    status: 'ready';
    externalNumber: string | null;
    pageNumber: number;
    questionText: string;
    answerText: null;
    analysis: null;
    figureSvg: null;
    score: null;
    questionType: null;
    regionJson: string;
    recognitionConfidence: number | null;
    error: null;
}

export interface ImportedExamPublishQuestion {
    pageNumber: number;
    questionText: string;
    regions: DraftRegion[];
    score?: number | null;
}

export interface ImportedExamPublishInput {
    pages: { order: number; role: 'questions' | 'answer_key' }[];
    questions: ImportedExamPublishQuestion[];
    totalScore?: number | null;
}

export type ImportedExamPublishResult =
    | { ok: true; totalScore: number | null }
    | { ok: false; errors: string[] };

/** 对页图 data URL 的完整文本计算 SHA-256，浏览器与 Node 结果一致。 */
export async function checksumExamPage(imageData: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(imageData));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 兼容 v12 早期单区域对象与当前多区域数组。 */
export function parseExamRegions(raw: unknown): DraftRegion[] {
    let value = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    const candidates = Array.isArray(value) ? value : [value];
    return candidates
        .map((candidate) => draftRegionSchema.safeParse(candidate))
        .filter((result): result is { success: true; data: DraftRegion } => result.success)
        .map((result) => result.data)
        .slice(0, 4);
}

/** 把一页 AI 分题结果转换为尚未关联错题的 ExamQuestion 草稿。 */
export function buildImportedQuestions(pageOrder: number, split: QuestionSplitResult): ImportedQuestionDraft[] {
    return split.questions.map((question, index) => ({
        order: index + 1,
        sourceShortId: `IMP${String(pageOrder).padStart(3, '0')}${String(index + 1).padStart(3, '0')}`,
        status: 'ready' as const,
        externalNumber: question.label,
        pageNumber: pageOrder,
        questionText: [question.material, question.text].filter(Boolean).join('\n\n'),
        answerText: null,
        analysis: null,
        figureSvg: null,
        score: null,
        questionType: null,
        regionJson: JSON.stringify(question.regions),
        recognitionConfidence: question.flags.length > 0 ? 0.5 : null,
        error: null,
    }));
}

export function validateImportedExamForPublish(input: ImportedExamPublishInput): ImportedExamPublishResult {
    const errors: string[] = [];
    const questionPageOrders = new Set(input.pages.filter((page) => page.role === 'questions').map((page) => page.order));
    const questionsByPage = new Map<number, number>();
    input.questions.forEach((question) => {
        questionsByPage.set(question.pageNumber, (questionsByPage.get(question.pageNumber) ?? 0) + 1);
    });

    if (questionPageOrders.size === 0 || [...questionPageOrders].some((order) => !questionsByPage.has(order))) {
        errors.push('QUESTION_PAGE_EMPTY');
    }

    for (const question of input.questions) {
        if (!questionPageOrders.has(question.pageNumber) && !errors.includes('QUESTION_PAGE_INVALID')) {
            errors.push('QUESTION_PAGE_INVALID');
        }
        if (!question.questionText.trim() && !errors.includes('QUESTION_TEXT_REQUIRED')) {
            errors.push('QUESTION_TEXT_REQUIRED');
        }
        if (question.regions.length === 0 && !errors.includes('QUESTION_REGION_REQUIRED')) {
            errors.push('QUESTION_REGION_REQUIRED');
        }
    }

    const scoresComplete = input.questions.length > 0 && input.questions.every((question) => typeof question.score === 'number');
    const scoreSum = scoresComplete
        ? input.questions.reduce((total, question) => total + (question.score ?? 0), 0)
        : null;
    if (input.totalScore !== null && input.totalScore !== undefined) {
        if (!scoresComplete || scoreSum === null || Math.abs(scoreSum - input.totalScore) > 1e-6) {
            errors.push('TOTAL_SCORE_MISMATCH');
        }
    }

    return errors.length > 0
        ? { ok: false, errors }
        : { ok: true, totalScore: input.totalScore ?? scoreSum };
}

