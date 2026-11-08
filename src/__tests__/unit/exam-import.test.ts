import { describe, expect, it } from 'vitest';

import {
    buildImportedQuestions,
    checksumExamPage,
    parseExamRegions,
    validateImportedExamForPublish,
} from '@/lib/exam/exam-import';
import {
    createImportedExamSchema,
    recognizeExamPagesSchema,
    updateImportedExamSchema,
    upsertExamPagesSchema,
} from '@/lib/schemas/exam';

const jpegPage = (order: number, imageData = `data:image/jpeg;base64,cGFnZS0${order}`) => ({
    order,
    role: 'questions' as const,
    imageData,
    mimeType: 'image/jpeg',
    width: 1200,
    height: 1600,
});

describe('外部试卷导入 schema', () => {
    it('接受 1～20 个物理页序唯一的压缩页图', () => {
        const parsed = createImportedExamSchema.safeParse({
            title: '三年级数学单元测验',
            subjectId: 'math-1',
            examType: 'unit',
            pages: Array.from({ length: 20 }, (_, index) => jpegPage(index + 1)),
        });

        expect(parsed.success).toBe(true);
    });

    it('拒绝空试卷、超过 20 页和跨角色重复的物理页序', () => {
        expect(createImportedExamSchema.safeParse({ title: '空', subjectId: 's1', pages: [] }).success).toBe(false);
        expect(createImportedExamSchema.safeParse({
            title: '超限', subjectId: 's1', pages: Array.from({ length: 21 }, (_, index) => jpegPage(index + 1)),
        }).success).toBe(false);
        expect(createImportedExamSchema.safeParse({
            title: '重复页序',
            subjectId: 's1',
            pages: [jpegPage(1), { ...jpegPage(1, 'data:image/jpeg;base64,YW5zd2Vy'), role: 'answer_key' }],
        }).success).toBe(false);
    });

    it('拒绝重复图片、MIME 与 data URL 不匹配、非法尺寸和超长页图', () => {
        const same = 'data:image/jpeg;base64,c2FtZQ==';
        expect(createImportedExamSchema.safeParse({
            title: '重复图片', subjectId: 's1', pages: [jpegPage(1, same), jpegPage(2, same)],
        }).success).toBe(false);
        expect(upsertExamPagesSchema.safeParse({
            pages: [{ ...jpegPage(1), imageData: 'data:image/png;base64,cGFnZQ==', mimeType: 'image/jpeg' }],
        }).success).toBe(false);
        expect(upsertExamPagesSchema.safeParse({ pages: [{ ...jpegPage(1), width: 5000 }] }).success).toBe(false);
        expect(upsertExamPagesSchema.safeParse({
            pages: [{ ...jpegPage(1), imageData: `data:image/jpeg;base64,${'A'.repeat(2_100_001)}` }],
        }).success).toBe(false);
    });

    it('识别页序去重并限制在 1～20 页', () => {
        expect(recognizeExamPagesSchema.safeParse({ pageOrders: [1, 3, 20] }).success).toBe(true);
        expect(recognizeExamPagesSchema.safeParse({ pageOrders: [1, 1] }).success).toBe(false);
        expect(recognizeExamPagesSchema.safeParse({ pageOrders: [0] }).success).toBe(false);
    });

    it('校对请求接受页面角色以及带 ID 和不带 ID 的有序题目', () => {
        const parsed = updateImportedExamSchema.safeParse({
            kind: 'import-draft',
            title: '期中卷',
            pages: [{ id: 'page-1', order: 1, role: 'questions' }, { id: 'page-2', order: 2, role: 'answer_key' }],
            questions: [
                { id: 'question-1', externalNumber: '1', pageNumber: 1, regions: [{ x: 0.1, y: 0.1, width: 0.8, height: 0.2 }], questionText: '1 + 1 = ?', score: 5 },
                { externalNumber: '2', pageNumber: 1, regions: [{ x: 0.1, y: 0.4, width: 0.8, height: 0.2 }], questionText: '2 + 2 = ?', score: 5 },
            ],
            publish: false,
        });

        expect(parsed.success).toBe(true);
    });
});

describe('外部试卷导入领域函数', () => {
    it('对页图 data URL 计算稳定 SHA-256', async () => {
        await expect(checksumExamPage('data:image/jpeg;base64,YQ=='))
            .resolves.toBe('b0e5e5108a69e3106d1064b552e1ee79b024f6f7cb5ceb8ad9d6540a7a175be5');
    });

    it('兼容解析单个区域和区域数组并丢弃非法值', () => {
        expect(parseExamRegions('{"x":0.1,"y":0.2,"width":0.3,"height":0.4}')).toEqual([
            { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        ]);
        expect(parseExamRegions('[{"x":0.1,"y":0.2,"width":0.3,"height":0.4},{"x":2,"y":0,"width":0.2,"height":0.2}]')).toEqual([
            { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        ]);
        expect(parseExamRegions('not-json')).toEqual([]);
    });

    it('把分题结果映射为本页稳定占位 ID、区域和人工复核提示', () => {
        const questions = buildImportedQuestions(2, {
            questions: [
                {
                    label: '3(1)',
                    text: '计算 12 ÷ 3。',
                    material: '根据下面材料回答。',
                    section: '计算题',
                    regions: [{ x: 0.1, y: 0.2, width: 0.7, height: 0.2 }],
                    hasFigure: false,
                    flags: [],
                },
                {
                    label: null,
                    text: '看图作答。',
                    material: null,
                    section: null,
                    regions: [],
                    hasFigure: true,
                    flags: ['unlocated'],
                },
            ],
            ignored: [],
            warnings: [],
        });

        expect(questions).toEqual([
            expect.objectContaining({
                sourceShortId: 'IMP002001',
                externalNumber: '3(1)',
                pageNumber: 2,
                questionText: '根据下面材料回答。\n\n计算 12 ÷ 3。',
                regionJson: '[{"x":0.1,"y":0.2,"width":0.7,"height":0.2}]',
                recognitionConfidence: null,
                status: 'ready',
            }),
            expect.objectContaining({
                sourceShortId: 'IMP002002',
                externalNumber: null,
                pageNumber: 2,
                regionJson: '[]',
                recognitionConfidence: 0.5,
            }),
        ]);
    });

    it('发布要求每个题目页有题、题干和区域有效且页码不能指向答案页', () => {
        const result = validateImportedExamForPublish({
            pages: [{ order: 1, role: 'questions' }, { order: 2, role: 'answer_key' }],
            questions: [
                { pageNumber: 2, questionText: ' ', regions: [], score: 5 },
            ],
            totalScore: 5,
        });

        expect(result).toEqual({
            ok: false,
            errors: ['QUESTION_PAGE_EMPTY', 'QUESTION_PAGE_INVALID', 'QUESTION_TEXT_REQUIRED', 'QUESTION_REGION_REQUIRED'],
        });
    });

    it('标称总分必须与完整题目分值之和一致', () => {
        const result = validateImportedExamForPublish({
            pages: [{ order: 1, role: 'questions' }],
            questions: [
                { pageNumber: 1, questionText: '题一', regions: [{ x: 0, y: 0, width: 1, height: 0.4 }], score: 4 },
                { pageNumber: 1, questionText: '题二', regions: [{ x: 0, y: 0.5, width: 1, height: 0.4 }], score: 5 },
            ],
            totalScore: 10,
        });

        expect(result).toEqual({ ok: false, errors: ['TOTAL_SCORE_MISMATCH'] });
    });

    it('总分为空且每题都有分值时推导总分，不完整时保持空', () => {
        const pages = [{ order: 1, role: 'questions' as const }];
        const regions = [{ x: 0, y: 0, width: 1, height: 0.4 }];

        expect(validateImportedExamForPublish({
            pages,
            questions: [
                { pageNumber: 1, questionText: '题一', regions, score: 4 },
                { pageNumber: 1, questionText: '题二', regions, score: 6 },
            ],
            totalScore: null,
        })).toEqual({ ok: true, totalScore: 10 });

        expect(validateImportedExamForPublish({
            pages,
            questions: [{ pageNumber: 1, questionText: '题一', regions, score: null }],
            totalScore: null,
        })).toEqual({ ok: true, totalScore: null });
    });
});
