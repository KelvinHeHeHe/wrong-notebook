import 'server-only';

import sharp from 'sharp';

import { parseAttemptRegionJson } from '@/lib/exam/exam-attempt';
import { DEFAULT_IMAGE_LIMITS } from '@/lib/image-pipeline';

/** 多个答案区域合并裁图；坏区域或坏图片保留整页，避免丢失作答证据。 */
export async function cropAttemptAnswerImage(imageData: string, mimeType: string, regionJson: string | null): Promise<string> {
    const original = imageData.startsWith('data:') ? imageData : `data:${mimeType};base64,${imageData}`;
    const parsed = parseAttemptRegionJson(regionJson);
    if (!parsed?.regions.length) return original;
    try {
        const image = sharp(Buffer.from(original.slice(original.indexOf(',') + 1), 'base64'), {
            failOn: 'warning', limitInputPixels: DEFAULT_IMAGE_LIMITS.maxPixels,
        });
        const { width, height } = await image.metadata();
        if (!width || !height) return original;
        const left = Math.floor(Math.min(...parsed.regions.map((region) => region.x)) * width);
        const top = Math.floor(Math.min(...parsed.regions.map((region) => region.y)) * height);
        const right = Math.ceil(Math.max(...parsed.regions.map((region) => region.x + region.width)) * width);
        const bottom = Math.ceil(Math.max(...parsed.regions.map((region) => region.y + region.height)) * height);
        const bytes = await image.extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
        return `data:image/png;base64,${bytes.toString('base64')}`;
    } catch {
        return original;
    }
}
