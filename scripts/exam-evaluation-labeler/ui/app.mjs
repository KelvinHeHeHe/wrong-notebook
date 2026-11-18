import {
    HANDWRITING_QUALITIES,
    PHOTO_QUALITIES,
    QUESTION_TYPE_KEYS,
    SUBJECTS,
    LabelerModelError,
    containImageRect,
    markDraftConflict,
    normalizeDraggedRegion,
    updateSample,
    validateDraftProgress,
} from './model.mjs';

const QUESTION_TYPE_NAMES = {
    single_choice: '单选题', multiple_choice: '多选题', true_false: '判断题', fill_blank: '填空题', calculation: '计算题',
    solution: '解答题', reading: '阅读理解', cloze: '完形填空', writing: '写作', other: '其他',
};
const ERROR_MESSAGES = {
    image_missing: '照片已从私有目录移除', paper_id_required: '需要试卷标识', grade_required: '需要 1～6 年级', subject_required: '需要学科',
    handwriting_required: '需要书写质量', photo_quality_required: '需要拍摄质量', language_invalid: '识别语言无效', questions_required: '至少需要一道候选题',
    question_id_required: '题目 ID 不能为空', question_id_duplicate: '题目 ID 重复', question_number_invalid: '题号必须是正整数', question_number_duplicate: '题号重复',
    question_short_id_required: '短码不能为空', question_short_id_duplicate: '短码重复', question_text_required: '题干不能为空', expected_required: '至少需要一个期望答案',
    expected_question_unknown: '期望答案未关联现有题目', expected_question_duplicate: '同一道题只能标注一次', answer_invalid: '学生答案无效', question_type_invalid: '题型无效', regions_invalid: '每个答案需要 1～4 个有效区域框',
};

const ids = [
    'app-main', 'progress', 'status', 'previous-page', 'next-page', 'save-draft', 'export-manifest', 'reload-page', 'page-title', 'page-position',
    'sample-image', 'image-stage', 'region-canvas', 'paper-id', 'grade', 'subject', 'handwriting', 'photo-quality', 'language', 'questions', 'answers',
    'add-question', 'add-answer', 'delete-missing-page', 'validation-errors',
];
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const state = {
    token: '', data: null, pageIndex: 0, selectedAnswer: 0,
    dirty: false, savePromise: null, conflicted: false, saveTimer: 0, imageUrl: '', dragStart: null,
};

function node(tag, { className, text, type } = {}) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    if (type) value.type = type;
    return value;
}

function setStatus(message, kind = '') {
    elements.status.textContent = message;
    elements.status.className = `status${kind ? ` ${kind}` : ''}`;
}

function populateSelect(select, values, placeholder, labels = {}) {
    select.replaceChildren();
    const empty = node('option', { text: placeholder });
    empty.value = '';
    select.append(empty);
    for (const value of values) {
        const option = node('option', { text: labels[value] ?? value });
        option.value = value;
        select.append(option);
    }
}

function currentSample() {
    return state.data?.draft.samples[state.pageIndex];
}

class ApiError extends Error {
    constructor(status, code) { super(code); this.status = status; this.code = code; }
}

async function api(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('X-Evaluation-Token', state.token);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers });
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json') ? await response.json() : await response.blob();
    if (!response.ok) throw new ApiError(response.status, body?.error ?? 'request_failed');
    return body;
}

function mutate(action, rerender = false) {
    if (state.conflicted || !currentSample()) return;
    state.data.draft.samples[state.pageIndex] = updateSample(currentSample(), action);
    markDirty();
    if (rerender) renderPage();
    else renderProgress();
}

function markDirty() {
    state.dirty = true;
    setStatus('有未保存的修改');
    clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => { void saveNow(); }, 500);
}

async function saveNow() {
    clearTimeout(state.saveTimer);
    if (!state.data || state.conflicted) return;
    if (state.savePromise) {
        try { await state.savePromise; } catch { /* 原调用负责呈现错误；这里仅等待完成 */ }
        if (state.dirty && !state.conflicted) return saveNow();
        return;
    }
    if (!state.dirty) return;
    state.dirty = false;
    state.savePromise = (async () => {
        const result = await api('/api/draft', { method: 'PUT', body: JSON.stringify({ revision: state.data.draft.revision, draft: state.data.draft }) });
        state.data.draft.revision = result.revision;
        setStatus(`草稿已保存（版本 ${result.revision}）`, 'success');
    })();
    try {
        await state.savePromise;
    } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
            Object.assign(state, markDraftConflict(state));
            renderConflict();
        } else {
            state.dirty = true;
            setStatus('草稿保存失败，请检查本机服务后重试', 'error');
        }
    } finally {
        state.savePromise = null;
        if (state.dirty && !state.conflicted) state.saveTimer = window.setTimeout(() => { void saveNow(); }, 500);
    }
}

function renderConflict() {
    elements['app-main'].classList.add('readonly');
    elements['reload-page'].classList.remove('hidden');
    for (const control of document.querySelectorAll('input, select, textarea, button')) control.disabled = control !== elements['reload-page'];
    setStatus('草稿已在另一个标签页更新。为避免覆盖，请重新加载。', 'error');
}

function field(labelText, input) {
    const label = node('label', { text: labelText });
    label.append(input);
    return label;
}

function textInput(value, onInput, options = {}) {
    const input = node(options.multiline ? 'textarea' : 'input');
    input.value = value ?? '';
    if (options.type) input.type = options.type;
    if (options.maxLength) input.maxLength = options.maxLength;
    input.addEventListener('input', () => onInput(options.type === 'number' ? Number(input.value) : input.value));
    return input;
}

function selectInput(values, value, onChange, labels = {}) {
    const select = node('select');
    populateSelect(select, values, '请选择', labels);
    select.value = value ?? '';
    select.addEventListener('change', () => onChange(select.value));
    return select;
}

function renderQuestions() {
    elements.questions.replaceChildren();
    const sample = currentSample();
    if (!sample.questions.length) elements.questions.append(node('p', { className: 'empty', text: '尚未添加候选题。' }));
    sample.questions.forEach((question, index) => {
        const card = node('article', { className: 'card' });
        const actions = node('div', { className: 'card-actions' });
        actions.append(node('strong', { text: `题目 ${index + 1}` }));
        const remove = node('button', { text: '删除题目', type: 'button' });
        remove.addEventListener('click', () => mutate({ type: 'removeQuestion', questionId: question.id }, true));
        actions.append(remove);
        const grid = node('div', { className: 'card-grid' });
        grid.append(
            field('题目 ID', textInput(question.id, (value) => mutate({ type: 'setQuestion', index, field: 'id', value }), { maxLength: 200 })),
            field('连续题号', textInput(String(question.displayNumber || ''), (value) => mutate({ type: 'setQuestion', index, field: 'displayNumber', value }), { type: 'number' })),
            field('打印短码', textInput(question.sourceShortId, (value) => mutate({ type: 'setQuestion', index, field: 'sourceShortId', value }), { maxLength: 200 })),
        );
        const questionText = field('脱敏题干', textInput(question.questionText, (value) => mutate({ type: 'setQuestion', index, field: 'questionText', value }), { multiline: true, maxLength: 20000 }));
        questionText.className = 'wide';
        grid.append(questionText);
        card.append(actions, grid);
        elements.questions.append(card);
    });
}

function renderAnswers() {
    elements.answers.replaceChildren();
    const sample = currentSample();
    if (!sample.expected.length) elements.answers.append(node('p', { className: 'empty', text: '尚未添加期望答案。' }));
    sample.expected.forEach((answer, index) => {
        const card = node('article', { className: `card${index === state.selectedAnswer ? ' selected' : ''}` });
        card.addEventListener('click', () => { state.selectedAnswer = index; renderAnswers(); drawRegions(); });
        const actions = node('div', { className: 'card-actions' });
        actions.append(node('strong', { text: `答案 ${index + 1}` }));
        const remove = node('button', { text: '删除答案', type: 'button' });
        remove.addEventListener('click', (event) => { event.stopPropagation(); mutate({ type: 'removeExpected', index }, true); });
        actions.append(remove);
        const grid = node('div', { className: 'card-grid' });
        grid.append(
            field('对应题目', selectInput(sample.questions.map((question) => question.id), answer.questionId, (value) => mutate({ type: 'setExpected', index, field: 'questionId', value }))),
            field('题型', selectInput(QUESTION_TYPE_KEYS, answer.questionType, (value) => mutate({ type: 'setExpected', index, field: 'questionType', value }), QUESTION_TYPE_NAMES)),
        );
        const answerField = field('学生实际书写内容（未作答可留空）', textInput(answer.normalizedAnswer, (value) => mutate({ type: 'setExpected', index, field: 'normalizedAnswer', value }), { multiline: true, maxLength: 20000 }));
        answerField.className = 'wide';
        grid.append(answerField);
        const regions = node('div', { className: 'regions wide' });
        answer.regions.forEach((region, regionIndex) => {
            const text = `删除区域 ${regionIndex + 1}（${Math.round(region.x * 100)}%, ${Math.round(region.y * 100)}%）`;
            const button = node('button', { text, type: 'button' });
            button.addEventListener('click', (event) => { event.stopPropagation(); mutate({ type: 'removeRegion', index, regionIndex }, true); });
            regions.append(button);
        });
        if (!answer.regions.length) regions.append(node('span', { className: 'empty', text: '请在左侧照片拖拽框选区域' }));
        grid.append(regions);
        card.append(actions, grid);
        elements.answers.append(card);
    });
}

function renderProgress() {
    const result = validateDraftProgress(state.data.draft);
    elements.progress.textContent = `${result.completedPages}/${result.totalPages} 页完成，已标注 ${result.totalExpected} 道题`;
    elements['validation-errors'].replaceChildren();
    const currentErrors = result.errors.filter((error) => error.sampleIndex === state.pageIndex);
    if (!currentErrors.length) elements['validation-errors'].append(node('li', { text: '当前页字段完整' }));
    for (const error of currentErrors) elements['validation-errors'].append(node('li', { text: ERROR_MESSAGES[error.code] ?? '字段无效' }));
    elements['export-manifest'].disabled = state.conflicted || !result.complete;
    return result;
}

function drawRegions() {
    const canvas = elements['region-canvas'];
    const rect = canvas.getBoundingClientRect();
    const content = containImageRect(rect, elements['sample-image'].naturalWidth, elements['sample-image'].naturalHeight);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    context.lineWidth = 2;
    currentSample()?.expected.forEach((answer, answerIndex) => {
        context.strokeStyle = answerIndex === state.selectedAnswer ? '#2563eb' : '#f97316';
        answer.regions.forEach((region) => context.strokeRect(
            content.left - rect.left + region.x * content.width,
            content.top - rect.top + region.y * content.height,
            region.width * content.width,
            region.height * content.height,
        ));
    });
}

async function loadImage() {
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    const sample = currentSample();
    const image = state.data.images.find((item) => item.image === sample.image);
    if (!image || sample.missing) {
        elements['sample-image'].removeAttribute('src');
        setStatus('当前照片已缺失，请恢复文件或删除该草稿页', 'error');
        drawRegions();
        return;
    }
    const blob = await api(`/api/image/${encodeURIComponent(image.id)}`);
    state.imageUrl = URL.createObjectURL(blob);
    elements['sample-image'].src = state.imageUrl;
}

function renderPage() {
    const sample = currentSample();
    if (!sample) return;
    state.selectedAnswer = Math.min(state.selectedAnswer, Math.max(0, sample.expected.length - 1));
    elements['page-position'].textContent = `${state.pageIndex + 1} / ${state.data.draft.samples.length}`;
    elements['page-title'].textContent = `样本照片 ${state.pageIndex + 1}`;
    elements['delete-missing-page'].classList.toggle('hidden', !sample.missing);
    elements['paper-id'].value = sample.paperId;
    elements.grade.value = sample.grade ?? '';
    elements.subject.value = sample.subject;
    elements.handwriting.value = sample.handwriting;
    elements['photo-quality'].value = sample.photoQuality;
    elements.language.value = sample.language;
    elements['previous-page'].disabled = state.conflicted || state.pageIndex === 0;
    elements['next-page'].disabled = state.conflicted || state.pageIndex >= state.data.draft.samples.length - 1;
    renderQuestions();
    renderAnswers();
    renderProgress();
    void loadImage().catch(() => setStatus('照片读取失败，请检查私有目录', 'error'));
}

async function navigate(offset) {
    await saveNow();
    if (state.conflicted) return;
    state.pageIndex = Math.max(0, Math.min(state.data.draft.samples.length - 1, state.pageIndex + offset));
    state.selectedAnswer = 0;
    renderPage();
}

async function exportManifest() {
    const progress = renderProgress();
    if (!progress.complete) { setStatus('请先修正所有页面的完成度问题', 'error'); return; }
    await saveNow();
    if (state.conflicted || state.dirty) return;
    try {
        const result = await api('/api/export', { method: 'POST', body: JSON.stringify({ revision: state.data.draft.revision }) });
        setStatus(`评测清单已导出：${result.sampleCount} 页、${result.expectedCount} 道题`, 'success');
    } catch (error) {
        if (error instanceof ApiError && error.status === 409) renderConflict();
        else setStatus('导出失败，请检查完成度或文件权限', 'error');
    }
}

function bindStaticControls() {
    populateSelect(elements.grade, ['1', '2', '3', '4', '5', '6'], '请选择年级');
    populateSelect(elements.subject, SUBJECTS, '请选择学科');
    populateSelect(elements.handwriting, HANDWRITING_QUALITIES, '请选择书写质量');
    populateSelect(elements['photo-quality'], PHOTO_QUALITIES, '请选择拍摄质量');
    populateSelect(elements.language, ['zh', 'en'], '请选择语言', { zh: '中文', en: '英文' });
    elements['paper-id'].addEventListener('input', () => mutate({ type: 'setField', field: 'paperId', value: elements['paper-id'].value }));
    elements.grade.addEventListener('change', () => mutate({ type: 'setField', field: 'grade', value: Number(elements.grade.value) || null }));
    elements.subject.addEventListener('change', () => mutate({ type: 'setField', field: 'subject', value: elements.subject.value }));
    elements.handwriting.addEventListener('change', () => mutate({ type: 'setField', field: 'handwriting', value: elements.handwriting.value }));
    elements['photo-quality'].addEventListener('change', () => mutate({ type: 'setField', field: 'photoQuality', value: elements['photo-quality'].value }));
    elements.language.addEventListener('change', () => mutate({ type: 'setField', field: 'language', value: elements.language.value }));
    elements['add-question'].addEventListener('click', () => mutate({ type: 'addQuestion' }, true));
    elements['add-answer'].addEventListener('click', () => {
        const sample = currentSample();
        const assigned = new Set(sample.expected.map((answer) => answer.questionId));
        const question = sample.questions.find((item) => !assigned.has(item.id));
        if (!question) { setStatus('请先添加尚未标注的候选题', 'error'); return; }
        state.selectedAnswer = sample.expected.length;
        mutate({ type: 'addExpected', questionId: question.id }, true);
    });
    elements['delete-missing-page'].addEventListener('click', () => {
        if (!currentSample()?.missing || !window.confirm('仅移除这条缺失照片的草稿标注，不会删除任何照片。继续吗？')) return;
        state.data.draft.samples.splice(state.pageIndex, 1);
        state.pageIndex = Math.min(state.pageIndex, state.data.draft.samples.length - 1);
        state.selectedAnswer = 0;
        markDirty();
        renderPage();
    });
    elements['previous-page'].addEventListener('click', () => void navigate(-1));
    elements['next-page'].addEventListener('click', () => void navigate(1));
    elements['save-draft'].addEventListener('click', () => void saveNow());
    elements['export-manifest'].addEventListener('click', () => void exportManifest());
    elements['reload-page'].addEventListener('click', () => location.reload());
}

function bindCanvas() {
    const canvas = elements['region-canvas'];
    canvas.addEventListener('pointerdown', (event) => { state.dragStart = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener('pointerup', (event) => {
        if (!state.dragStart || !currentSample()?.expected[state.selectedAnswer]) return;
        const canvasRect = canvas.getBoundingClientRect();
        const contentRect = containImageRect(canvasRect, elements['sample-image'].naturalWidth, elements['sample-image'].naturalHeight);
        const region = normalizeDraggedRegion(state.dragStart, { x: event.clientX, y: event.clientY }, contentRect);
        state.dragStart = null;
        if (!region) return;
        try { mutate({ type: 'addRegion', index: state.selectedAnswer, region }, true); }
        catch (error) { if (error instanceof LabelerModelError) setStatus('每个答案最多四个有效区域', 'error'); }
    });
    elements['sample-image'].addEventListener('load', drawRegions);
    new ResizeObserver(drawRegions).observe(elements['image-stage']);
}

function bindKeyboard() {
    document.addEventListener('keydown', (event) => {
        const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveNow(); return; }
        if (editing) return;
        if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); void navigate(-1); }
        if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); void navigate(1); }
        if (event.key === 'Delete' && currentSample()?.expected[state.selectedAnswer]?.regions.length) {
            event.preventDefault();
            const regions = currentSample().expected[state.selectedAnswer].regions;
            mutate({ type: 'removeRegion', index: state.selectedAnswer, regionIndex: regions.length - 1 }, true);
        }
    });
}

async function start() {
    const parameters = new URLSearchParams(location.hash.slice(1));
    state.token = parameters.get('token') ?? '';
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (!state.token) { setStatus('启动链接缺少会话令牌，请回到终端复制完整地址', 'error'); return; }
    bindStaticControls();
    bindCanvas();
    bindKeyboard();
    try {
        state.data = await api('/api/state');
        elements['app-main'].setAttribute('aria-busy', 'false');
        renderPage();
        setStatus('私有样本已载入；修改会自动保存');
    } catch {
        setStatus('无法读取私有样本，请确认本机标注服务仍在运行', 'error');
    }
}

void start();
