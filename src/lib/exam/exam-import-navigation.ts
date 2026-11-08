import type { ExamOrigin, ExamStatus } from '@/types/api';

/** 未发布的外部试卷统一进入校对页；发布后继续复用现有详情与打印页。 */
export function shouldReviewImportedExam(paper: { origin?: ExamOrigin; status: ExamStatus }): boolean {
    return paper.origin === 'imported' && (paper.status === 'importing' || paper.status === 'review');
}
