import { HANDWRITING_QUALITIES, PHOTO_QUALITIES, QUESTION_TYPE_KEYS, SUBJECTS } from '../../exam-evaluation/strata.mjs';

export { HANDWRITING_QUALITIES, PHOTO_QUALITIES, QUESTION_TYPE_KEYS, SUBJECTS };

export class LabelerModelError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'LabelerModelError';
        this.code = code;
    }
}

const round = (value) => Math.round(value * 1_000_000) / 1_000_000;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const validRegion = (region) => region && ['x', 'y', 'width', 'height'].every((key) => typeof region[key] === 'number' && Number.isFinite(region[key])) &&
    region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 && region.x + region.width <= 1 && region.y + region.height <= 1;

export function containImageRect(container, naturalWidth, naturalHeight) {
    if (!container || container.width <= 0 || container.height <= 0 || naturalWidth <= 0 || naturalHeight <= 0) return container;
    const imageRatio = naturalWidth / naturalHeight;
    const containerRatio = container.width / container.height;
    if (imageRatio >= containerRatio) {
        const height = container.width / imageRatio;
        return { left: round(container.left), top: round(container.top + (container.height - height) / 2), width: round(container.width), height: round(height) };
    }
    const width = container.height * imageRatio;
    return { left: round(container.left + (container.width - width) / 2), top: round(container.top), width: round(width), height: round(container.height) };
}

export function normalizeDraggedRegion(start, end, imageRect) {
    if (!imageRect || imageRect.width <= 0 || imageRect.height <= 0) return null;
    const startX = clamp(start.x, imageRect.left, imageRect.left + imageRect.width);
    const startY = clamp(start.y, imageRect.top, imageRect.top + imageRect.height);
    const endX = clamp(end.x, imageRect.left, imageRect.left + imageRect.width);
    const endY = clamp(end.y, imageRect.top, imageRect.top + imageRect.height);
    const x = (Math.min(startX, endX) - imageRect.left) / imageRect.width;
    const y = (Math.min(startY, endY) - imageRect.top) / imageRect.height;
    const width = Math.abs(endX - startX) / imageRect.width;
    const height = Math.abs(endY - startY) / imageRect.height;
    if (width <= 0 || height <= 0) return null;
    return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

export function addRegion(regions, region) {
    if (!validRegion(region)) throw new LabelerModelError('REGION_INVALID', '区域无效');
    if (regions.length >= 4) throw new LabelerModelError('REGION_LIMIT', '每题最多四个区域');
    return [...regions.map((item) => ({ ...item })), { ...region }];
}

function nextQuestion(sample) {
    let displayNumber = 1;
    const numbers = new Set(sample.questions.map((question) => question.displayNumber));
    while (numbers.has(displayNumber)) displayNumber++;
    let id = `q${displayNumber}`;
    const ids = new Set(sample.questions.map((question) => question.id));
    while (ids.has(id)) id = `${id}-new`;
    let sourceShortId = `Q${String(displayNumber).padStart(5, '0')}`;
    const shortIds = new Set(sample.questions.map((question) => question.sourceShortId));
    while (shortIds.has(sourceShortId)) sourceShortId = `${sourceShortId}X`;
    return { id, displayNumber, sourceShortId, questionText: '' };
}

export function updateSample(sample, action) {
    const next = structuredClone(sample);
    if (action.type === 'setField') next[action.field] = action.value;
    if (action.type === 'addQuestion') next.questions.push(nextQuestion(next));
    if (action.type === 'removeQuestion') {
        next.questions = next.questions.filter((question) => question.id !== action.questionId);
        next.expected = next.expected.filter((answer) => answer.questionId !== action.questionId);
    }
    if (action.type === 'setQuestion') next.questions[action.index][action.field] = action.value;
    if (action.type === 'addExpected') next.expected.push({ questionId: action.questionId, normalizedAnswer: '', questionType: 'other', regions: [] });
    if (action.type === 'removeExpected') next.expected.splice(action.index, 1);
    if (action.type === 'setExpected') next.expected[action.index][action.field] = action.value;
    if (action.type === 'addRegion') next.expected[action.index].regions = addRegion(next.expected[action.index].regions, action.region);
    if (action.type === 'removeRegion') next.expected[action.index].regions.splice(action.regionIndex, 1);
    return next;
}

function addError(errors, sampleIndex, field, code, itemIndex) {
    errors.push({ sampleIndex, field, code, ...(itemIndex === undefined ? {} : { itemIndex }) });
}

function text(value, max) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function validateDraftProgress(draft) {
    const errors = [];
    let completedPages = 0;
    let totalExpected = 0;
    for (const [sampleIndex, sample] of (draft?.samples ?? []).entries()) {
        const before = errors.length;
        if (sample.missing) addError(errors, sampleIndex, 'image', 'image_missing');
        if (!text(sample.paperId, 200)) addError(errors, sampleIndex, 'paperId', 'paper_id_required');
        if (!Number.isInteger(sample.grade) || sample.grade < 1 || sample.grade > 6) addError(errors, sampleIndex, 'grade', 'grade_required');
        if (!SUBJECTS.includes(sample.subject)) addError(errors, sampleIndex, 'subject', 'subject_required');
        if (!HANDWRITING_QUALITIES.includes(sample.handwriting)) addError(errors, sampleIndex, 'handwriting', 'handwriting_required');
        if (!PHOTO_QUALITIES.includes(sample.photoQuality)) addError(errors, sampleIndex, 'photoQuality', 'photo_quality_required');
        if (!['zh', 'en'].includes(sample.language)) addError(errors, sampleIndex, 'language', 'language_invalid');
        if (!Array.isArray(sample.questions) || sample.questions.length < 1 || sample.questions.length > 100) addError(errors, sampleIndex, 'questions', 'questions_required');
        const ids = new Set(); const numbers = new Set(); const shortIds = new Set();
        for (const [questionIndex, question] of (sample.questions ?? []).entries()) {
            if (!text(question.id, 200)) addError(errors, sampleIndex, 'questions', 'question_id_required', questionIndex);
            else if (ids.has(question.id)) addError(errors, sampleIndex, 'questions', 'question_id_duplicate', questionIndex);
            ids.add(question.id);
            if (!Number.isInteger(question.displayNumber) || question.displayNumber < 1) addError(errors, sampleIndex, 'questions', 'question_number_invalid', questionIndex);
            else if (numbers.has(question.displayNumber)) addError(errors, sampleIndex, 'questions', 'question_number_duplicate', questionIndex);
            numbers.add(question.displayNumber);
            if (!text(question.sourceShortId, 200)) addError(errors, sampleIndex, 'questions', 'question_short_id_required', questionIndex);
            else if (shortIds.has(question.sourceShortId)) addError(errors, sampleIndex, 'questions', 'question_short_id_duplicate', questionIndex);
            shortIds.add(question.sourceShortId);
            if (!text(question.questionText, 20000)) addError(errors, sampleIndex, 'questions', 'question_text_required', questionIndex);
        }
        if (!Array.isArray(sample.expected) || sample.expected.length < 1) addError(errors, sampleIndex, 'expected', 'expected_required');
        totalExpected += sample.expected?.length ?? 0;
        const expectedIds = new Set();
        for (const [answerIndex, answer] of (sample.expected ?? []).entries()) {
            if (!ids.has(answer.questionId)) addError(errors, sampleIndex, 'expected', 'expected_question_unknown', answerIndex);
            else if (expectedIds.has(answer.questionId)) addError(errors, sampleIndex, 'expected', 'expected_question_duplicate', answerIndex);
            expectedIds.add(answer.questionId);
            if (typeof answer.normalizedAnswer !== 'string' || answer.normalizedAnswer.length > 20000) addError(errors, sampleIndex, 'expected', 'answer_invalid', answerIndex);
            if (!QUESTION_TYPE_KEYS.includes(answer.questionType)) addError(errors, sampleIndex, 'expected', 'question_type_invalid', answerIndex);
            if (!Array.isArray(answer.regions) || answer.regions.length < 1 || answer.regions.length > 4 || answer.regions.some((region) => !validRegion(region))) addError(errors, sampleIndex, 'expected', 'regions_invalid', answerIndex);
        }
        if (errors.length === before) completedPages++;
    }
    const totalPages = draft?.samples?.length ?? 0;
    return { complete: totalPages > 0 && completedPages === totalPages, totalPages, completedPages, totalExpected, errors };
}

export function markDraftConflict(state) {
    return { ...state, conflicted: true, dirty: false };
}
