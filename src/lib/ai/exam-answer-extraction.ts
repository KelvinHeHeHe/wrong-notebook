import { z } from 'zod';

/** 试卷页面及用于定位答案的候选题；题干只作为辨认参考。 */
export interface ExamPageAnswerExtractionInput {
    imageBase64: string;
    mimeType: string;
    questions: Array<{ id: string; displayNumber: number; sourceShortId: string; questionText: string }>;
    language: 'zh' | 'en';
}

export interface ExamPageAnswerCandidate {
    sourceShortId: string | null;
    displayNumber: number | null;
    recognizedAnswer: string | null;
    notAttempted: boolean;
    confidence: number;
    /** 相对于整页图片的 0～1 坐标。 */
    regions: Array<{ x: number; y: number; width: number; height: number }>;
}

export interface ExamPageAnswerExtractionResult {
    candidates: ExamPageAnswerCandidate[];
}

const rawRegion = z.object({
    x: z.number(), y: z.number(), width: z.number(), height: z.number(),
}).strict();
const rawCandidate = z.object({
    sourceShortId: z.string().nullable(),
    displayNumber: z.number().int().positive().nullable(),
    recognizedAnswer: z.string().nullable(),
    notAttempted: z.boolean(),
    confidence: z.number(),
    regions: z.array(rawRegion),
}).strict();
const rawResult = z.object({ candidates: z.array(rawCandidate) }).strict();

function clamp(value: number): number {
    return Math.max(0, Math.min(1, value));
}

/** 严格校验模型输出，只保留受限大小的数据；异常不包含模型原文。 */
export function parseExamPageAnswerExtraction(text: string): ExamPageAnswerExtractionResult {
    // 只去掉 JSON 之前的推理块，不能改写 recognizedAnswer 内的学生原文。
    let body = text.trim().replace(/^<(think|thinking)\b[^>]*>[\s\S]*?<\/\1>\s*/i, '');
    const block = body.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    if (block) body = block[1].trim();
    try {
        const result = rawResult.parse(JSON.parse(body));
        return {
            candidates: result.candidates.slice(0, 100).map((candidate) => ({
                ...candidate,
                recognizedAnswer: candidate.recognizedAnswer?.slice(0, 20_000) ?? null,
                confidence: clamp(candidate.confidence),
                regions: candidate.regions.slice(0, 4).map((region) => {
                    const x = clamp(region.x);
                    const y = clamp(region.y);
                    return { x, y, width: Math.min(clamp(region.width), 1 - x), height: Math.min(clamp(region.height), 1 - y) };
                }),
            })),
        };
    } catch {
        throw new Error('AI_RESPONSE_ERROR: invalid exam answer extraction output');
    }
}
