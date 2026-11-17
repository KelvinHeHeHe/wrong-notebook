import { describe, expect, it } from 'vitest';

import { getSafeAuthCallbackUrl } from '@/lib/auth-callback';

describe('登录回跳地址', () => {
    it('保留站内路径、查询串和片段', () => {
        expect(getSafeAuthCallbackUrl('/exams/scan/Ab3xYz91?v=abcdef123456#upload'))
            .toBe('/exams/scan/Ab3xYz91?v=abcdef123456#upload');
    });

    it.each([
        null,
        '',
        'https://evil.example/exams/scan/Ab3xYz91',
        '//evil.example/exams/scan/Ab3xYz91',
        'javascript:alert(1)',
        'exams/scan/Ab3xYz91',
    ])('拒绝非站内相对地址 %s 并回到首页', (value) => {
        expect(getSafeAuthCallbackUrl(value)).toBe('/');
    });
});
