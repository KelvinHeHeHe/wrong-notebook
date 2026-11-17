import { describe, expect, it } from 'vitest';

import {
    buildExamScanUrl,
    isLoopbackPrintAccessUrl,
    normalizePrintAccessBaseUrl,
} from '@/lib/exam/print-access-url';

describe('打印稿手机访问地址', () => {
    it('只接受 http/https 并去掉空白和末尾斜杠', () => {
        expect(normalizePrintAccessBaseUrl(' http://192.168.1.8:3000/ ')).toBe('http://192.168.1.8:3000');
        expect(normalizePrintAccessBaseUrl('https://family.example/app/')).toBe('https://family.example/app');
        expect(normalizePrintAccessBaseUrl('ftp://192.168.1.8/file')).toBeNull();
        expect(normalizePrintAccessBaseUrl('not-a-url')).toBeNull();
        expect(normalizePrintAccessBaseUrl('https://user:secret@family.example')).toBeNull();
    });

    it.each([
        'http://localhost:3000',
        'http://child.localhost:3000',
        'http://127.0.0.1:3000',
        'http://127.9.8.7:3000',
        'http://[::1]:3000',
    ])('识别手机通常无法访问的回环地址 %s', (value) => {
        expect(isLoopbackPrintAccessUrl(value)).toBe(true);
    });

    it('不把局域网和正式域名误判为回环地址', () => {
        expect(isLoopbackPrintAccessUrl('http://192.168.1.8:3000')).toBe(false);
        expect(isLoopbackPrintAccessUrl('https://family.example')).toBe(false);
    });

    it('用规范地址、短码和版次生成扫码回传 URL', () => {
        expect(buildExamScanUrl('http://192.168.1.8:3000/', 'Ab3xYz91', 'abcdef123456'))
            .toBe('http://192.168.1.8:3000/exams/scan/Ab3xYz91?v=abcdef123456');
        expect(buildExamScanUrl('ftp://192.168.1.8', 'Ab3xYz91', 'abcdef123456')).toBeNull();
        expect(buildExamScanUrl('http://192.168.1.8', 'invalid', 'abcdef123456')).toBeNull();
        expect(buildExamScanUrl('http://192.168.1.8', 'Ab3xYz91', 'wrong')).toBeNull();
    });
});
