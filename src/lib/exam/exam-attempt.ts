import type { ExamPageAnswerCandidate, ExamPageAnswerExtractionResult } from '@/lib/ai/exam-answer-extraction';

export const EXAM_ANSWER_REVIEW_CONFIDENCE = 0.80;

export interface ExamAttemptAnswerCandidate extends ExamPageAnswerCandidate {
    candidateId: string;
}

export interface ExamAttemptPageRecognition {
    version: 1;
    status: 'succeeded' | 'failed';
    candidates: ExamAttemptAnswerCandidate[];
    errorCode: string | null;
    completedAt: string;
}

export interface ExamAttemptMatchQuestion {
    id: string;
    sourceShortId?: string | null;
    shortId?: string | null;
    displayNumber: number;
}

export interface ExamAttemptCandidateMatch {
    candidateId: string;
    questionId: string;
}

export interface ExamAttemptCandidateMatchResult {
    matches: ExamAttemptCandidateMatch[];
    unmatchedCandidateIds: string[];
    conflictingCandidateIds: string[];
    missingQuestionIds: string[];
}

export interface ExamAnswerReviewInput {
    confidence: number | null;
    questionType: string | null;
    answerKey: string | null;
    maxScore: number | null;
    result: 'correct' | 'wrong' | 'not_attempted' | null;
    gradingFailed: boolean;
    notAttempted: boolean;
}

export interface ExamAttemptScoreAnswer {
    awardedScore: number | null;
    maxScore?: number | null;
}

export interface ExamAttemptScoreSummary {
    totalScore: number | null;
    maxScore: number | null;
}

export interface ExamAttemptRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ExamAttemptRegionJson {
    pageOrder: number;
    candidateId: string | null;
    regions: ExamAttemptRegion[];
}

function normalizeAnswer(value: string | null): string | null {
    return value === null ? null : value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function utf8Bytes(value: string): number[] {
    const bytes: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
        let codePoint = value.charCodeAt(index);
        if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < value.length) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                codePoint = ((codePoint - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
                index += 1;
            }
        }
        if (codePoint < 0x80) bytes.push(codePoint);
        else if (codePoint < 0x800) bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
        else if (codePoint < 0x10000) bytes.push(0xe0 | (codePoint >>> 12), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
        else bytes.push(0xf0 | (codePoint >>> 18), 0x80 | ((codePoint >>> 12) & 0x3f), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    }
    return bytes;
}

function rotateRight(value: number, amount: number): number {
    return (value >>> amount) | (value << (32 - amount));
}

/** SHA-256 的纯 TypeScript 实现，不依赖运行时加密或浏览器 API。 */
function hashContent(value: string): string {
    const constants = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const bytes = utf8Bytes(value);
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const highLength = Math.floor(bitLength / 0x100000000);
    const lowLength = bitLength >>> 0;
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((highLength >>> shift) & 0xff);
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((lowLength >>> shift) & 0xff);

    for (let offset = 0; offset < bytes.length; offset += 64) {
        const words = new Array<number>(64);
        for (let index = 0; index < 16; index += 1) {
            const start = offset + index * 4;
            words[index] = ((bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3]) >>> 0;
        }
        for (let index = 16; index < 64; index += 1) {
            const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
            const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = state;
        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (sum0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        state[0] = (state[0] + a) >>> 0;
        state[1] = (state[1] + b) >>> 0;
        state[2] = (state[2] + c) >>> 0;
        state[3] = (state[3] + d) >>> 0;
        state[4] = (state[4] + e) >>> 0;
        state[5] = (state[5] + f) >>> 0;
        state[6] = (state[6] + g) >>> 0;
        state[7] = (state[7] + h) >>> 0;
    }
    return state.map((part) => part.toString(16).padStart(8, '0')).join('');
}

function normalizeCandidate(candidate: ExamPageAnswerCandidate): ExamPageAnswerCandidate {
    return {
        sourceShortId: candidate.sourceShortId?.trim() || null,
        displayNumber: candidate.displayNumber,
        recognizedAnswer: normalizeAnswer(candidate.recognizedAnswer),
        notAttempted: candidate.notAttempted,
        confidence: candidate.confidence,
        regions: candidate.regions.map(({ x, y, width, height }) => ({ x, y, width, height })),
    };
}

/** 创建页级识别信封；候选 ID 由页序和规范化内容确定性生成。 */
export function buildAttemptPageRecognition(
    pageOrder: number,
    extraction: ExamPageAnswerExtractionResult | null,
    completedAt: string,
    errorCode: string | null = null,
): ExamAttemptPageRecognition {
    if (!extraction) {
        return { version: 1, status: 'failed', candidates: [], errorCode: errorCode || 'RECOGNITION_FAILED', completedAt };
    }
    const duplicates = new Map<string, number>();
    const candidates = extraction.candidates.map((candidate) => {
        const normalized = normalizeCandidate(candidate);
        const content = JSON.stringify(normalized);
        const contentKey = content;
        const duplicateIndex = (duplicates.get(contentKey) ?? 0) + 1;
        duplicates.set(contentKey, duplicateIndex);
        return { ...candidate, candidateId: `p${pageOrder}-${hashContent(content)}-${duplicateIndex}` };
    });
    return { version: 1, status: 'succeeded', candidates, errorCode: null, completedAt };
}

function isCandidate(value: unknown): value is ExamAttemptAnswerCandidate {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<ExamAttemptAnswerCandidate>;
    return typeof candidate.candidateId === 'string'
        && (typeof candidate.sourceShortId === 'string' || candidate.sourceShortId === null)
        && (typeof candidate.displayNumber === 'number' || candidate.displayNumber === null)
        && (typeof candidate.recognizedAnswer === 'string' || candidate.recognizedAnswer === null)
        && typeof candidate.notAttempted === 'boolean'
        && typeof candidate.confidence === 'number'
        && Array.isArray(candidate.regions)
        && candidate.regions.every((region) => typeof region === 'object' && region !== null
            && ['x', 'y', 'width', 'height'].every((key) => typeof (region as Record<string, unknown>)[key] === 'number'));
}

/** 解析只接受 v1 的识别信封；异常或未知版本返回 null。 */
export function parseAttemptPageRecognition(raw: string): ExamAttemptPageRecognition | null {
    try {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== 'object' || value === null) return null;
        const envelope = value as Partial<ExamAttemptPageRecognition>;
        if (envelope.version !== 1 || (envelope.status !== 'succeeded' && envelope.status !== 'failed')
            || !Array.isArray(envelope.candidates) || !envelope.candidates.every(isCandidate)
            || !(typeof envelope.errorCode === 'string' || envelope.errorCode === null)
            || typeof envelope.completedAt !== 'string') return null;
        return envelope as ExamAttemptPageRecognition;
    } catch {
        return null;
    }
}

export function serializeAttemptPageRecognition(value: ExamAttemptPageRecognition): string {
    return JSON.stringify(value);
}

/** 只按短 ID 完全匹配；短 ID 缺失时才使用唯一连续题号回退。 */
export function matchExamAnswerCandidates(
    candidates: ExamAttemptAnswerCandidate[],
    questions: ExamAttemptMatchQuestion[],
): ExamAttemptCandidateMatchResult {
    const byShortId = new Map<string, ExamAttemptMatchQuestion[]>();
    const byNumber = new Map<number, ExamAttemptMatchQuestion[]>();
    for (const question of questions) {
        const shortId = question.sourceShortId ?? question.shortId;
        if (shortId) byShortId.set(shortId, [...(byShortId.get(shortId) ?? []), question]);
        byNumber.set(question.displayNumber, [...(byNumber.get(question.displayNumber) ?? []), question]);
    }

    const targets = new Map<string, ExamAttemptMatchQuestion>();
    const unmatched = new Set<string>();
    const conflicting = new Set<string>();
    const candidateIdCounts = new Map<string, number>();
    for (const candidate of candidates) candidateIdCounts.set(candidate.candidateId, (candidateIdCounts.get(candidate.candidateId) ?? 0) + 1);

    for (const candidate of candidates) {
        const { candidateId } = candidate;
        if ((candidateIdCounts.get(candidateId) ?? 0) > 1) {
            conflicting.add(candidateId);
            continue;
        }
        let target: ExamAttemptMatchQuestion | undefined;
        if (candidate.sourceShortId !== null) {
            const exact = byShortId.get(candidate.sourceShortId) ?? [];
            if (exact.length > 1) {
                conflicting.add(candidateId);
                continue;
            }
            if (exact.length === 0) {
                unmatched.add(candidateId);
                continue;
            }
            target = exact[0];
            const numberMatches = byNumber.get(candidate.displayNumber ?? -1) ?? [];
            if (candidate.displayNumber !== null && numberMatches.length === 1 && numberMatches[0].id !== target.id) {
                conflicting.add(candidateId);
                continue;
            }
        } else if (candidate.displayNumber !== null) {
            const numberMatches = byNumber.get(candidate.displayNumber) ?? [];
            if (numberMatches.length > 1) {
                conflicting.add(candidateId);
                continue;
            }
            if (numberMatches.length === 1) target = numberMatches[0];
        }
        if (!target) {
            unmatched.add(candidateId);
            continue;
        }
        targets.set(candidateId, target);
    }

    const byTarget = new Map<string, string[]>();
    for (const [candidateId, target] of targets) byTarget.set(target.id, [...(byTarget.get(target.id) ?? []), candidateId]);
    const matches: ExamAttemptCandidateMatch[] = [];
    for (const [candidateId, target] of targets) {
        const competitors = byTarget.get(target.id) ?? [];
        if (competitors.length > 1) conflicting.add(candidateId);
        else matches.push({ candidateId, questionId: target.id });
    }
    const matchedQuestionIds = new Set(matches.map((match) => match.questionId));
    return {
        matches,
        unmatchedCandidateIds: [...unmatched],
        conflictingCandidateIds: [...conflicting],
        missingQuestionIds: questions.filter(({ id }) => !matchedQuestionIds.has(id)).map(({ id }) => id),
    };
}

/** 逐候选解析确定目标，允许多份候选指向同题；自动判分仍须使用整页唯一匹配。 */
export function resolveExamAnswerCandidateTargets(
    candidates: ExamAttemptAnswerCandidate[], questions: ExamAttemptMatchQuestion[],
): ExamAttemptCandidateMatch[] {
    return candidates.flatMap((candidate) => matchExamAnswerCandidates([candidate], questions).matches);
}

export function requiresExamAnswerReview(input: ExamAnswerReviewInput): boolean {
    return input.confidence === null || input.confidence < EXAM_ANSWER_REVIEW_CONFIDENCE
        || ['solution', 'reading', 'writing', 'other'].includes(input.questionType ?? '')
        || !input.answerKey?.trim() || input.maxScore === null || input.maxScore <= 0
        || input.gradingFailed || input.notAttempted || input.result === null || input.result === 'not_attempted';
}

export function suggestExamAnswerScore(result: 'correct' | 'wrong' | 'not_attempted' | null, maxScore: number): number | null {
    if (!Number.isFinite(maxScore) || maxScore <= 0 || result === null) return null;
    return result === 'correct' ? maxScore : 0;
}

export function summarizeExamAttemptScores(answers: ExamAttemptScoreAnswer[]): ExamAttemptScoreSummary {
    let total = 0;
    let max = 0;
    let hasScore = false;
    let hasMax = false;
    for (const answer of answers) {
        if (typeof answer.awardedScore === 'number' && Number.isFinite(answer.awardedScore)) {
            total += answer.awardedScore;
            hasScore = true;
        }
        if (typeof answer.maxScore === 'number' && Number.isFinite(answer.maxScore)) {
            max += answer.maxScore;
            hasMax = true;
        }
    }
    return {
        totalScore: hasScore ? Math.round(total * 10) / 10 : null,
        maxScore: hasMax ? Math.round(max * 10) / 10 : null,
    };
}

/** 校验持久化的页序、候选引用和区域列表；任何非法数据均安全返回 null。 */
export function parseAttemptRegionJson(raw: string | null | undefined): ExamAttemptRegionJson | null {
    if (!raw) return null;
    try {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
        const persisted = value as { pageOrder?: unknown; candidateId?: unknown; regions?: unknown };
        if (typeof persisted.pageOrder !== 'number' || !Number.isInteger(persisted.pageOrder) || persisted.pageOrder < 1
            || !(persisted.candidateId === null || (typeof persisted.candidateId === 'string' && persisted.candidateId.trim().length > 0 && persisted.candidateId.length <= 200))
            || !Array.isArray(persisted.regions) || persisted.regions.length > 4) return null;
        const regions: ExamAttemptRegion[] = [];
        for (const item of persisted.regions) {
            if (typeof item !== 'object' || item === null) return null;
            const region = item as Partial<ExamAttemptRegion>;
            if (!['x', 'y', 'width', 'height'].every((key) => {
                const coordinate = region[key as keyof ExamAttemptRegion];
                return typeof coordinate === 'number' && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1;
            }) || (region.width ?? 0) <= 0 || (region.height ?? 0) <= 0
                || (region.x ?? 0) + (region.width ?? 0) > 1 || (region.y ?? 0) + (region.height ?? 0) > 1) return null;
            regions.push({ x: region.x!, y: region.y!, width: region.width!, height: region.height! });
        }
        return { pageOrder: persisted.pageOrder, candidateId: persisted.candidateId as string | null, regions };
    } catch {
        return null;
    }
}
