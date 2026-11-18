import { beforeEach, describe, expect, it, vi } from 'vitest';

import { patchExamAndRefresh } from '@/lib/exam/exam-print-updates';
import { apiClient } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
    apiClient: {
        get: vi.fn(),
        patch: vi.fn(),
    },
}));

describe('打印页保存后刷新内容版次', () => {
    beforeEach(() => vi.clearAllMocks());

    it('顺序保存全部变更后重新读取试卷详情', async () => {
        vi.mocked(apiClient.patch).mockResolvedValue({});
        vi.mocked(apiClient.get).mockResolvedValue({ printVersion: 'fedcba654321' });

        const result = await patchExamAndRefresh('paper-1', [
            { questionId: 'q1', answerSpacePx: 120 },
            { questionId: 'q2', answerSpacePx: 240 },
        ]);

        const patch = vi.mocked(apiClient.patch);
        const get = vi.mocked(apiClient.get);
        expect(patch.mock.invocationCallOrder[0])
            .toBeLessThan(patch.mock.invocationCallOrder[1]);
        expect(get.mock.invocationCallOrder[0])
            .toBeGreaterThan(patch.mock.invocationCallOrder[1]);
        expect(apiClient.get).toHaveBeenCalledWith('/api/exams/paper-1');
        expect(result).toMatchObject({ printVersion: 'fedcba654321' });
    });
});
