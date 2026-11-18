// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
    createExamPaperWithPrintCode,
    createExamPrintVersion,
    ensureExamPrintCode,
    generateExamPrintCode,
    generateUniqueExamPrintCode,
    isExamPrintCode,
} from '@/lib/exam/exam-print-identity';

const printablePaper = {
    title: '三年级数学练习',
    groupByType: true,
    questions: [{
        order: 0,
        status: 'ready',
        sourceShortId: 'Ab3xYz',
        questionText: '1 + 1 = ?',
        answerText: '2',
        analysis: '相加即可',
        figureSvg: null,
        figureScale: 100,
        figureAlign: 'center',
        answerSpacePx: 80,
        score: 5,
        questionType: 'fill_blank',
        externalNumber: '1',
    }],
};

describe('试卷打印身份', () => {
    it('生成 8 位且不含易混淆字符的 Base58 短码', () => {
        for (let index = 0; index < 200; index++) {
            const code = generateExamPrintCode();
            expect(code).toHaveLength(8);
            expect(isExamPrintCode(code)).toBe(true);
            expect(code).not.toMatch(/[0OIl]/);
        }
    });

    it('拒绝长度错误或包含易混淆字符的短码', () => {
        expect(isExamPrintCode('Ab3xYz91')).toBe(true);
        expect(isExamPrintCode('Ab3xYz9')).toBe(false);
        expect(isExamPrintCode('Ab3xYz910')).toBe(false);
        expect(isExamPrintCode('Ab3xYz0O')).toBe(false);
        expect(isExamPrintCode(null)).toBe(false);
    });

    it('数据库中短码已占用时重新生成', async () => {
        const findUnique = vi.fn()
            .mockResolvedValueOnce({ id: 'occupied' })
            .mockResolvedValueOnce(null);

        const code = await generateUniqueExamPrintCode({ examPaper: { findUnique } });

        expect(isExamPrintCode(code)).toBe(true);
        expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it('连续冲突后停止并报错', async () => {
        const findUnique = vi.fn().mockResolvedValue({ id: 'occupied' });

        await expect(generateUniqueExamPrintCode({ examPaper: { findUnique } })).rejects.toThrow(
            '无法生成唯一的试卷打印短码',
        );
        expect(findUnique).toHaveBeenCalledTimes(10);
    });

    it('已有短码时直接复用且不写数据库', async () => {
        const updateMany = vi.fn();
        const findUnique = vi.fn().mockResolvedValue({ id: 'paper-1', printCode: 'Ab3xYz91' });

        await expect(ensureExamPrintCode({ examPaper: { findUnique, updateMany } }, 'paper-1'))
            .resolves.toBe('Ab3xYz91');
        expect(updateMany).not.toHaveBeenCalled();
    });

    it('并发补码由其他请求先写入时返回数据库最终值', async () => {
        const findUnique = vi.fn()
            .mockResolvedValueOnce({ id: 'paper-1', printCode: null })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'paper-1', printCode: 'Cd4wXt82' });
        const updateMany = vi.fn().mockResolvedValue({ count: 0 });

        await expect(ensureExamPrintCode({ examPaper: { findUnique, updateMany } }, 'paper-1'))
            .resolves.toBe('Cd4wXt82');
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'paper-1', printCode: null },
        }));
    });

    it('惰性补码写入遇到 printCode 唯一冲突时换码重试', async () => {
        const findUnique = vi.fn()
            .mockResolvedValueOnce({ id: 'paper-1', printCode: null })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        const updateMany = vi.fn()
            .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['printCode'] } })
            .mockResolvedValueOnce({ count: 1 });

        await expect(ensureExamPrintCode({ examPaper: { findUnique, updateMany } }, 'paper-1'))
            .resolves.toMatch(/^[1-9A-HJ-NP-Za-km-z]{8}$/);
        expect(updateMany).toHaveBeenCalledTimes(2);
    });

    it('创建试卷写入遇到 printCode 唯一冲突时换码重试', async () => {
        const findUnique = vi.fn().mockResolvedValue(null);
        const create = vi.fn()
            .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['printCode'] } })
            .mockResolvedValueOnce({ id: 'paper-1' });

        await expect(createExamPaperWithPrintCode({ examPaper: { findUnique } }, create))
            .resolves.toEqual({ id: 'paper-1' });
        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls[0][0]).not.toBe(create.mock.calls[1][0]);
    });

    it('创建试卷遇到其他唯一约束冲突时不重试', async () => {
        const findUnique = vi.fn().mockResolvedValue(null);
        const error = { code: 'P2002', meta: { target: ['otherField'] } };
        const create = vi.fn().mockRejectedValue(error);

        await expect(createExamPaperWithPrintCode({ examPaper: { findUnique } }, create))
            .rejects.toBe(error);
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('相同可打印内容产生稳定的 12 位版次', () => {
        const first = createExamPrintVersion(printablePaper);
        const second = createExamPrintVersion({
            ...printablePaper,
            questions: printablePaper.questions.map((question) => ({ ...question })),
        });

        expect(first).toMatch(/^[a-f0-9]{12}$/);
        expect(second).toBe(first);
    });

    it('题干、分值或顺序变化会改变版次', () => {
        const original = createExamPrintVersion(printablePaper);

        expect(createExamPrintVersion({
            ...printablePaper,
            questions: [{ ...printablePaper.questions[0], questionText: '1 + 2 = ?' }],
        })).not.toBe(original);
        expect(createExamPrintVersion({
            ...printablePaper,
            questions: [{ ...printablePaper.questions[0], score: 10 }],
        })).not.toBe(original);
        expect(createExamPrintVersion({
            ...printablePaper,
            questions: [{ ...printablePaper.questions[0], order: 1 }],
        })).not.toBe(original);
    });

    it('旧卷使用关联错题的回退题型时，题型变化会改变版次', () => {
        const original = createExamPrintVersion({
            ...printablePaper,
            questions: [{
                ...printablePaper.questions[0],
                questionType: null,
                errorItemQuestionType: 'single_choice',
            }],
        });

        expect(createExamPrintVersion({
            ...printablePaper,
            questions: [{
                ...printablePaper.questions[0],
                questionType: null,
                errorItemQuestionType: 'fill_blank',
            }],
        })).not.toBe(original);
    });

    it('不受对象键顺序影响且区分 null 与空字符串', () => {
        const reordered = {
            questions: printablePaper.questions,
            groupByType: printablePaper.groupByType,
            title: printablePaper.title,
        };

        expect(createExamPrintVersion(reordered)).toBe(createExamPrintVersion(printablePaper));
        expect(createExamPrintVersion({
            ...printablePaper,
            questions: [{ ...printablePaper.questions[0], analysis: '' }],
        })).not.toBe(createExamPrintVersion({
            ...printablePaper,
            questions: [{ ...printablePaper.questions[0], analysis: null }],
        }));
    });
});
