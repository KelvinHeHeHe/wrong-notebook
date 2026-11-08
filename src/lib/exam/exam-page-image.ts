import "server-only";

import { createHash } from 'node:crypto';

import sharp from 'sharp';

import { DEFAULT_IMAGE_LIMITS } from '@/lib/image-pipeline';

interface ExamPageImageInput {
    imageData: string;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    width: number;
    height: number;
}

const FORMAT_BY_MIME: Record<ExamPageImageInput['mimeType'], string> = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/webp': 'webp',
};

export class ExamPageImageError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'ExamPageImageError';
    }
}

/** 解码并校验页图，尺寸与 MIME 均以文件内容为准，checksum 基于原始字节。 */
export async function validateExamPageImage(input: ExamPageImageInput): Promise<{ checksum: string }> {
    const prefix = `data:${input.mimeType};base64,`;
    if (!input.imageData.startsWith(prefix)) throw new ExamPageImageError('EXAM_PAGE_MIME_MISMATCH');

    const bytes = Buffer.from(input.imageData.slice(prefix.length), 'base64');
    if (bytes.length === 0) throw new ExamPageImageError('EXAM_PAGE_INVALID');
    if (bytes.length > DEFAULT_IMAGE_LIMITS.maxBytes) throw new ExamPageImageError('EXAM_PAGE_TOO_LARGE');

    try {
        const image = sharp(bytes, {
            failOn: 'warning',
            limitInputPixels: DEFAULT_IMAGE_LIMITS.maxPixels,
        });
        const metadata = await image.metadata();
        if (metadata.format !== FORMAT_BY_MIME[input.mimeType]) {
            throw new ExamPageImageError('EXAM_PAGE_MIME_MISMATCH');
        }
        if (!metadata.width || !metadata.height) throw new ExamPageImageError('EXAM_PAGE_INVALID');
        if (metadata.width !== input.width || metadata.height !== input.height) {
            throw new ExamPageImageError('EXAM_PAGE_DIMENSIONS_MISMATCH');
        }
        if (metadata.width > DEFAULT_IMAGE_LIMITS.maxLongEdge || metadata.height > DEFAULT_IMAGE_LIMITS.maxLongEdge
            || metadata.width * metadata.height > DEFAULT_IMAGE_LIMITS.maxPixels) {
            throw new ExamPageImageError('EXAM_PAGE_PIXELS_EXCEEDED');
        }
        // stats 会实际解码像素，避免只伪造合法文件头的载荷通过校验。
        await image.stats();
    } catch (error) {
        if (error instanceof ExamPageImageError) throw error;
        throw new ExamPageImageError('EXAM_PAGE_INVALID');
    }

    return { checksum: createHash('sha256').update(bytes).digest('hex') };
}

/** 顺序解码页图，避免 20 页大图同时进入 libvips 造成家庭设备内存峰值。 */
export async function validateExamPageImages<T extends ExamPageImageInput>(pages: T[]): Promise<Array<T & { checksum: string }>> {
    const validated: Array<T & { checksum: string }> = [];
    for (const page of pages) {
        validated.push({ ...page, checksum: (await validateExamPageImage(page)).checksum });
    }
    return validated;
}
