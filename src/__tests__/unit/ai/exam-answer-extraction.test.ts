import { describe, expect, it } from 'vitest';
import { parseExamPageAnswerExtraction } from '@/lib/ai/exam-answer-extraction';

const candidate = {
    sourceShortId: 'ABC123', displayNumber: 2, recognizedAnswer: 'x = 3',
    notAttempted: false, confidence: 0.8,
    regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
};

describe('试卷页面答案提取解析', () => {
    it('接受 fenced JSON 并保留可见答案和空白题标记', () => {
        const blank = { ...candidate, sourceShortId: null, displayNumber: null, recognizedAnswer: null, notAttempted: true, regions: [] };
        expect(parseExamPageAnswerExtraction('```json\n' + JSON.stringify({ candidates: [candidate, blank] }) + '\n```'))
            .toEqual({ candidates: [candidate, blank] });
        expect(parseExamPageAnswerExtraction('{"candidates":[]}')).toEqual({ candidates: [] });
    });

    it('只移除回复开头的推理块，学生答案中的同名标签保持原样', () => {
        const answer = { ...candidate, recognizedAnswer: '<think>这是学生写下的原文</think>' };
        expect(parseExamPageAnswerExtraction('<think>模型推理</think>\n' + JSON.stringify({ candidates: [answer] })))
            .toEqual({ candidates: [answer] });
    });

    it('裁剪坐标和置信度，区域不会伸出图片', () => {
        const result = parseExamPageAnswerExtraction(JSON.stringify({ candidates: [
            { ...candidate, confidence: 2, regions: [{ x: -0.2, y: 0.8, width: 1.5, height: 0.5 }] },
            { ...candidate, confidence: -1, regions: [{ x: 2, y: -1, width: 2, height: 2 }] },
        ] }));
        expect(result.candidates[0].confidence).toBe(1);
        expect(result.candidates[0].regions[0]).toEqual({ x: 0, y: 0.8, width: 1, height: expect.closeTo(0.2) });
        expect(result.candidates[1].confidence).toBe(0);
        for (const region of result.candidates.flatMap((item) => item.regions)) {
            expect(region.x).toBeGreaterThanOrEqual(0);
            expect(region.y).toBeGreaterThanOrEqual(0);
            expect(region.width).toBeGreaterThanOrEqual(0);
            expect(region.height).toBeGreaterThanOrEqual(0);
            expect(region.x + region.width).toBeLessThanOrEqual(1);
            expect(region.y + region.height).toBeLessThanOrEqual(1);
        }
    });

    it('答案最多 20000 字、候选最多 100 条、每题最多 4 个区域', () => {
        const oversized = { ...candidate, recognizedAnswer: '答'.repeat(20001), regions: Array.from({ length: 5 }, () => candidate.regions[0]) };
        const result = parseExamPageAnswerExtraction(JSON.stringify({ candidates: Array.from({ length: 101 }, () => oversized) }));
        expect(result.candidates).toHaveLength(100);
        expect(result.candidates[0].recognizedAnswer).toBe('答'.repeat(20000));
        expect(result.candidates[0].regions).toHaveLength(4);
    });

    it.each(['', '不是 JSON', 'null', '[]', '[{"candidates":[]}]', '{}', '{"candidates":{}}', '{"candidates":null}'])
        ('拒绝没有对象或候选数组的回复：%s', (text) => {
            expect(() => parseExamPageAnswerExtraction(text)).toThrow('AI_RESPONSE_ERROR');
        });

    it.each([
        { ...candidate, confidence: '0.8' },
        { ...candidate, notAttempted: 'false' },
        { ...candidate, displayNumber: 1.5 },
        { ...candidate, recognizedAnswer: 123 },
        { ...candidate, regions: [{ x: '0.1', y: 0.2, width: 0.3, height: 0.4 }] },
    ])('拒绝字段类型错误，避免将模型数据强制转换：%j', (invalid) => {
        expect(() => parseExamPageAnswerExtraction(JSON.stringify({ candidates: [invalid] }))).toThrow('AI_RESPONSE_ERROR');
    });
});
