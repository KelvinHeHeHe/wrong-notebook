import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExamStatusBadge, getExamDisplayStatus } from '@/components/exam/exam-status-badge';
import { LanguageProvider } from '@/contexts/LanguageContext';

const render = (element: React.ReactElement) => renderToStaticMarkup(<LanguageProvider>{element}</LanguageProvider>);

describe('试卷状态徽章', () => {
    it('生成完成但未录入结果时显示「已生成」', () => {
        expect(getExamDisplayStatus('ready', false)).toBe('ready');
        expect(render(<ExamStatusBadge status="ready" recorded={false} />)).toContain('已生成');
    });

    it('至少录入过一次结果时显示「已完成」', () => {
        expect(getExamDisplayStatus('ready', true)).toBe('completed');
        expect(getExamDisplayStatus('partial', true)).toBe('completed');
        expect(render(<ExamStatusBadge status="ready" recorded />)).toContain('已完成');
    });

    it('生成中、部分失败（未录入）和生成失败保持原状态', () => {
        expect(getExamDisplayStatus('generating', true)).toBe('generating');
        expect(getExamDisplayStatus('failed', true)).toBe('failed');
        expect(render(<ExamStatusBadge status="partial" recorded={false} />)).toContain('部分失败');
    });

    it('外部试卷导入中与待校对显示独立状态', () => {
        expect(getExamDisplayStatus('importing', false)).toBe('importing');
        expect(getExamDisplayStatus('review', false)).toBe('review');
        expect(render(<ExamStatusBadge status="importing" recorded={false} />)).toContain('导入中');
        expect(render(<ExamStatusBadge status="review" recorded={false} />)).toContain('待校对');
    });
});
