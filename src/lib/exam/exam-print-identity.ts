import "server-only";

import { createHash, randomBytes } from "node:crypto";

import {
    EXAM_PRINT_CODE_ALPHABET,
    EXAM_PRINT_CODE_LENGTH,
    isExamPrintCode,
} from "@/lib/exam/exam-print-code";
import { normalizeQuestionType } from "@/lib/question/question-type";

export { isExamPrintCode } from "@/lib/exam/exam-print-code";

const MAX_ATTEMPTS = 10;

export interface PrintableExamQuestion {
    order: number;
    status: string;
    sourceShortId: string;
    questionText: string | null;
    answerText: string | null;
    analysis: string | null;
    figureSvg: string | null;
    figureScale: number;
    figureAlign: string;
    answerSpacePx: number | null;
    score: number | null;
    questionType: string | null;
    errorItemQuestionType?: string | null;
    errorItem?: { questionType: string | null } | null;
    externalNumber: string | null;
}

export interface PrintableExamPaper {
    title: string;
    groupByType: boolean;
    questions: PrintableExamQuestion[];
}

interface ExamPrintCodeLookup {
    examPaper: {
        findUnique(args: { where: { printCode: string }; select: { id: true } }): Promise<{ id: string } | null>;
    };
}

interface ExamPrintCodeManager extends ExamPrintCodeLookup {
    examPaper: ExamPrintCodeLookup["examPaper"] & {
        findUnique(args: {
            where: { id: string };
            select: { id: true; printCode: true };
        }): Promise<{ id: string; printCode: string | null } | null>;
        updateMany(args: {
            where: { id: string; printCode: null };
            data: { printCode: string };
        }): Promise<{ count: number }>;
    };
}

/** 生成 8 位 Base58 打印短码；拒绝采样避免取模偏差。 */
export function generateExamPrintCode(): string {
    let code = "";
    while (code.length < EXAM_PRINT_CODE_LENGTH) {
        for (const byte of randomBytes(EXAM_PRINT_CODE_LENGTH * 2)) {
            if (byte < 232 && code.length < EXAM_PRINT_CODE_LENGTH) {
                code += EXAM_PRINT_CODE_ALPHABET[byte % EXAM_PRINT_CODE_ALPHABET.length];
            }
        }
    }
    return code;
}

export async function generateUniqueExamPrintCode(client: ExamPrintCodeLookup): Promise<string> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const printCode = generateExamPrintCode();
        const existing = await client.examPaper.findUnique({ where: { printCode }, select: { id: true } });
        if (!existing) return printCode;
    }
    throw new Error("无法生成唯一的试卷打印短码");
}

function isPrintCodeUniqueConflict(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "P2002") return false;
    const meta = "meta" in error && typeof error.meta === "object" && error.meta !== null ? error.meta : null;
    const target = meta && "target" in meta ? meta.target : null;
    if (Array.isArray(target)) return target.some((value) => value === "printCode");
    return typeof target === "string" && target.toLowerCase().includes("printcode");
}

/** 创建试卷时把实际写入包含在唯一冲突重试边界内。 */
export async function createExamPaperWithPrintCode<T>(
    client: ExamPrintCodeLookup,
    create: (printCode: string) => Promise<T>,
    preferredPrintCode?: string | null,
): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const printCode = attempt === 0 && isExamPrintCode(preferredPrintCode)
            ? preferredPrintCode
            : generateExamPrintCode();
        const existing = await client.examPaper.findUnique({ where: { printCode }, select: { id: true } });
        if (existing) continue;
        try {
            return await create(printCode);
        } catch (error) {
            if (!isPrintCodeUniqueConflict(error)) throw error;
        }
    }
    throw new Error("无法生成唯一的试卷打印短码");
}

/** 为既有试卷惰性补码；并发请求只接受数据库中最终胜出的短码。 */
export async function ensureExamPrintCode(client: ExamPrintCodeManager, paperId: string): Promise<string> {
    const paper = await client.examPaper.findUnique({
        where: { id: paperId },
        select: { id: true, printCode: true },
    });
    if (!paper) throw new Error("试卷不存在");
    if (isExamPrintCode(paper.printCode)) return paper.printCode;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const printCode = await generateUniqueExamPrintCode(client);
        try {
            const updated = await client.examPaper.updateMany({
                where: { id: paperId, printCode: null },
                data: { printCode },
            });
            if (updated.count === 1) return printCode;
        } catch (error) {
            if (!isPrintCodeUniqueConflict(error)) throw error;
            continue;
        }

        const current = await client.examPaper.findUnique({
            where: { id: paperId },
            select: { id: true, printCode: true },
        });
        if (isExamPrintCode(current?.printCode)) return current.printCode;
    }
    throw new Error("无法写入试卷打印短码");
}

/** 按固定字段顺序序列化，避免调用侧对象键顺序影响内容版次。 */
export function createExamPrintVersion(paper: PrintableExamPaper): string {
    const normalized = {
        title: paper.title,
        groupByType: paper.groupByType,
        questions: paper.questions.map((question) => ({
            order: question.order,
            status: question.status,
            sourceShortId: question.sourceShortId,
            questionText: question.questionText,
            answerText: question.answerText,
            analysis: question.analysis,
            figureSvg: question.figureSvg,
            figureScale: question.figureScale,
            figureAlign: question.figureAlign,
            answerSpacePx: question.answerSpacePx,
            score: question.score,
            questionType: normalizeQuestionType(question.questionType)
                ?? normalizeQuestionType(question.errorItemQuestionType ?? question.errorItem?.questionType),
            externalNumber: question.externalNumber,
        })),
    };
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}
