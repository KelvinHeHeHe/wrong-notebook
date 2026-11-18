import { apiClient } from "@/lib/api-client";
import type { ExamPaperDetail } from "@/types/api";

export type ExamPrintUpdate = Record<string, unknown>;

/** 按顺序保存打印设置，再读取服务端计算的新内容版次。 */
export async function patchExamAndRefresh(
    paperId: string,
    updates: readonly ExamPrintUpdate[],
): Promise<ExamPaperDetail> {
    for (const update of updates) {
        await apiClient.patch(`/api/exams/${paperId}`, update);
    }
    return apiClient.get<ExamPaperDetail>(`/api/exams/${paperId}`);
}
