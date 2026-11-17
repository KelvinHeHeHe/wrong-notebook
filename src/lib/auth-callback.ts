/**
 * 登录成功后的回跳只接受本站绝对路径。
 * 拒绝协议相对 URL（//example.com）和所有外部协议，避免开放重定向。
 */
export function getSafeAuthCallbackUrl(value: string | null | undefined): string {
    if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
    return value;
}
