import { resolve } from 'node:path';

import { expect, test } from './support/fixtures';

const fixture = (name: string) => resolve('src/__tests__/fixtures/images', name);

test('[E2E-EXAM-IMPORT] 两页照片部分失败后单页重试、校对发布并复用打印', async ({ page, scenario }) => {
    await scenario.login(page);
    await scenario.control({ splitFailNext: 1 });
    const beforeItems = await scenario.db.errorItem.count({ where: { userId: scenario.user.id } });
    const beforeRecords = await scenario.db.practiceRecord.count({ where: { userId: scenario.user.id } });

    await page.goto('/exams/import');
    await page.getByLabel('试卷标题').fill('E2E 外部整卷周测');
    await page.getByLabel('PDF 或试卷照片').setInputFiles([
        fixture('multi-question-page.jpg'),
        fixture('math_test.png'),
    ]);
    await expect(page.getByRole('heading', { name: '共 2 页' })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: '创建并识别' }).click();
    await page.waitForURL(/\/exams\/[^/]+\/import\?failed=1$/, { timeout: 60000 });
    const paperId = new URL(page.url()).pathname.split('/')[2];

    await expect(page.getByText('第 1 页未识别到题目', { exact: true })).toBeVisible();
    const draft = await scenario.db.examPaper.findUniqueOrThrow({ where: { id: paperId }, include: { pages: true, questions: true } });
    expect(draft).toMatchObject({ origin: 'imported', status: 'review' });
    expect(draft.pages).toHaveLength(2);
    expect(draft.questions).toHaveLength(3);
    expect(draft.questions.every((question) => question.pageNumber === 2)).toBeTruthy();
    expect(await scenario.db.errorItem.count({ where: { userId: scenario.user.id } })).toBe(beforeItems);
    expect(await scenario.db.practiceRecord.count({ where: { userId: scenario.user.id } })).toBe(beforeRecords);

    await page.getByRole('button', { name: '重试第 1 页' }).click();
    await expect(page.getByText('第 1 页未识别到题目', { exact: true })).toHaveCount(0, { timeout: 30000 });
    await expect.poll(() => scenario.db.examQuestion.count({ where: { paperId } })).toBe(6);

    await page.getByRole('button', { name: '发布试卷' }).click();
    await page.waitForURL(`/exams/${paperId}`);
    await expect(page.getByText('已生成 6/6', { exact: true })).toBeVisible();
    expect(await scenario.db.examPaper.findUniqueOrThrow({ where: { id: paperId } })).toMatchObject({ status: 'ready', origin: 'imported' });
    expect(await scenario.db.errorItem.count({ where: { userId: scenario.user.id } })).toBe(beforeItems);
    expect(await scenario.db.practiceRecord.count({ where: { userId: scenario.user.id } })).toBe(beforeRecords);

    await page.locator(`a[href="/exams/${paperId}/print"]`).click();
    await expect(page).toHaveURL(`/exams/${paperId}/print`);
    await expect(page.getByText('E2E 外部整卷周测', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.exam-sheet > .exam-question')).toHaveCount(6);
});
