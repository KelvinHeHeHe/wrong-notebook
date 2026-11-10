import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamAttemptReview } from '@/components/exam-attempt/exam-attempt-review';
import { AttemptRegionPreview } from '@/components/exam-attempt/attempt-region-preview';
import * as languageContext from '@/contexts/LanguageContext';
import { translations } from '@/lib/translations';
import type { Translations } from '@/lib/translations';
import type { ExamAttemptAnswerDetail, ExamAttemptPageDetail, ExamQuestionDetail } from '@/types/api';
import ExamAttemptReviewPage from '@/app/exam-attempts/[id]/page';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { ApiError, apiClient } from '@/lib/api-client';
import { renderRegion } from '@/lib/image-pipeline';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), useParams: () => ({ id: 'a1' }) }));
vi.mock('@/lib/api-client', async (original) => ({ ...await original<typeof import('@/lib/api-client')>(), apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
// 任务入口的真实弹层与点击由桌面/移动 E2E 覆盖；此处隔离复核 API 状态。
vi.mock('@/components/background-tasks-button', () => ({ BackgroundTasksButton: () => null }));
vi.mock('@/lib/image-pipeline', () => ({ renderRegion: vi.fn() }));
const region = JSON.stringify({ pageOrder: 2, candidateId: 'used', regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }] });
const candidate = { candidateId: 'free', sourceShortId: null, displayNumber: 99, recognizedAnswer: '候选正文', notAttempted: false, confidence: 0.5, regions: [] };
const pages: ExamAttemptPageDetail[] = [1, 2].map((order) => ({ id: `pg${order}`, attemptId: 'a1', order, imageData: `data:image/jpeg;base64,YQ==${order}`, mimeType: 'image/jpeg', width: 1000, height: 1400, checksum: `sum${order}`, recognitionResult: JSON.stringify({ version: 1, status: order === 1 ? 'failed' : 'succeeded', candidates: order === 1 ? [] : [candidate, { ...candidate, candidateId: 'used' }], errorCode: order === 1 ? 'TIMEOUT' : null, completedAt: '2026-11-09T00:00:00Z' }), createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z' }));
const answer: ExamAttemptAnswerDetail = { id: 'ans1', attemptId: 'a1', examQuestionId: 'q1', recognizedAnswer: '原答案', result: 'wrong', awardedScore: 0, maxScore: 5, gradingSource: 'ai', gradingReason: '判分理由', confidence: 0.5, reviewStatus: 'required', regionJson: region, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z' };
const question: ExamQuestionDetail = { id: 'q1', order: 1, errorItemId: null, sourceShortId: 'S1', status: 'ready', questionText: '第一题题干', answerText: '标准答案', analysis: null, score: 5, error: null, notebookName: null, attempts: [] };
function detail() { return { id: 'a1', userId: 'u1', paperId: 'p1', status: 'review', updatedAt: 'v1', takenAt: '2026-11-09T00:00:00Z', comment: null, totalScore: null, maxScore: null, confirmedAt: null, createdAt: '2026-11-09T00:00:00Z', paper: { id: 'p1', title: '测试卷', status: 'ready', origin: 'imported' }, pages, answers: [{ ...answer }] }; }
let latest: ReturnType<typeof detail>;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    latest = detail();
    vi.mocked(apiClient.get).mockImplementation(async (url) => url.startsWith('/api/exams/') ? { id: 'p1', title: '测试卷', status: 'ready', questions: [question] } : latest);
    vi.mocked(apiClient.patch).mockImplementation(async (url, body) => {
        const changes = body as Record<string, unknown>;
        const answerId = url.split('/').at(-1);
        const saved = { ...latest.answers.find((item) => item.id === answerId)!, ...changes, reviewStatus: changes.regrade ? 'required' : 'reviewed', gradingSource: changes.regrade ? 'ai' : 'manual' } as ExamAttemptAnswerDetail;
        if ('candidateRef' in changes) Object.assign(saved, { recognizedAnswer: changes.candidateRef === null ? null : '候选正文', regionJson: changes.candidateRef === null ? null : JSON.stringify({ ...changes.candidateRef as object, regions: [] }), result: null, awardedScore: null, gradingReason: null, gradingSource: null, reviewStatus: 'required' });
        latest = { ...latest, updatedAt: 'v2', answers: latest.answers.map((item) => item.id === answerId ? saved : item) };
        return { answer: saved, updatedAt: latest.updatedAt };
    });
    vi.mocked(apiClient.post).mockImplementation(async () => { latest = { ...latest, updatedAt: 'v3' }; return { status: 'review', updatedAt: 'v3', successes: [], failures: [] }; });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(id = 'a1') { await act(async () => root.render(<LanguageProvider><ExamAttemptReview attemptId={id} /></LanguageProvider>)); }
function button(text: string) { return [...container.querySelectorAll('button')].find((element) => element.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
function field(label: string) { return [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')].find((element) => element.labels?.[0]?.textContent === label)!; }
async function edit(label: string, value: string) { await act(async () => { const element = field(label); const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); }); }

describe('纸质作答复核', () => {
    it('一次加载页图，显示必须复核数量、总分和具体缺项', async () => {
        await render();
        expect(apiClient.get).toHaveBeenCalledWith('/api/exam-attempts/a1?includePages=1');
        expect(container.textContent).toContain('必须复核：1');
        expect(container.textContent).toContain('得分：0 / 5');
        expect(container.textContent).toContain('页面识别：1 / 2');
        expect(container.textContent).toContain('第 1 题：尚未完成人工复核');
        expect(button('确认成绩').disabled).toBe(true);
    });
    it('编辑答案、结果、满分、部分分和备注，保存后解除 required 并使用新版确认', async () => {
        await render(); await edit('识别答案', '修正答案'); await edit('结果', 'wrong'); await edit('满分', '6'); await edit('得分', '2.5'); await edit('判分理由 / 人工备注', '部分分'); await click('保存并标记已复核');
        expect(apiClient.patch).toHaveBeenCalledWith('/api/exam-attempts/a1/answers/ans1', { recognizedAnswer: '修正答案', result: 'wrong', maxScore: 6, awardedScore: 2.5, gradingReason: '部分分', expectedUpdatedAt: 'v1' }, expect.anything());
        expect(container.textContent).toContain('已人工复核'); expect(button('确认成绩').disabled).toBe(false);
        await click('确认成绩'); expect(apiClient.post).toHaveBeenCalledWith('/api/exam-attempts/a1/confirm', { expectedUpdatedAt: 'v2' }); expect(push).toHaveBeenCalledWith('/exams/p1');
    });
    it.each(['2.55', '-1', '5.1', ''])('非法部分分 %s 阻止保存并给出边界提示', async (value) => {
        await render(); await edit('得分', value);
        expect(container.textContent).toContain('得分须在 0 至满分之间，最多一位小数'); expect(button('保存并标记已复核').disabled).toBe(true);
    });
    it('未保存修改明确阻止整卷确认，保存草稿串行完成', async () => {
        latest.answers[0].reviewStatus = 'pending'; await render(); await edit('识别答案', '草稿');
        expect(button('确认成绩').disabled).toBe(true); expect(container.textContent).toContain('第 1 题：有未保存修改');
        await click('保存草稿'); expect(field('识别答案').value).toBe('草稿'); expect(button('确认成绩').disabled).toBe(false);
    });
    it('按页列出候选，禁用已映射候选，映射只提交 candidateRef 并刷新', async () => {
        await render(); expect(container.textContent).toContain('第 2 页'); expect(button('已映射').disabled).toBe(true);
        await edit('目标题目', 'ans1'); await click('映射到此题');
        expect(apiClient.patch).toHaveBeenCalledWith('/api/exam-attempts/a1/answers/ans1', { candidateRef: { pageOrder: 2, candidateId: 'free' }, expectedUpdatedAt: 'v1' }, expect.anything());
        expect(apiClient.get).toHaveBeenCalledWith('/api/exam-attempts/a1');
        expect(vi.mocked(apiClient.get).mock.calls.filter(([url]) => url.includes('includePages'))).toHaveLength(1);
    });
    it('单题重判保持 required，重判期间阻止其他写入和重复操作', async () => {
        let finish!: (value: unknown) => void;
        vi.mocked(apiClient.patch).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        await render(); await edit('识别答案', '待重判'); await click('重新判分');
        expect(button('保存并标记已复核').disabled).toBe(true); expect(button('重新判分').disabled).toBe(true); expect(button('重试第 1 页').disabled).toBe(true);
        await act(async () => finish({ answer: { ...answer, recognizedAnswer: '待重判', reviewStatus: 'required' }, updatedAt: 'v2' }));
        expect(button('确认成绩').disabled).toBe(true); expect(container.textContent).toContain('必须复核：1');
        expect(apiClient.patch).toHaveBeenCalledWith('/api/exam-attempts/a1/answers/ans1', { recognizedAnswer: '待重判', maxScore: 5, regrade: true, expectedUpdatedAt: 'v1' }, expect.anything());
    });
    it('单页重试使用手工保存后的版本且保留已保存人工分数', async () => {
        await render(); await edit('得分', '2.5'); await click('保存并标记已复核'); await click('重试第 1 页');
        expect(apiClient.post).toHaveBeenCalledWith('/api/exam-attempts/a1/recognize', { expectedUpdatedAt: 'v2', pageOrders: [1], language: 'zh' }, { recoverable: true, timeout: 600_000 });
        expect(field('得分').value).toBe('2.5'); expect(container.textContent).toContain('已人工复核');
    });
    it('元数据刷新不重复下载图片且仍能查看缓存整页', async () => {
        await render();
        vi.mocked(apiClient.get).mockImplementation(async (url) => url.startsWith('/api/exams/') ? { id: 'p1', status: 'ready', questions: [question] } : { ...latest, pages: pages.map(({ imageData: _imageData, ...page }) => page), answers: [{ ...answer, regionJson: null }] });
        await click('重试第 1 页'); await click('查看作答区域');
        expect(container.querySelector('img')?.getAttribute('src')).toBe(pages[0].imageData);
        expect(vi.mocked(apiClient.get).mock.calls.filter(([url]) => url.includes('includePages'))).toHaveLength(1);
    });
    it('重判失败刷新已认领版本与 required 状态，下一次手工保存使用新版本', async () => {
        latest.answers[0].reviewStatus = 'reviewed'; await render();
        latest = { ...latest, updatedAt: 'claimed', answers: [{ ...answer, result: null, awardedScore: null, reviewStatus: 'required' }] } as unknown as ReturnType<typeof detail>;
        vi.mocked(apiClient.patch).mockRejectedValueOnce(new ApiError(429, 'Limit', { updatedAt: 'claimed' }));
        await click('重新判分'); expect(container.textContent).toContain('必须复核：1'); expect(button('确认成绩').disabled).toBe(true);
        await edit('结果', 'wrong'); await edit('得分', '0'); await click('保存并标记已复核');
        expect(vi.mocked(apiClient.patch).mock.calls[1][1]).toMatchObject({ expectedUpdatedAt: 'claimed' });
    });
    it.each(['0', '1000.1', '1.55', ''])('非法满分 %s 阻止保存并显示范围', async (value) => {
        await render(); await edit('满分', value); expect(button('保存并标记已复核').disabled).toBe(true); expect(container.textContent).toContain('满分须大于 0 且不超过 1000，最多一位小数');
    });
    it('409 丢弃过期草稿并刷新，后续保存使用服务端版本', async () => {
        await render(); await edit('识别答案', '过期草稿'); latest = { ...latest, updatedAt: 'fresh', answers: [{ ...answer, recognizedAnswer: '他处保存' }] };
        vi.mocked(apiClient.patch).mockRejectedValueOnce(new ApiError(409, 'Conflict', { message: 'EXAM_ATTEMPT_CHANGED' }));
        await click('保存并标记已复核'); expect(field('识别答案').value).toBe('他处保存'); expect(container.querySelector('[role=alert]')?.textContent).toContain('已刷新');
        expect(apiClient.patch).toHaveBeenCalledTimes(1); await click('保存并标记已复核'); expect(vi.mocked(apiClient.patch).mock.calls[1][1]).toMatchObject({ expectedUpdatedAt: 'fresh' });
    });
    it('缺记录、结果和分值分别按题号提示，不能确认', async () => {
        latest.answers = [{ ...answer, result: null, maxScore: null, awardedScore: null, reviewStatus: 'pending' }] as unknown as typeof latest.answers;
        vi.mocked(apiClient.get).mockImplementation(async (url) => url.startsWith('/api/exams/') ? { id: 'p1', status: 'ready', questions: [question, { ...question, id: 'q2', order: 2 }] } : latest);
        await render(); expect(container.textContent).toContain('第 1 题：请选择结果'); expect(container.textContent).toContain('第 1 题：请补充合法满分'); expect(container.textContent).toContain('第 1 题：请补充合法得分'); expect(container.textContent).toContain('第 2 题：缺少作答记录'); expect(button('确认成绩').disabled).toBe(true);
    });
    it('确认期间重复点击只发送一次', async () => {
        latest.answers[0].reviewStatus = 'pending'; let finish!: (value: unknown) => void;
        vi.mocked(apiClient.post).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        await render(); await click('确认成绩'); expect(button('正在确认…').disabled).toBe(true);
        await act(async () => finish({ status: 'confirmed', updatedAt: 'v2' })); expect(apiClient.post).toHaveBeenCalledTimes(1);
    });
    it('路由使用当前作答 ID 加载复核页', async () => {
        await act(async () => root.render(<LanguageProvider><ExamAttemptReviewPage /></LanguageProvider>));
        expect(container.textContent).toContain('第一题题干'); expect(apiClient.get).toHaveBeenCalledWith('/api/exam-attempts/a1?includePages=1');
    });
    it('两题保存草稿依次执行，第二题等第一题完成并携带新版', async () => {
        const answer2 = { ...answer, id: 'ans2', examQuestionId: 'q2' };
        latest.answers.push(answer2);
        vi.mocked(apiClient.get).mockImplementation(async (url) => url.startsWith('/api/exams/') ? { id: 'p1', status: 'ready', questions: [question, { ...question, id: 'q2', order: 2 }] } : latest);
        await render(); await edit('得分', '1.5');
        const score2 = [...container.querySelectorAll<HTMLInputElement>('input')].filter((element) => element.labels?.[0]?.textContent === '得分')[1];
        await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(score2, '3.5'); score2.dispatchEvent(new Event('input', { bubbles: true })); });
        let finish!: (value: unknown) => void;
        vi.mocked(apiClient.patch).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        await click('保存草稿'); expect(apiClient.patch).toHaveBeenCalledTimes(1);
        expect(button('保存草稿').disabled).toBe(true);
        await act(async () => finish({ answer: { ...answer, awardedScore: 1.5, reviewStatus: 'reviewed' }, updatedAt: 'v10' }));
        expect(vi.mocked(apiClient.patch).mock.calls[1][1]).toMatchObject({ expectedUpdatedAt: 'v10', awardedScore: 3.5 });
    });
    it('冲突刷新失败后暂停所有写入，重新加载成功才恢复', async () => {
        await render(); await edit('得分', '2.5');
        vi.mocked(apiClient.patch).mockRejectedValueOnce(new ApiError(409, 'Conflict', {}));
        vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('offline'));
        await click('保存并标记已复核'); expect(container.textContent).toContain('刷新失败，写入已暂停'); expect(button('保存并标记已复核').disabled).toBe(true);
        latest = { ...latest, updatedAt: 'fresh2' }; await click('重新加载'); await click('保存并标记已复核');
        expect(vi.mocked(apiClient.patch).mock.calls[1][1]).toMatchObject({ expectedUpdatedAt: 'fresh2' });
    });
    it.each(['重试第 1 页', '确认成绩'])('%s 的 409 同样刷新且不重复提交', async (action) => {
        latest.answers[0].reviewStatus = 'pending'; await render();
        latest = { ...latest, updatedAt: 'fresh3', answers: [{ ...answer, recognizedAnswer: '最新答案' }] };
        vi.mocked(apiClient.post).mockRejectedValueOnce(new ApiError(409, 'Conflict', {}));
        await click(action); expect(field('识别答案').value).toBe('最新答案'); expect(container.querySelector('[role=alert]')?.textContent).toContain('已刷新'); expect(apiClient.post).toHaveBeenCalledTimes(1); expect(push).not.toHaveBeenCalled();
    });
    it('请求错误正文含图片也仅展示固定错误文案', async () => {
        await render(); vi.mocked(apiClient.patch).mockRejectedValueOnce(new Error('data:image/jpeg;base64,private-image'));
        await click('保存并标记已复核'); expect(container.querySelector('[role=alert]')?.textContent).toContain('操作失败'); expect(container.textContent).not.toContain('base64');
    });
    it('已确认作答只读，不可保存、重判、重试或确认', async () => {
        latest.status = 'confirmed'; await render();
        expect(container.textContent).toContain('成绩已确认'); expect(button('确认成绩')).toBeUndefined(); expect(button('重新判分')).toBeUndefined(); expect(button('重试第 1 页').disabled).toBe(true); expect(field('识别答案').closest('fieldset')?.disabled).toBe(true);
    });
    it('复核分组缺失时回退英文', async () => {
        const context = vi.spyOn(languageContext, 'useLanguage').mockReturnValue({ language: 'en', setLanguage: vi.fn(), t: { ...translations.en, examAttempt: { ...translations.en.examAttempt, review: undefined } } as unknown as Translations });
        try { await render(); expect(container.textContent).toContain('Manual review required'); } finally { context.mockRestore(); }
    });
    it.each([
        ['solution', '选择题', null],
        ['解答题', 'Single Choice', null],
        ['Solution', 'unknown', '单项选择'],
    ])('分组打印编号统一用于卡片、候选和缺项（%s / %s）', async (solutionType, choiceType, linkedType) => {
        latest.answers.push({ ...answer, id: 'ans2', examQuestionId: 'q2', reviewStatus: 'pending' });
        const paper = { id: 'p1', title: '分组卷', status: 'ready', groupByType: true, questions: [
            { ...question, questionType: solutionType },
            { ...question, id: 'q2', order: 2, questionType: choiceType, errorItemQuestionType: linkedType, questionText: '选择题题干' },
            { ...question, id: 'blank', order: 3, questionText: '' },
            { ...question, id: 'failed', order: 4, status: 'failed' },
        ] };
        vi.mocked(apiClient.get).mockImplementation(async (url) => url.startsWith('/api/exams/') ? paper : latest);
        await render();
        const cards = [...container.querySelectorAll('article')];
        expect(cards).toHaveLength(2); expect(cards[0].querySelector('h2')?.textContent).toBe('第 1 题'); expect(cards[0].textContent).toContain('选择题题干');
        expect(cards[1].querySelector('h2')?.textContent).toBe('第 2 题'); expect(cards[1].textContent).toContain('第一题题干');
        expect([...field('目标题目').querySelectorAll('option')].map((option) => [option.value, option.textContent])).toEqual([['', '请选择目标题目'], ['ans2', '第 1 题'], ['ans1', '第 2 题']]);
        expect(container.textContent).toContain('第 2 题：尚未完成人工复核'); expect(container.textContent).not.toContain('第 1 题：尚未完成人工复核');
    });
    it.each([false, true].flatMap((groupByType) => [null, '', ' \n\t '].map((questionText) => ({ groupByType, questionText }))))('复核只显示可打印题，空题干 ready 不产生缺项：%j', async ({ groupByType, questionText }) => {
        latest.answers[0].reviewStatus = 'pending';
        vi.mocked(apiClient.get).mockImplementation(async (url) => url.startsWith('/api/exams/') ? { id: 'p1', status: 'ready', groupByType, questions: [question,
            { ...question, id: 'empty', order: 2, questionText },
            { ...question, id: 'failed', order: 3, status: 'failed', questionText: '失败题不显示' },
        ] } : latest);
        await render();
        expect(container.querySelectorAll('article')).toHaveLength(1);
        expect(container.textContent).toContain('第一题题干');
        expect(container.textContent).not.toContain('失败题不显示');
        expect(container.textContent).not.toContain('第 2 题：');
        expect(button('确认成绩').disabled).toBe(false);
    });
    it('非分组的数据库题序有缺口时仍显示连续打印编号', async () => {
        latest.answers.push({ ...answer, id: 'ans2', examQuestionId: 'q2' });
        vi.mocked(apiClient.get).mockImplementation(async (url) => url.startsWith('/api/exams/') ? { id: 'p1', status: 'ready', groupByType: false, questions: [{ ...question, order: 5 }, { ...question, id: 'q2', order: 9 }] } : latest);
        await render(); expect([...container.querySelectorAll('article h2')].map((heading) => heading.textContent)).toEqual(['第 1 题', '第 2 题']); expect(container.textContent).toContain('第 2 题：尚未完成人工复核');
    });
    it('解除仅发送 null 引用并刷新，可将释放候选映射另一题，映射后仍须判分', async () => {
        latest.answers[0] = { ...answer, reviewStatus: 'reviewed', gradingSource: 'manual', awardedScore: 2.5 };
        latest.answers.push({ ...answer, id: 'ans2', examQuestionId: 'q2', regionJson: null, reviewStatus: 'pending' });
        vi.mocked(apiClient.get).mockImplementation(async (url) => url.startsWith('/api/exams/') ? { id: 'p1', status: 'ready', groupByType: true, questions: [{ ...question, questionType: 'solution' }, { ...question, id: 'q2', order: 2, questionType: 'single_choice' }] } : latest);
        await render(); expect(container.textContent).toContain('当前关联：第 2 题'); expect(button('解除关联')).toBeDefined();
        await click('解除关联'); expect(apiClient.patch).toHaveBeenCalledWith('/api/exam-attempts/a1/answers/ans1', { candidateRef: null, expectedUpdatedAt: 'v1' }, expect.anything());
        const originalCard = container.querySelectorAll('article')[1]; expect(originalCard.textContent).toContain('必须人工复核'); expect(originalCard.querySelector<HTMLInputElement>('input[id$="-score"]')?.value).toBe(''); expect(originalCard.querySelector('textarea')?.value).toBe(''); expect(originalCard.querySelector('select')?.value).toBe('');
        expect(container.textContent).toContain('关联已解除，原题须重新判定'); expect(apiClient.get).toHaveBeenCalledWith('/api/exam-attempts/a1');
        const released = container.querySelector('section[aria-label="第 2 页"] ul')!.children[1] as HTMLLIElement;
        const target = released.querySelector('select')!;
        await act(async () => { target.value = 'ans2'; target.dispatchEvent(new Event('change', { bubbles: true })); });
        await act(async () => released.querySelectorAll('button')[1].click());
        expect(vi.mocked(apiClient.patch).mock.calls[1][1]).toEqual({ candidateRef: { pageOrder: 2, candidateId: 'used' }, expectedUpdatedAt: 'v2' });
        expect(container.textContent).toContain('请人工判定并保存，或重新判分后复核'); expect(button('确认成绩').disabled).toBe(true); expect(container.textContent).not.toContain('已人工复核');
    });
    it('映射成功显示仍需人工判定，不将映射当作人工复核', async () => {
        latest.answers[0].reviewStatus = 'pending'; await render(); await edit('目标题目', 'ans1'); await click('映射到此题');
        expect(field('结果').value).toBe(''); expect(field('得分').value).toBe(''); expect(container.textContent).toContain('请人工判定并保存，或重新判分后复核'); expect(button('确认成绩').disabled).toBe(true);
    });
    it('解除期间阻止重复写入与其他操作，解除后保存携带新版本', async () => {
        await render(); let finish!: (value: unknown) => void;
        vi.mocked(apiClient.patch).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        await click('解除关联'); expect(button('解除关联').disabled).toBe(true); expect(button('重试第 1 页').disabled).toBe(true); expect(container.textContent).toContain('正在解除关联'); await click('解除关联'); expect(apiClient.patch).toHaveBeenCalledTimes(1);
        latest = { ...latest, updatedAt: 'unlink-v2', answers: [{ ...answer, regionJson: null, recognizedAnswer: null, result: null, awardedScore: null }] };
        await act(async () => finish({ answer: latest.answers[0], updatedAt: 'unlink-v2' }));
        await edit('结果', 'wrong'); await edit('得分', '0'); await click('保存并标记已复核'); expect(vi.mocked(apiClient.patch).mock.calls[1][1]).toMatchObject({ expectedUpdatedAt: 'unlink-v2' });
    });
    it.each(['dirty', 'confirmed', 'stale'])('解除在 %s 时禁用', async (mode) => {
        if (mode === 'confirmed') latest.status = 'confirmed'; await render();
        if (mode === 'dirty') await edit('得分', '2.5');
        if (mode === 'stale') { vi.mocked(apiClient.patch).mockRejectedValueOnce(new ApiError(409, 'Conflict', {})); vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('offline')); await click('保存并标记已复核'); }
        expect(button('解除关联').disabled).toBe(true);
    });
    it('解除遭遇 409 刷新关联，不自动覆盖；无关联错误显示可理解提示', async () => {
        await render(); vi.mocked(apiClient.patch).mockRejectedValueOnce(new ApiError(409, 'Conflict', {})); latest = { ...latest, updatedAt: 'fresh-unlink' };
        await click('解除关联'); expect(container.querySelector('[role=alert]')?.textContent).toContain('已刷新'); expect(apiClient.patch).toHaveBeenCalledTimes(1);
        vi.mocked(apiClient.patch).mockRejectedValueOnce(new ApiError(400, 'Bad Request', { message: 'EXAM_ATTEMPT_CANDIDATE_NOT_MAPPED', code: 'VALIDATION_ERROR' })); latest.answers[0].regionJson = null;
        await click('解除关联'); expect(container.querySelector('[role=alert]')?.textContent).toContain('该题已无候选关联'); expect(vi.mocked(apiClient.patch).mock.calls[1][1]).toEqual({ candidateRef: null, expectedUpdatedAt: 'fresh-unlink' });
    });
    it.each(['changed', 'empty'])('人工保存后重试候选 %s，逐题卡仍能解除并映射新候选', async (mode) => {
        await render(); await edit('得分', '2.5'); await click('保存并标记已复核');
        let version = 2;
        let retryCount = 0;
        vi.mocked(apiClient.post).mockImplementation(async () => {
            const candidates = retryCount++ === 0 && mode === 'empty' ? [] : [{ ...candidate, candidateId: 'new-confidence', confidence: 0.6 }];
            latest = { ...latest, updatedAt: `v${++version}`, pages: latest.pages.map((page) => page.order === 2 ? { ...page, recognitionResult: JSON.stringify({ version: 1, status: 'succeeded', candidates, errorCode: null, completedAt: '2026-11-10T00:00:00Z' }) } : page) };
            return { status: 'review', updatedAt: latest.updatedAt, successes: [{ pageOrder: 2, candidateCount: candidates.length, matchedCount: 0 }], failures: [] };
        });
        vi.mocked(apiClient.patch).mockImplementation(async (_url, body) => {
            const { candidateRef } = body as { candidateRef: { pageOrder: number; candidateId: string } | null };
            latest = { ...latest, updatedAt: `v${++version}`, answers: [{ ...latest.answers[0], recognizedAnswer: candidateRef === null ? null : '候选正文', regionJson: candidateRef === null ? null : JSON.stringify({ ...candidateRef, regions: [] }), result: null, awardedScore: null, gradingReason: null, gradingSource: null, reviewStatus: 'required' }] };
            return { answer: latest.answers[0], updatedAt: latest.updatedAt };
        });
        await click('重试第 2 页');
        expect(field('得分').value).toBe('2.5'); expect(container.textContent).toContain('已人工复核');
        const card = container.querySelector('article')!;
        const unmap = [...card.querySelectorAll('button')].find((element) => element.textContent === '解除关联');
        expect(unmap).toBeDefined(); expect(card.textContent).toContain('已关联候选：第 1 题，来源第 2 页');
        await act(async () => unmap!.click());
        expect(vi.mocked(apiClient.patch).mock.calls[1][1]).toEqual({ candidateRef: null, expectedUpdatedAt: 'v3' });
        expect(card.textContent).toContain('必须人工复核'); expect(field('识别答案').value).toBe(''); expect(field('结果').value).toBe(''); expect(field('得分').value).toBe(''); expect(button('确认成绩').disabled).toBe(true);
        expect([...card.querySelectorAll('button')].some((element) => element.textContent === '解除关联')).toBe(false);
        if (mode === 'empty') await click('重试第 2 页');
        await edit('目标题目', 'ans1'); await click('映射到此题');
        expect(vi.mocked(apiClient.patch).mock.calls[2][1]).toEqual({ candidateRef: { pageOrder: 2, candidateId: 'new-confidence' }, expectedUpdatedAt: mode === 'empty' ? 'v5' : 'v4' });
        expect(field('识别答案').value).toBe('候选正文'); expect(card.textContent).toContain('必须人工复核');
    });
    it.each(['dirty', 'confirmed', 'busy', 'stale'])('候选已不在信封时，逐题卡解除在 %s 状态禁用', async (mode) => {
        latest.pages = latest.pages.map((page) => ({ ...page, recognitionResult: null }));
        if (mode === 'confirmed') latest.status = 'confirmed';
        await render();
        let finish: ((value: unknown) => void) | undefined;
        if (mode === 'dirty') await edit('得分', '2.5');
        if (mode === 'busy') { vi.mocked(apiClient.patch).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })); await click('保存并标记已复核'); }
        if (mode === 'stale') { vi.mocked(apiClient.patch).mockRejectedValueOnce(new ApiError(409, 'Conflict', {})); vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('offline')); await click('保存并标记已复核'); }
        const unmap = [...container.querySelector('article')!.querySelectorAll('button')].find((element) => element.textContent === '解除关联');
        expect(unmap).toBeDefined(); expect(unmap!.disabled).toBe(true);
        if (finish) await act(async () => finish!({ answer, updatedAt: 'v2' }));
    });
    it.each([null, JSON.stringify({ pageOrder: 2, candidateId: null, regions: [] })])('答案没有候选引用 %s 时，逐题卡不显示解除入口', async (regionJson) => {
        latest.answers[0].regionJson = regionJson; await render();
        expect([...container.querySelector('article')!.querySelectorAll('button')].some((element) => element.textContent === '解除关联')).toBe(false);
    });
    it('切换作答后迟到写入不污染新作答或导航', async () => {
        latest.answers[0].reviewStatus = 'pending'; let finish!: (value: unknown) => void;
        vi.mocked(apiClient.post).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        await render(); await click('确认成绩'); latest = { ...detail(), id: 'a2', updatedAt: 'new' }; await render('a2');
        await act(async () => finish({ status: 'confirmed', updatedAt: 'old' })); expect(push).not.toHaveBeenCalled(); expect(button('确认成绩').disabled).toBe(true);
    });
});

describe('只读回传区域', () => {
    it('合法区域按需裁切正确页，调用共享 renderRegion', async () => {
        vi.mocked(renderRegion).mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,crop', width: 300, height: 560, bytes: 10, quality: 0.9, timings: { crop: 0, compress: 0 } });
        await act(async () => root.render(<LanguageProvider><AttemptRegionPreview pages={pages} regionJson={region} /></LanguageProvider>));
        expect(renderRegion).not.toHaveBeenCalled();
        const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
        Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, set(value: string) { original.set!.call(this, value); queueMicrotask(() => this.dispatchEvent(new Event('load'))); }, get: original.get });
        try { await click('查看作答区域'); expect(renderRegion).toHaveBeenCalledWith(expect.objectContaining({ width: 1000, height: 1400 }), { x: 0.1, y: 0.2, width: expect.closeTo(0.3), height: expect.closeTo(0.4) }); expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,crop'); } finally { Object.defineProperty(HTMLImageElement.prototype, 'src', original); }
    });
    it('非法区域安全退回所属整页，无拖拽交互', async () => {
        await act(async () => root.render(<LanguageProvider><AttemptRegionPreview pages={pages} regionJson={JSON.stringify({ pageOrder: 2, candidateId: 'x', regions: [{ x: 1, y: 0, width: 1, height: 1 }] })} /></LanguageProvider>));
        await click('查看作答区域'); expect(container.querySelector('img')?.getAttribute('src')).toBe(pages[1].imageData); expect(renderRegion).not.toHaveBeenCalled(); expect(container.textContent).toContain('显示整页');
    });
});
