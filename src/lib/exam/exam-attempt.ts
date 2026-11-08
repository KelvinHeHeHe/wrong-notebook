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
    candidateId: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
}

function normalizeAnswer(value: string | null): string | null {
    return value === null ? null : value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function hashContent(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
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
        const contentKey = `${pageOrder}-${hashContent(content)}`;
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

/** 非法区域会被丢弃；坏 JSON 返回空列表。 */
export function parseAttemptRegionJson(raw: string | null | undefined): ExamAttemptRegion[] {
    if (!raw) return [];
    try {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) return [];
        return value.filter((item): item is ExamAttemptRegion => {
            if (typeof item !== 'object' || item === null) return false;
            const region = item as Partial<ExamAttemptRegion>;
            return (typeof region.candidateId === 'string' || region.candidateId === null)
                && ['x', 'y', 'width', 'height'].every((key) => {
                    const coordinate = region[key as keyof ExamAttemptRegion];
                    return typeof coordinate === 'number' && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1;
                })
                && (region.width ?? 0) > 0 && (region.height ?? 0) > 0
                && (region.x ?? 0) + (region.width ?? 0) <= 1 && (region.y ?? 0) + (region.height ?? 0) <= 1;
        });
    } catch {
        return [];
    }
}
