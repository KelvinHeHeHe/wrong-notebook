import { expect, test } from './support/fixtures';

test('[E2E-PAPER-QR] 扫码登录、版次警告、所有权隔离与手机回传入口', async ({ page, scenario }) => {
    const paper = await scenario.db.examPaper.create({
        data: {
            userId: scenario.user.id,
            title: 'E2E 扫码回传卷',
            status: 'ready',
            scope: 'all',
            difficulty: 'original',
            mode: 'original',
            requestedCount: 1,
            subjectIds: JSON.stringify([scenario.book.id]),
            subjectId: scenario.book.id,
            printCode: 'Ab3xYz91',
            questions: { create: {
                order: 1,
                sourceShortId: 'QR0001',
                status: 'ready',
                questionText: '一加一等于几？',
                answerText: '二',
                score: 5,
                questionType: 'fill_blank',
            } },
        },
    });
    await scenario.db.examPaper.create({
        data: {
            userId: scenario.otherUser.id,
            title: '其他账号秘密试卷',
            status: 'ready',
            scope: 'all',
            difficulty: 'medium',
            requestedCount: 0,
            subjectIds: '[]',
            printCode: 'Cd4wXt82',
        },
    });

    await scenario.login(page);
    const detail = await (await page.request.get(`/api/exams/${paper.id}`)).json() as { printVersion: string };

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/exams/scan/Ab3xYz91?v=${detail.printVersion}`);
    await page.waitForURL(`/exams/${paper.id}/attempts/new`);
    await expect(page.getByRole('heading', { name: '回传纸质作答', exact: true })).toBeVisible();
    await expect(page.getByLabel('已作答试卷照片', { exact: true })).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.goto('/exams/scan/Ab3xYz91?v=deadbeefdead');
    await expect(page.getByRole('heading', { name: '纸质试卷版本不一致', exact: true })).toBeVisible();
    await expect(page.getByText('E2E 扫码回传卷', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '仍然上传', exact: true }).click();
    await expect(page).toHaveURL(`/exams/${paper.id}/attempts/new`);

    await page.goto('/exams/scan/Cd4wXt82?v=deadbeefdead');
    await expect(page.getByRole('alert').filter({ hasText: '无法找到这份试卷' })).toBeVisible();
    await expect(page.getByText('其他账号秘密试卷', { exact: true })).toHaveCount(0);

    await page.context().clearCookies();
    await page.goto(`/exams/scan/Ab3xYz91?v=${detail.printVersion}`);
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
    await page.locator('input[name="email"]').fill(scenario.user.email);
    await page.locator('input[name="password"]').fill('e2e-student-pass');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`/exams/${paper.id}/attempts/new`);
    await expect(page.getByRole('heading', { name: '回传纸质作答', exact: true })).toBeVisible();
});
