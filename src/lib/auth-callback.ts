/**
 * 登录成功后的回跳只接受本站绝对路径。
 * 拒绝协议相对 URL（//example.com）和所有外部协议，避免开放重定向。
 */
export function getSafeAuthCallbackUrl(value: string | null | undefined): string {
    if (!value) return '/';

    let validationValue = value;
    try {
        // URL 解析前先检查编码后的反斜杠和控制字符，避免浏览器规范化为外域地址。
        for (;;) {
            const decoded = decodeURIComponent(validationValue);
            if (decoded === validationValue) break;
            validationValue = decoded;
        }
    } catch {
        return '/';
    }
    if (!validationValue.startsWith('/') || validationValue.startsWith('//')
        || /[\\\u0000-\u001f\u007f]/.test(validationValue)) return '/';

    try {
        const trustedOrigin = 'https://callback.invalid';
        const parsed = new URL(value, trustedOrigin);
        if (parsed.origin !== trustedOrigin) return '/';
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return '/';
    }
}
