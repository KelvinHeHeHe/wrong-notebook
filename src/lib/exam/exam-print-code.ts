/** Base58 字母表去掉 0、O、I、l，便于从纸面抄录。 */
export const EXAM_PRINT_CODE_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const EXAM_PRINT_CODE_LENGTH = 8;

const EXAM_PRINT_CODE_PATTERN = new RegExp(
    `^[${EXAM_PRINT_CODE_ALPHABET}]{${EXAM_PRINT_CODE_LENGTH}}$`,
);

export function isExamPrintCode(value: string | null | undefined): value is string {
    return typeof value === "string" && EXAM_PRINT_CODE_PATTERN.test(value);
}
