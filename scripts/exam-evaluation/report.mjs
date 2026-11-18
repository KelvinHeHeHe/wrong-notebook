const DIMENSIONS = ['grade', 'subject', 'questionType', 'handwriting', 'photoQuality'];

function metric(rows) {
    const expectedCount = rows.length;
    const matchedCount = rows.filter((row) => row.matched).length;
    const exactAnswerCount = rows.filter((row) => row.exact).length;
    return {
        expectedCount,
        matchedCount,
        exactAnswerCount,
        matchingAccuracy: matchedCount / expectedCount,
        matchedExactAnswerAccuracy: exactAnswerCount / expectedCount,
    };
}

function breakdown(results, dimension) {
    const groups = new Map();
    for (const result of results) {
        const value = result[dimension] ?? 'unlabeled';
        const rows = groups.get(value) ?? [];
        rows.push(result);
        groups.set(value, rows);
    }
    return [...groups].map(([value, rows]) => ({ value, ...metric(rows) }));
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
        breakdowns: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, breakdown(results, dimension)])),
        results,
    };
}
