// @vitest-environment node
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { cropAttemptAnswerImage } from '@/lib/exam/exam-attempt-image';

let image: string;
const regionJson = (regions: unknown[]) => JSON.stringify({ pageOrder: 1, candidateId: null, regions });
beforeAll(async () => {
    const bytes = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#123456' } }).png().toBuffer();
    image = `data:image/png;base64,${bytes.toString('base64')}`;
});

describe('作答区域裁图', () => {
    it('以多个区域的联合外接矩形裁剪，保留边缘像素', async () => {
        const cropped = await cropAttemptAnswerImage(image, 'image/png', regionJson([
            { x: 0.105, y: 0.1, width: 0.2, height: 0.2 },
            { x: 0.6, y: 0.5, width: 0.2, height: 0.4 },
        ]));
        const metadata = await sharp(Buffer.from(cropped.split(',')[1], 'base64')).metadata();
        expect(metadata).toMatchObject({ width: 70, height: 64 });
    });
    it('支持单个区域和裸 base64 页图', async () => {
        const cropped = await cropAttemptAnswerImage(image.split(',')[1], 'image/png', regionJson([{ x: 0, y: 0, width: 0.5, height: 0.5 }]));
        expect(await sharp(Buffer.from(cropped.split(',')[1], 'base64')).metadata()).toMatchObject({ width: 50, height: 40 });
    });
    it.each([null, '{', regionJson([]), regionJson([{ x: 0.9, y: 0, width: 0.2, height: 0.2 }]), regionJson(Array.from({ length: 5 }, () => ({ x: 0, y: 0, width: 1, height: 1 })))])('非法或空区域返回原整页：%s', async (regions) => {
        expect(await cropAttemptAnswerImage(image, 'image/png', regions)).toBe(image);
    });
    it('图片解码失败时返回原整页', async () => {
        expect(await cropAttemptAnswerImage('broken', 'image/png', regionJson([{ x: 0, y: 0, width: 1, height: 1 }]))).toBe('data:image/png;base64,broken');
    });
});
