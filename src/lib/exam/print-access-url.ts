import { isExamPrintCode } from "@/lib/exam/exam-print-code";

export const PRINT_ACCESS_BASE_URL_STORAGE_KEY = "exam-print-access-base-url";

/** 规范化手机访问地址；允许反向代理子路径，但拒绝凭据、查询串和非 HTTP 协议。 */
export function normalizePrintAccessBaseUrl(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
        const url = new URL(trimmed);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        if (url.username || url.password || url.search || url.hash) return null;
        const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
        return `${url.origin}${pathname}`;
    } catch {
        return null;
    }
}

export function isLoopbackPrintAccessUrl(value: string): boolean {
    const normalized = normalizePrintAccessBaseUrl(value);
    if (!normalized) return false;
    const hostname = new URL(normalized).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost'
        || hostname.endsWith('.localhost')
        || hostname === '::1'
        || /^127\./.test(hostname);
}

export function buildExamScanUrl(baseUrl: string, printCode: string, printVersion: string): string | null {
    const normalized = normalizePrintAccessBaseUrl(baseUrl);
    if (!normalized || !isExamPrintCode(printCode) || !/^[a-f0-9]{12}$/.test(printVersion)) return null;
    return `${normalized}/exams/scan/${printCode}?v=${printVersion}`;
}
