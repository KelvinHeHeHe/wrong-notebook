import { HANDWRITING_QUALITIES, PHOTO_QUALITIES, QUESTION_TYPE_KEYS, SUBJECTS } from './strata.mjs';

const DIMENSIONS = {
    grade: ['1', '2', '3', '4', '5', '6', 'unlabeled'],
    subject: [...SUBJECTS, 'unlabeled'],
    questionType: [...QUESTION_TYPE_KEYS, 'unlabeled'],
    handwriting: [...HANDWRITING_QUALITIES, 'unlabeled'],
    photoQuality: [...PHOTO_QUALITIES, 'unlabeled'],
};

function metric(rows) {
    const expectedCount = rows.length;
    const matchedCount = rows.filter((row) => row.matched).length;
    const exactAnswerCount = rows.filter((row) => row.exact).length;
    return {
        expectedCount,
        matchedCount,
        exactAnswerCount,
        matchingAccuracy: expectedCount === 0 ? 0 : matchedCount / expectedCount,
        matchedExactAnswerAccuracy: expectedCount === 0 ? 0 : exactAnswerCount / expectedCount,
    };
}

function breakdown(results, dimension) {
    const values = DIMENSIONS[dimension];
    const groups = new Map(values.map((value) => [value, []]));
    for (const result of results) {
        const value = values.includes(result[dimension]) ? result[dimension] : 'unlabeled';
        groups.get(value).push(result);
    }
    return values.map((value) => ({ value, ...metric(groups.get(value)) }));
}

export function buildEvaluationReport({ provider, model, results }) {
    const totals = metric(results);
    return {
        version: 3,
        pairing: { method: 'mutual-best-region-iou', minIoU: 0.5 },
        provider,
        model,
        ...totals,
        recommendedTarget: 0.95,
        meetsRecommendedTarget: totals.matchedExactAnswerAccuracy >= 0.95,
        minimumEvaluationSize: 60,
        sufficientSampleSize: totals.expectedCount >= 60,
        breakdowns: Object.fromEntries(Object.keys(DIMENSIONS).map((dimension) => [dimension, breakdown(results, dimension)])),
        results,
    };
}
