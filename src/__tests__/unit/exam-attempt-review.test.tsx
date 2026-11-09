import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamAttemptReview } from '@/components/exam-attempt/exam-attempt-review';
import { AttemptRegionPreview } from '@/components/exam-attempt/attempt-region-preview';
import * as languageContext from '@/contexts/LanguageContext';
import { translations } from '@/lib/translations';
import type { Translations } from '@/lib/translations';
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
const pages = [1, 2].map((order) => ({ id: `pg${order}`, attemptId: 'a1', order, imageData: `data:image/jpeg;base64,YQ==${order}`, mimeType: 'image/jpeg', width: 1000, height: 1400, checksum: `sum${order}`, recognitionResult: JSON.stringify({ version: 1, status: order === 1 ? 'failed' : 'succeeded', candidates: order === 1 ? [] : [candidate, { ...candidate, candidateId: 'used' }], errorCode: order === 1 ? 'TIMEOUT' : null, completedAt: '2026-11-09T00:00:00Z' }), createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z' }));
const answer = { id: 'ans1', attemptId: 'a1', examQuestionId: 'q1', recognizedAnswer: '原答案', result: 'wrong', awardedScore: 0, maxScore: 5, gradingSource: 'ai', gradingReason: '判分理由', confidence: 0.5, reviewStatus: 'required', regionJson: region, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z' };
const question = { id: 'q1', order: 1, errorItemId: null, sourceShortId: 'S1', status: 'ready', questionText: '第一题题干', answerText: '标准答案', analysis: null, score: 5, error: null, notebookName: null, attempts: [] };
function detail() { return { id: 'a1', userId: 'u1', paperId: 'p1', status: 'review', updatedAt: 'v1', takenAt: '2026-11-09T00:00:00Z', comment: null, totalScore: null, maxScore: null, confirmedAt: null, createdAt: '2026-11-09T00:00:00Z', paper: { id: 'p1', title: '测试卷', status: 'ready', origin: 'imported' }, pages, answers: [{ ...answer }] }; }
let latest: ReturnType<typeof detail>;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    latest = detail();
    vi.mocked(apiClient.get).mockImplementation(async (url) => url.startsWith('/api/exams/') ? { id: 'p1', title: '测试卷', status: 'ready', questions: [question] } : latest);
    vi.mocked(apiClient.patch).mockImplementation(async (_url, body) => { const changes = body as Record<string, unknown>; latest = { ...latest, updatedAt: 'v2', answers: [{ ...latest.answers[0], ...changes, reviewStatus: changes.regrade ? 'required' : 'reviewed', gradingSource: changes.regrade ? 'ai' : 'manual' }] }; return { answer: latest.answers[0], updatedAt: latest.updatedAt }; });
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
