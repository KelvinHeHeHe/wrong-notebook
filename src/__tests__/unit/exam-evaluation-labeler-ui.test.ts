// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { QUESTION_TYPE_KEYS as SERVER_QUESTION_TYPES } from '../../../scripts/exam-evaluation/manifest.mjs';
import {
    QUESTION_TYPE_KEYS,
    addRegion,
    containImageRect,
    markDraftConflict,
    normalizeDraggedRegion,
    updateSample,
    validateDraftProgress,
} from '../../../scripts/exam-evaluation-labeler/ui/model.mjs';

const rect = { left: 100, top: 50, width: 400, height: 800 };
const completeSample = () => ({
    image: 'photos/page-1.jpg', missing: false, paperId: 'paper-1', grade: 3, subject: '数学', handwriting: '清晰', photoQuality: '阴影', language: 'zh',
    questions: [{ id: 'q1', displayNumber: 1, sourceShortId: 'SRC001', questionText: '脱敏题目' }],
    expected: [{ questionId: 'q1', normalizedAnswer: '7', questionType: 'calculation', regions: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.2 }] }],
});

describe('家庭样本标注界面模型', () => {
    it('正向和反向拖拽生成相同归一化框，缩放不改变坐标', () => {
        const expected = { x: 0.1, y: 0.1, width: 0.3, height: 0.2 };
        expect(normalizeDraggedRegion({ x: 140, y: 130 }, { x: 260, y: 290 }, rect)).toEqual(expected);
        expect(normalizeDraggedRegion({ x: 260, y: 290 }, { x: 140, y: 130 }, rect)).toEqual(expected);
        expect(normalizeDraggedRegion({ x: 70, y: 65 }, { x: 130, y: 145 }, { left: 50, top: 25, width: 200, height: 400 })).toEqual(expected);
    });

    it('拖拽裁剪到图片内容边界，零面积不生成区域', () => {
        expect(normalizeDraggedRegion({ x: 0, y: 0 }, { x: 600, y: 1000 }, rect)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
        expect(normalizeDraggedRegion({ x: 140, y: 130 }, { x: 140, y: 200 }, rect)).toBeNull();
        expect(normalizeDraggedRegion({ x: 10, y: 10 }, { x: 20, y: 20 }, rect)).toBeNull();
    });

    it('按 contain 后的真实图片内容排除上下或左右留白', () => {
        expect(containImageRect({ left: 10, top: 20, width: 400, height: 400 }, 800, 400)).toEqual({ left: 10, top: 120, width: 400, height: 200 });
        expect(containImageRect({ left: 10, top: 20, width: 400, height: 400 }, 400, 800)).toEqual({ left: 110, top: 20, width: 200, height: 400 });
        const content = containImageRect({ left: 10, top: 20, width: 400, height: 400 }, 800, 400);
        expect(normalizeDraggedRegion({ x: 20, y: 40 }, { x: 200, y: 80 }, content)).toBeNull();
    });

    it('每个期望答案最多保存四个区域框', () => {
        const regions = Array.from({ length: 4 }, (_, index) => ({ x: index * 0.1, y: 0, width: 0.05, height: 0.05 }));
        expect(() => addRegion(regions, { x: 0.5, y: 0.5, width: 0.1, height: 0.1 })).toThrow(expect.objectContaining({ code: 'REGION_LIMIT' }));
        expect(addRegion([], { x: 0.5, y: 0.5, width: 0.1, height: 0.1 })).toHaveLength(1);
    });

    it('删除候选题时同步删除归属于它的期望答案', () => {
        const sample = completeSample();
        sample.questions.push({ id: 'q2', displayNumber: 2, sourceShortId: 'SRC002', questionText: '第二题' });
        sample.expected.push({ questionId: 'q2', normalizedAnswer: '8', questionType: 'calculation', regions: [{ x: 0.2, y: 0.5, width: 0.2, height: 0.1 }] });
        const updated = updateSample(sample, { type: 'removeQuestion', questionId: 'q1' });
        expect(updated.questions.map((question: { id: string }) => question.id)).toEqual(['q2']);
        expect(updated.expected.map((answer: { questionId: string }) => answer.questionId)).toEqual(['q2']);
        expect(sample.questions).toHaveLength(2);
    });

    it('题型选项与服务端严格契约保持一致', () => {
        expect(QUESTION_TYPE_KEYS).toEqual(SERVER_QUESTION_TYPES);
    });

    it('完成度报告定位缺失分层、重复标识、无效区域和缺图，不回显私有文本', () => {
        const sample = completeSample();
        sample.missing = true;
        sample.subject = '';
        sample.questions.push({ ...sample.questions[0], questionText: '另一个私有题目' });
        sample.expected[0].regions = [];
        const result = validateDraftProgress({ version: 1, revision: 0, samples: [sample] });
        expect(result).toMatchObject({ complete: false, totalPages: 1, completedPages: 0, totalExpected: 1 });
        expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['image_missing', 'subject_required', 'question_id_duplicate', 'question_number_duplicate', 'question_short_id_duplicate', 'regions_invalid']));
        expect(JSON.stringify(result)).not.toContain('另一个私有题目');
    });

    it('完整草稿可导出，revision 冲突会进入只读重载状态', () => {
        expect(validateDraftProgress({ version: 1, revision: 2, samples: [completeSample()] })).toMatchObject({ complete: true, completedPages: 1 });
        expect(markDraftConflict({ conflicted: false, dirty: true })).toEqual({ conflicted: true, dirty: false });
    });
});
