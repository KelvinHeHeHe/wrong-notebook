import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamImportReview } from '@/components/exam-import/exam-import-review';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { apiClient } from '@/lib/api-client';
import { shouldReviewImportedExam } from '@/lib/exam/exam-import-navigation';
import type { ExamPaperDetail } from '@/types/api';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

vi.mock('@/lib/api-client', () => ({
    apiClient: {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
    },
}));

vi.mock('@/components/import-batch/region-editor-dialog', () => ({
    RegionEditorDialog: ({ open, onSave }: { open: boolean; onSave: (regions: Array<{ x: number; y: number; width: number; height: number }>) => void }) => (
        open ? <button type="button" data-testid="mock-region-save" onClick={() => onSave([{ x: 0.2, y: 0.2, width: 0.6, height: 0.5 }])}>保存区域</button> : null
    ),
}));

const region = { x: 0.1, y: 0.1, width: 0.8, height: 0.3 };

function paperFixture(twoQuestions = false): ExamPaperDetail {
    return {
        id: 'paper-1',
        title: '家庭周测',
        status: 'review',
        scope: 'all',
        difficulty: 'original',
        mode: 'original',
        requestedCount: twoQuestions ? 2 : 1,
        groupByType: false,
        resultsRecordedAt: null,
        createdAt: '2026-11-08T00:00:00.000Z',
        origin: 'imported',
        subjectId: 'subject-1',
        gradeSemester: '三年级上',
        examType: 'unit',
        examDate: null,
        totalScore: null,
        pages: [
            { id: 'page-1', order: 1, role: 'questions', imageData: 'data:image/jpeg;base64,YQ==', mimeType: 'image/jpeg', width: 1000, height: 1400 },
            { id: 'page-2', order: 2, role: 'questions', imageData: 'data:image/jpeg;base64,Yg==', mimeType: 'image/jpeg', width: 1000, height: 1400 },
        ],
        questions: [
            {
                id: 'question-1', order: 1, errorItemId: null, sourceShortId: 'IMP001001', status: 'ready',
                externalNumber: '1', pageNumber: 1, regionJson: JSON.stringify([region]), recognitionConfidence: null,
                questionText: '1 + 1 = ?', answerText: null, analysis: null, score: 5, questionType: null,
                errorItemQuestionType: null, error: null, notebookName: null, attempts: [],
            },
            ...(twoQuestions ? [{
                id: 'question-2', order: 2, errorItemId: null, sourceShortId: 'IMP001002', status: 'ready' as const,
                externalNumber: '2', pageNumber: 1, regionJson: JSON.stringify([region]), recognitionConfidence: null,
                questionText: '2 + 2 = ?', answerText: null, analysis: null, score: 5, questionType: null,
                errorItemQuestionType: null, error: null, notebookName: null, attempts: [],
            }] : []),
        ],
    };
}

const notebooks = [
    { id: 'subject-1', name: '数学', userId: 'user-1', createdAt: '', updatedAt: '' },
    { id: 'subject-2', name: '语文', userId: 'user-1', createdAt: '', updatedAt: '' },
];

function mockLoadedPaper(paper: ExamPaperDetail) {
    vi.mocked(apiClient.get).mockImplementation(async (url) => (
        url === '/api/notebooks' ? notebooks : paper
    ) as never);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockLoadedPaper(paperFixture());
    vi.mocked(apiClient.post).mockResolvedValue({ status: 'review', successes: [], failures: [] });
    vi.mocked(apiClient.patch).mockResolvedValue({ id: 'paper-1', status: 'review', totalScore: null });
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
});

async function flush() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderReview() {
    await act(async () => root.render(<LanguageProvider><ExamImportReview paperId="paper-1" /></LanguageProvider>));
    await flush();
    expect(apiClient.get).toHaveBeenCalledWith('/api/exams/paper-1?includePages=1');
}

function clickButton(text: string) {
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(text));
    if (!button) throw new Error(`找不到按钮：${text}`);
    return act(async () => { (button as HTMLButtonElement).click(); });
}

function changeSelect(select: HTMLSelectElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ExamImportReview', () => {
    it('提示无题页面并支持单页重试', async () => {
        await renderReview();
        expect(container.textContent).toContain('第 2 页未识别到题目');

        await clickButton('重试第 2 页');
        await flush();

        expect(apiClient.post).toHaveBeenCalledWith('/api/exams/paper-1/recognize', {
            pageOrders: [2],
            language: 'zh',
        }, { recoverable: true, timeout: 600_000 });
        expect(apiClient.get).toHaveBeenCalledTimes(4);
    });

    it('重试接口返回页面失败时显示错误且不伪装成成功刷新', async () => {
        vi.mocked(apiClient.post).mockResolvedValueOnce({
            status: 'review', successes: [], failures: [{ pageOrder: 2, error: 'AI_TIMEOUT_ERROR' }],
        });
        await renderReview();

        await clickButton('重试第 2 页');
        await flush();

        expect(container.textContent).toContain('页面重试失败');
        expect(apiClient.get).toHaveBeenCalledTimes(2);
    });

    it('切换答案页会移除该页题目并按完整页面集合保存', async () => {
        const fixture = paperFixture();
        fixture.questions.push({
            ...fixture.questions[0], id: 'question-2', order: 2, sourceShortId: 'IMP002001', pageNumber: 2, questionText: '答案页误识别题目',
        });
        mockLoadedPaper(fixture);
        await renderReview();

        const pageTwoRole = container.querySelector('select[data-page-order="2"]') as HTMLSelectElement;
        await act(async () => changeSelect(pageTwoRole, 'answer_key'));
        await clickButton('保存草稿');
        await flush();

        expect(apiClient.patch).toHaveBeenCalledWith('/api/exams/paper-1', expect.objectContaining({
            kind: 'import-draft',
            publish: false,
            pages: [
                { id: 'page-1', order: 1, role: 'questions' },
                { id: 'page-2', order: 2, role: 'answer_key' },
            ],
            questions: [expect.objectContaining({ id: 'question-1', pageNumber: 1 })],
        }));
    });

    it('支持题目新增删除重排、字段和区域编辑', async () => {
        mockLoadedPaper(paperFixture(true));
        await renderReview();

        const secondCard = container.querySelector('[data-question-key="question-2"]') as HTMLElement;
        await act(async () => (secondCard.querySelector('button[aria-label="上移题目"]') as HTMLButtonElement).click());

        const firstCard = container.querySelector('[data-question-key="question-1"]') as HTMLElement;
        await act(async () => {
            changeInput(firstCard.querySelector('input[name="externalNumber"]') as HTMLInputElement, '1A');
            changeInput(firstCard.querySelector('textarea[name="questionText"]') as HTMLTextAreaElement, '修改后的题干');
            changeInput(firstCard.querySelector('input[name="score"]') as HTMLInputElement, '6');
        });
        await act(async () => (firstCard.querySelector('button[aria-label="编辑题目区域"]') as HTMLButtonElement).click());
        await act(async () => (container.querySelector('[data-testid="mock-region-save"]') as HTMLButtonElement).click());

        await clickButton('新增题目');
        expect(container.querySelectorAll('[data-question-key]').length).toBe(3);
        const newCard = Array.from(container.querySelectorAll('[data-question-key]')).at(-1) as HTMLElement;
        await act(async () => (newCard.querySelector('button[aria-label="删除题目"]') as HTMLButtonElement).click());
        expect(container.querySelectorAll('[data-question-key]').length).toBe(2);

        await clickButton('保存草稿');
        await flush();
        const body = vi.mocked(apiClient.patch).mock.calls[0][1] as { questions: Array<Record<string, unknown>> };
        expect(body.questions.map((question) => question.id)).toEqual(['question-2', 'question-1']);
        expect(body.questions[1]).toEqual(expect.objectContaining({
            externalNumber: '1A',
            questionText: '修改后的题干',
            score: 6,
            regions: [{ x: 0.2, y: 0.2, width: 0.6, height: 0.5 }],
        }));
    });

    it('支持把题目移动到另一题目页并保存新页码', async () => {
        await renderReview();
        const card = container.querySelector('[data-question-key="question-1"]') as HTMLElement;
        const pageSelect = card.querySelector('select[name="pageNumber"]') as HTMLSelectElement;

        await act(async () => changeSelect(pageSelect, '2'));
        await clickButton('保存草稿');
        await flush();

        expect(apiClient.patch).toHaveBeenCalledWith('/api/exams/paper-1', expect.objectContaining({
            questions: [expect.objectContaining({ id: 'question-1', pageNumber: 2 })],
        }));
    });

    it('校对时可以修正学科错题本', async () => {
        await renderReview();
        const subject = container.querySelector('#review-notebook') as HTMLSelectElement;

        await act(async () => changeSelect(subject, 'subject-2'));
        await clickButton('保存草稿');
        await flush();

        expect(apiClient.patch).toHaveBeenCalledWith('/api/exams/paper-1', expect.objectContaining({
            subjectId: 'subject-2',
        }));
    });

    it('允许保存尚未填写题干和区域的草稿，但发布时提示补全', async () => {
        const fixture = paperFixture();
        fixture.questions[0].questionText = '';
        fixture.questions[0].regionJson = '[]';
        mockLoadedPaper(fixture);
        await renderReview();

        await clickButton('保存草稿');
        await flush();

        expect(apiClient.patch).toHaveBeenCalledWith('/api/exams/paper-1', expect.objectContaining({
            publish: false,
            questions: [expect.objectContaining({ questionText: '', regions: [] })],
        }));

        vi.mocked(apiClient.patch).mockClear();
        await clickButton('发布试卷');
        expect(container.textContent).toContain('请填写所有题干');
        expect(apiClient.patch).not.toHaveBeenCalled();
    });

    it('发布成功后进入现有试卷详情与打印流程', async () => {
        const fixture = paperFixture();
        fixture.pages![1].role = 'answer_key';
        fixture.totalScore = 5;
        mockLoadedPaper(fixture);
        vi.mocked(apiClient.patch).mockResolvedValue({ id: 'paper-1', status: 'ready', totalScore: 5 });
        await renderReview();

        await clickButton('发布试卷');
        await flush();

        expect(apiClient.patch).toHaveBeenCalledWith('/api/exams/paper-1', expect.objectContaining({ publish: true }));
        expect(pushMock).toHaveBeenCalledWith('/exams/paper-1');
    });
});

describe('shouldReviewImportedExam', () => {
    it('只把未发布的外部试卷导向校对页', () => {
        expect(shouldReviewImportedExam({ origin: 'imported', status: 'review' })).toBe(true);
        expect(shouldReviewImportedExam({ origin: 'imported', status: 'importing' })).toBe(true);
        expect(shouldReviewImportedExam({ origin: 'imported', status: 'ready' })).toBe(false);
        expect(shouldReviewImportedExam({ origin: 'generated', status: 'review' })).toBe(false);
    });
});
