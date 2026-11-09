import { describe, expect, it } from 'vitest';
import {
    EXAM_ANSWER_REVIEW_CONFIDENCE,
    buildAttemptPageRecognition,
    matchExamAnswerCandidates,
    resolveExamAnswerCandidateTargets,
    parseAttemptPageRecognition,
    parseAttemptRegionJson,
    readAttemptRegionPageOrder,
    requiresExamAnswerReview,
    serializeAttemptPageRecognition,
    suggestExamAnswerScore,
    summarizeExamAttemptScores,
} from '@/lib/exam/exam-attempt';
import type { ExamPageAnswerCandidate } from '@/lib/ai/exam-answer-extraction';

const candidate = (overrides: Partial<ExamPageAnswerCandidate> = {}) => ({
    candidateId: 'candidate-1',
    sourceShortId: 'q-a',
    displayNumber: 1,
    recognizedAnswer: '答案 A',
    notAttempted: false,
    confidence: 0.9,
    regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
    ...overrides,
});

const questions = [
    { id: 'question-a', shortId: 'q-a', displayNumber: 1 },
    { id: 'question-b', shortId: 'q-b', displayNumber: 2 },
];

describe('buildAttemptPageRecognition', () => {
    it('按页序与规范化内容稳定生成候选 ID，并为完全重复内容追加序号', () => {
        const extraction = { candidates: [candidate(), candidate({ recognizedAnswer: ' 答案 A\n' }), candidate()] };
        const first = buildAttemptPageRecognition(2, extraction, '2026-11-09T00:00:00.000Z');
        const second = buildAttemptPageRecognition(2, extraction, '2026-11-09T00:00:00.000Z');
        expect(first).toEqual(second);
        expect(first.candidates.map(({ candidateId }) => candidateId)).toHaveLength(3);
        expect(new Set(first.candidates.map(({ candidateId }) => candidateId)).size).toBe(3);
        expect(first.version).toBe(1);
        expect(first.status).toBe('succeeded');
    });

    it('候选 ID 不受 32 位摘要碰撞、输入反序或加入无关候选影响', () => {
        const firstCandidate = candidate({ recognizedAnswer: '1bk1jno-34416' });
        const secondCandidate = candidate({ recognizedAnswer: '1n4idxz-76801' });
        const build = (rows: typeof firstCandidate[]) => buildAttemptPageRecognition(1, { candidates: rows }, 'now');
        const firstId = build([firstCandidate]).candidates[0].candidateId;
        const secondId = build([secondCandidate]).candidates[0].candidateId;
        expect(firstId).not.toBe(secondId);
        expect(build([firstCandidate, secondCandidate]).candidates.map(({ candidateId }) => candidateId)).toEqual([firstId, secondId]);
        expect(build([secondCandidate, firstCandidate]).candidates.map(({ candidateId }) => candidateId)).toEqual([secondId, firstId]);
        expect(build([firstCandidate, candidate({ recognizedAnswer: '无关答案' })]).candidates[0].candidateId).toBe(firstId);
    });

    it('把提取失败写入带错误码的 v1 信封', () => {
        expect(buildAttemptPageRecognition(1, null, '2026-11-09T00:00:00.000Z', 'AI_FAILED')).toMatchObject({
            version: 1, status: 'failed', candidates: [], errorCode: 'AI_FAILED',
        });
    });
});

describe('matchExamAnswerCandidates', () => {
    it('重复候选可确定同一目标题，但不能作为唯一自动判分匹配', () => {
        const rows = [candidate(), { ...candidate({ recognizedAnswer: '答案 B' }), candidateId: 'candidate-2' }];
        expect(resolveExamAnswerCandidateTargets(rows, questions)).toEqual([
            { candidateId: 'candidate-1', questionId: 'question-a' }, { candidateId: 'candidate-2', questionId: 'question-a' },
        ]);
        expect(matchExamAnswerCandidates(rows, questions).matches).toEqual([]);
    });

    it('无目标、未知短码、跨标识冲突及非唯一题号不能声明确定目标', () => {
        expect(resolveExamAnswerCandidateTargets([
            candidate({ sourceShortId: null, displayNumber: null }), candidate({ sourceShortId: 'missing' }), candidate({ displayNumber: 2 }),
        ], questions)).toEqual([]);
        expect(resolveExamAnswerCandidateTargets([candidate({ sourceShortId: null, displayNumber: 1 })], [...questions, { id: 'ambiguous', shortId: null, displayNumber: 1 }])).toEqual([]);
    });
    it('短 ID 完全匹配优先', () => {
        const result = matchExamAnswerCandidates([candidate()], questions);
        expect(result.matches).toEqual([{ candidateId: expect.any(String), questionId: 'question-a' }]);
    });

    it('仅短 ID 缺失时允许唯一连续题号回退', () => {
        const result = matchExamAnswerCandidates([candidate({ sourceShortId: null, displayNumber: 2 })], questions);
        expect(result.matches).toEqual([{ candidateId: expect.any(String), questionId: 'question-b' }]);
    });

    it.each([
        ['短 ID 与题号指向不同题', candidate({ displayNumber: 2 })],
        ['同一题有多个候选', candidate(), candidate({ recognizedAnswer: '第二份答案' })],
        ['未知短 ID', candidate({ sourceShortId: 'missing', displayNumber: 1 })],
    ])('%s 时不猜测匹配', (_caseName, ...rows) => {
        const result = matchExamAnswerCandidates(rows as ReturnType<typeof candidate>[], questions);
        expect(result.matches).toEqual([]);
        expect(result.unmatchedCandidateIds.length + result.conflictingCandidateIds.length).toBeGreaterThan(0);
    });

    it('缺少的题目 ID 会返回在 missingQuestionIds 中', () => {
        expect(matchExamAnswerCandidates([], questions).missingQuestionIds).toEqual(['question-a', 'question-b']);
    });
});

describe('requiresExamAnswerReview', () => {
    it('低置信度、解答题与缺少判分依据时要求复核', () => {
        expect(requiresExamAnswerReview({ confidence: EXAM_ANSWER_REVIEW_CONFIDENCE - 0.01, questionType: 'choice', answerKey: 'A', maxScore: 2, result: 'correct', gradingFailed: false, notAttempted: false })).toBe(true);
        for (const questionType of ['solution', 'reading', 'writing', 'other']) {
            expect(requiresExamAnswerReview({ confidence: 1, questionType, answerKey: '答案', maxScore: 2, result: 'correct', gradingFailed: false, notAttempted: false })).toBe(true);
        }
        expect(requiresExamAnswerReview({ confidence: 1, questionType: 'choice', answerKey: null, maxScore: 2, result: 'correct', gradingFailed: false, notAttempted: false })).toBe(true);
        expect(requiresExamAnswerReview({ confidence: 1, questionType: 'choice', answerKey: 'A', maxScore: null, result: 'correct', gradingFailed: false, notAttempted: false })).toBe(true);
        expect(requiresExamAnswerReview({ confidence: 1, questionType: 'choice', answerKey: 'A', maxScore: 2, result: null, gradingFailed: true, notAttempted: false })).toBe(true);
        expect(requiresExamAnswerReview({ confidence: 1, questionType: 'choice', answerKey: 'A', maxScore: 2, result: 'not_attempted', gradingFailed: false, notAttempted: true })).toBe(true);
    });
});

describe('suggestExamAnswerScore 与 summarizeExamAttemptScores', () => {
    it('正确得满分，错误与未作答得 0 分', () => {
        expect(suggestExamAnswerScore('correct', 2.5)).toBe(2.5);
        expect(suggestExamAnswerScore('wrong', 2.5)).toBe(0);
        expect(suggestExamAnswerScore('not_attempted', 2.5)).toBe(0);
    });

    it('汇总分数并保留一位小数', () => {
        expect(summarizeExamAttemptScores([{ awardedScore: 1.25 }, { awardedScore: 2.26 }, { awardedScore: null }])).toEqual({ totalScore: 3.5, maxScore: null });
    });
});

describe('recognition 和区域 JSON 解析', () => {
    it('只读页序兼容旧退化区域，不放宽实际坐标的严格解析', () => {
        const raw = JSON.stringify({ pageOrder: 1, candidateId: 'old', regions: [{ x: 1, y: 0, width: 0, height: 0.5 }] });
        expect(readAttemptRegionPageOrder(raw)).toBe(1);
        expect(parseAttemptRegionJson(raw)).toBeNull();
        expect(readAttemptRegionPageOrder('{"pageOrder":2}')).toBe(2);
        expect(readAttemptRegionPageOrder('{"pageOrder":20,"candidateId":"old","regions":[{"width":0}]}')).toBe(20);
    });

    it('只读页序拒绝坏 JSON、非对象、非整数和非正数，不猜测归属', () => {
        for (const raw of [undefined, null, '', '{bad', 'null', '[]', '{}', '{"pageOrder":null}', '{"pageOrder":"1"}', '{"pageOrder":1.5}', '{"pageOrder":0}', '{"pageOrder":-1}', '{"pageOrder":21}']) {
            expect(readAttemptRegionPageOrder(raw)).toBeNull();
        }
    });
    it('安全解析和序列化 v1 信封，拒绝未知版本', () => {
        const value = buildAttemptPageRecognition(1, { candidates: [candidate()] }, '2026-11-09T00:00:00.000Z');
        expect(parseAttemptPageRecognition(serializeAttemptPageRecognition(value))).toEqual(value);
        expect(parseAttemptPageRecognition('{"version":2}')).toBeNull();
        expect(parseAttemptPageRecognition('{bad')).toBeNull();
    });

    it('解析持久化区域对象，保留页序和可空候选 ID 并限制四个有效区域', () => {
        const regions = [0, 0.1, 0.2, 0.3, 0.4].map((x) => ({ x, y: 0.2, width: 0.1, height: 0.2 }));
        expect(parseAttemptRegionJson(JSON.stringify({ pageOrder: 2, candidateId: null, regions: regions.slice(0, 4) }))).toEqual({
            pageOrder: 2,
            candidateId: null,
            regions: regions.slice(0, 4),
        });
        expect(parseAttemptRegionJson(JSON.stringify({ pageOrder: 1, candidateId: 'candidate-1', regions: regions.slice(0, 1) }))).toEqual({
            pageOrder: 1, candidateId: 'candidate-1', regions: regions.slice(0, 1),
        });
        expect(parseAttemptRegionJson(JSON.stringify({ pageOrder: 2, candidateId: null, regions }))).toBeNull();
    });

    it('坏 JSON、坏页序、坏候选 ID 和非法区域安全返回 null', () => {
        expect(parseAttemptRegionJson('{bad')).toBeNull();
        expect(parseAttemptRegionJson(JSON.stringify({ pageOrder: 0, candidateId: null, regions: [] }))).toBeNull();
        expect(parseAttemptRegionJson(JSON.stringify({ pageOrder: 1, candidateId: '', regions: [] }))).toBeNull();
        expect(parseAttemptRegionJson(JSON.stringify({ pageOrder: 1, candidateId: null, regions: [{ x: 0, y: 0, width: 2, height: 1 }] }))).toBeNull();
    });
});
