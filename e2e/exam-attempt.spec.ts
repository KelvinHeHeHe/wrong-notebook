import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { acceptConfirmDialog } from './helpers';
import { openSettings } from './support/flows';
import { expect, runState, test } from './support/fixtures';

for (const mobile of [false, true]) {
    test(`[E2E-PAPER-RETURN] ${mobile ? '手机' : '桌面'}两页部分失败、复核确认与 v13 备份恢复`, async ({ page, scenario }) => {
        test.setTimeout(150000);
        if (mobile) await page.setViewportSize({ width: 390, height: 844 });
        const linked = await scenario.item('A', { questionType: 'solution', masteryProbability: 0.2, masteryEvaluatedAt: new Date() });
        const duplicate = await scenario.item('B', { masteryProbability: 0.4, masteryEvaluatedAt: new Date() });
        const paper = await scenario.db.examPaper.create({ data: { userId: scenario.user.id, title: '合成纸质作答验收卷', origin: 'imported', status: 'ready', scope: 'all', difficulty: 'medium', requestedCount: 5,
            subjectId: scenario.book.id, subjectIds: JSON.stringify([scenario.book.id]), questions: { create: Array.from({ length: 5 }, (_, index) => ({ order: index + 1, sourceShortId: `SRC00${index + 1}`, status: 'ready', score: 10,
                questionText: index === 4 ? duplicate.questionText : ['合成选择题：下列哪一个图形有三条边？', '合成证明题：证明两个连续偶数的差等于二。', '合成填空题：计算一百减去三十。', '合成应用题：小船顺流航行，求到达码头所需时间。'][index], answerText: '标准答案', analysis: '合成解析', questionType: index === 1 ? 'solution' : 'choice',
                errorItemId: index === 1 ? linked.id : null })) } }, include: { questions: { orderBy: { order: 'asc' } } } });
        const baseline = await scenario.db.errorItem.findMany({ where: { userId: scenario.user.id }, orderBy: { id: 'asc' } });
        await scenario.control({ extractionFailOnCall: 2, masteryProbability: 70 });
        await scenario.login(page);
        await page.goto(`/exams/${paper.id}`);
        await page.locator(`a[href="/exams/${paper.id}/print"]`).click();
        await expect(page.locator('.exam-sheet > .exam-question')).toHaveCount(5);
        await page.goBack();
        await page.getByRole('link', { name: '回传纸质作答', exact: true }).click();
        await expect(page).toHaveURL(`/exams/${paper.id}/attempts/new`);
        await page.getByLabel('已作答试卷照片', { exact: true }).setInputFiles([
            resolve('src/__tests__/fixtures/images/multi-question-page.jpg'), resolve('src/__tests__/fixtures/images/math_test.png'),
        ]);
        await expect(page.getByRole('heading', { name: '共 2 页' })).toBeVisible({ timeout: 30000 });
        await page.getByRole('button', { name: '上传并识别', exact: true }).click();
        await page.waitForURL(/\/exam-attempts\/[^/?]+/, { timeout: 60000 });
        const attemptId = new URL(page.url()).pathname.split('/').pop()!;
        await expect(page.getByText('页面识别：1 / 2', { exact: true })).toBeVisible();
        await expect(page.getByText('本页识别失败，可重试', { exact: true })).toBeVisible();
        const firstPage = await scenario.db.examAttemptPage.findFirstOrThrow({ where: { attemptId, order: 1 } });
        await page.getByRole('button', { name: '重试第 2 页', exact: true }).click();
        await expect(page.getByText('页面识别：2 / 2', { exact: true })).toBeVisible({ timeout: 30000 });
        expect((await scenario.db.examAttemptPage.findUniqueOrThrow({ where: { id: firstPage.id } })).recognitionResult).toBe(firstPage.recognitionResult);
        const card = (number: number) => page.getByRole('article', { name: `第 ${number} 题`, exact: true });
        await expect(card(1).getByText('必须人工复核', { exact: true })).toBeVisible();
        await expect(card(2).getByText('必须人工复核', { exact: true })).toBeVisible();
        // 两页提取后，三个匹配且有作答的题必须经过独立第二阶段判分。
        await expect.poll(async () => (await scenario.model()).calls.filter((call) => call.operation === 'grade' && call.completed).length).toBe(3);
        const gradeCalls = (await scenario.model()).calls.filter((call) => call.operation === 'grade');
        expect(gradeCalls.every((call) => !call.hasImage && !call.failed && call.completed)).toBe(true);
        const aiSuggestion = { recognizedAnswer: '正确答案', result: 'correct', awardedScore: 10, maxScore: 10, gradingReason: '测试夹具判定：结论及论证完整', gradingSource: 'ai', reviewStatus: 'pending' };
        await expect(card(3).getByLabel('识别答案', { exact: true })).toHaveValue(aiSuggestion.recognizedAnswer);
        await expect(card(3).getByLabel('结果', { exact: true })).toHaveValue(aiSuggestion.result);
        await expect(card(3).getByLabel('得分', { exact: true })).toHaveValue('10');
        await expect(card(3).getByLabel('判分理由 / 人工备注', { exact: true })).toHaveValue(aiSuggestion.gradingReason);
        await expect(card(3).getByText('AI 建议，待整卷确认', { exact: true })).toBeVisible();
        const aiAnswerWhere = { attemptId_examQuestionId: { attemptId, examQuestionId: paper.questions[2].id } };
        expect(await scenario.db.examAttemptAnswer.findUniqueOrThrow({ where: aiAnswerWhere })).toMatchObject(aiSuggestion);
        await card(1).getByRole('button', { name: '查看作答区域', exact: true }).click();
        await expect(card(1).getByRole('img')).toBeVisible();
        const candidate = page.getByRole('listitem').filter({ has: page.getByText('待人工映射答案', { exact: true }) });
        await candidate.getByLabel('目标题目', { exact: true }).selectOption({ label: '第 4 题' });
        await candidate.getByRole('button', { name: '映射到此题', exact: true }).click();
        await expect(candidate.getByRole('button', { name: '已映射', exact: true })).toBeDisabled();
        await page.reload();
        await expect(card(4).getByLabel('识别答案', { exact: true })).toHaveValue('待人工映射答案');
        for (const [number, result, score] of [[1, 'wrong', '0'], [2, 'wrong', '7'], [4, 'wrong', '0'], [5, 'not_attempted', '0']] as const) {
            await card(number).getByLabel('识别答案', { exact: true }).fill(number === 5 ? '' : `人工修正答案 ${number}`);
            await card(number).getByLabel('结果', { exact: true }).selectOption(result);
            await card(number).getByLabel('得分', { exact: true }).fill(score);
            await card(number).getByRole('button', { name: '保存并标记已复核', exact: true }).click();
            await expect(card(number).getByText('已人工复核', { exact: true })).toBeVisible();
        }
        // 第三题保留 AI 的 pending 建议直接整卷确认，不用人工结果掩盖判分链路。
        expect(await scenario.db.examAttemptAnswer.findUniqueOrThrow({ where: aiAnswerWhere })).toMatchObject(aiSuggestion);
        expect(await scenario.db.errorItem.findMany({ where: { userId: scenario.user.id }, orderBy: { id: 'asc' } })).toEqual(baseline);
        expect(await scenario.db.practiceRecord.count({ where: { userId: scenario.user.id } })).toBe(0);
        expect((await scenario.model()).calls.filter((call) => call.operation === 'mastery')).toHaveLength(0);
        // 客户端汇总字段不参与确认：服务端必须按持久化逐题分数重算。
        await scenario.db.examAttempt.update({ where: { id: attemptId }, data: { totalScore: 999, maxScore: 999 } });
        await page.reload();
        if (mobile) {
            const footer = await page.locator('main footer').boundingBox();
            const navigation = await page.locator('nav.fixed').boundingBox();
            expect(footer).not.toBeNull();
            expect(navigation).not.toBeNull();
            expect(footer!.y + footer!.height).toBeLessThanOrEqual(navigation!.y);
            const modal = await openSettings(page, '危险');
            await expect(modal).toBeVisible();
            expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('footer') === null, { x: footer!.x + footer!.width / 2, y: footer!.y + footer!.height / 2 })).toBe(true);
            await modal.getByRole('button', { name: 'Close', exact: true }).click();
        }
        const confirmBounds = await page.getByRole('button', { name: '确认成绩', exact: true }).boundingBox();
        expect(confirmBounds).not.toBeNull();
        await expect(page.locator('[data-background-tasks-floating]')).toBeHidden();
        await page.locator('main footer').getByRole('button', { name: '后台任务', exact: true }).click();
        const tasks = page.getByRole('dialog', { name: '后台任务', exact: true });
        await expect(tasks).toBeVisible();
        expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('footer') === null, { x: confirmBounds!.x + confirmBounds!.width / 2, y: confirmBounds!.y + confirmBounds!.height / 2 })).toBe(true);
        await tasks.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: '确认成绩', exact: true }).click();
        await page.waitForURL(`/exams/${paper.id}`);
        await expect(page.getByRole('region', { name: '纸质作答历史' }).getByText('得分：17 / 50', { exact: true })).toBeVisible();
        const confirmed = await scenario.db.examAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { answers: true, pages: { orderBy: { order: 'asc' } } } });
        expect(confirmed).toMatchObject({ status: 'confirmed', totalScore: 17, maxScore: 50 });
        expect(confirmed.answers.find((answer) => answer.examQuestionId === paper.questions[2].id)).toMatchObject(aiSuggestion);
        const records = await scenario.records();
        expect(records).toHaveLength(5);
        expect(records.every((record) => record.source === 'exam' && record.examAttemptId === attemptId)).toBeTruthy();
        expect(new Set(records.map((record) => record.examQuestionId)).size).toBe(5);
        expect(records.find((record) => record.examQuestionId === paper.questions[2].id)).toMatchObject({ source: 'exam', result: 'correct', isCorrect: true, wrongAnswerText: aiSuggestion.recognizedAnswer, errorItemId: null });
        const questions = await scenario.db.examQuestion.findMany({ where: { paperId: paper.id }, orderBy: { order: 'asc' } });
        expect(questions[1].errorItemId).toBe(linked.id);
        expect(questions[2].errorItemId).toBeNull();
        expect(questions[4].errorItemId).toBe(duplicate.id);
        expect(questions[0].errorItemId).toBeTruthy();
        expect(questions[3].errorItemId).toBeTruthy();
        expect(await scenario.db.errorItem.count({ where: { userId: scenario.user.id } })).toBe(4);
        await expect.poll(async () => (await scenario.model()).calls.filter((call) => call.operation === 'mastery' && call.completed).length).toBe(4);
        const callsBefore = (await scenario.model()).calls.length;
        expect((await page.request.post(`/api/exam-attempts/${attemptId}/confirm`, { data: { expectedUpdatedAt: confirmed.updatedAt.toISOString() } })).ok()).toBeTruthy();
        expect(await scenario.records()).toHaveLength(5);
        expect(await scenario.db.errorItem.count({ where: { userId: scenario.user.id } })).toBe(4);
        expect((await scenario.model()).calls).toHaveLength(callsBefore);

        // 备份夹具：同一张试卷、同一作答日期仍是第二次独立作答。
        const secondAttempt = await scenario.db.examAttempt.create({ data: {
            userId: scenario.user.id, paperId: paper.id, takenAt: confirmed.takenAt, status: 'confirmed', comment: '同日第二份作答', totalScore: 50, maxScore: 50, confirmedAt: new Date(),
            pages: { create: { order: 3, imageData: confirmed.pages[0].imageData, mimeType: confirmed.pages[0].mimeType, checksum: confirmed.pages[0].checksum, recognitionResult: confirmed.pages[0].recognitionResult } },
            answers: { create: confirmed.answers.map((answer) => ({ examQuestionId: answer.examQuestionId, recognizedAnswer: '同日第二份答案', result: 'correct', awardedScore: 10, maxScore: 10, gradingSource: 'manual', reviewStatus: 'reviewed' })) },
        } });
        for (const question of questions) await scenario.db.practiceRecord.create({ data: { userId: scenario.user.id, examAttemptId: secondAttempt.id, examQuestionId: question.id, errorItemId: question.errorItemId, source: 'exam', result: 'correct', isCorrect: true, questionText: question.questionText, wrongAnswerText: '同日第二份答案' } });

        await page.goto('/');
        const settings = await openSettings(page, '危险');
        const downloaded = page.waitForEvent('download');
        await settings.getByRole('button', { name: '导出数据', exact: true }).click();
        const file = join(runState.reportDir, `${scenario.id}-paper-return.json`);
        await (await downloaded).saveAs(file);
        const contents = readFileSync(file, 'utf8');
        expect(JSON.parse(contents).version).toBe(13);
        expect(contents).not.toContain('e2e-dummy-key');
        await scenario.resetCurrentAccount();
        await scenario.login(page);
        await page.goto('/');
        const restore = await openSettings(page, '危险');
        await restore.locator('input[type="file"]').setInputFiles(file);
        await restore.getByRole('button', { name: '导入数据', exact: true }).click();
        const imported = page.waitForResponse((response) => response.url().endsWith('/api/import') && response.request().method() === 'POST');
        const reloaded = page.waitForEvent('load');
        await acceptConfirmDialog(page);
        expect((await imported).ok()).toBeTruthy();
        await reloaded;
        const restored = await scenario.db.examAttempt.findFirstOrThrow({ where: { userId: scenario.user.id, comment: null }, include: { answers: true, pages: { orderBy: { order: 'asc' } }, paper: { include: { questions: true } } } });
        expect(await scenario.db.examAttempt.count({ where: { userId: scenario.user.id, paperId: restored.paperId, takenAt: restored.takenAt } })).toBe(2);
        expect(restored).toMatchObject({ status: 'confirmed', totalScore: 17, maxScore: 50 });
        expect(restored.pages.map((item) => ({ imageData: item.imageData, recognitionResult: item.recognitionResult }))).toEqual(confirmed.pages.map((item) => ({ imageData: item.imageData, recognitionResult: item.recognitionResult })));
        expect(restored.answers).toHaveLength(5);
        for (const answer of restored.answers) {
            const question = restored.paper.questions.find((item) => item.id === answer.examQuestionId)!;
            const original = confirmed.answers.find((item) => item.examQuestionId === paper.questions[question.order - 1].id)!;
            expect(answer).toMatchObject({ recognizedAnswer: original.recognizedAnswer, regionJson: original.regionJson, result: original.result, awardedScore: original.awardedScore, reviewStatus: original.reviewStatus, gradingSource: original.gradingSource, gradingReason: original.gradingReason });
            expect(await scenario.db.practiceRecord.count({ where: { userId: scenario.user.id, examAttemptId: restored.id, examQuestionId: question.id, errorItemId: question.errorItemId } })).toBe(1);
        }
        const secondRestored = await scenario.db.examAttempt.findFirstOrThrow({ where: { userId: scenario.user.id, comment: '同日第二份作答' }, include: { pages: true, answers: true } });
        expect(secondRestored).toMatchObject({ status: 'confirmed', totalScore: 50, maxScore: 50 });
        expect(secondRestored.pages).toEqual([expect.objectContaining({ order: 3, imageData: confirmed.pages[0].imageData, recognitionResult: confirmed.pages[0].recognitionResult })]);
        expect(secondRestored.answers).toHaveLength(5);
        expect(secondRestored.answers.every((answer) => answer.recognizedAnswer === '同日第二份答案')).toBe(true);
        const secondRecords = await scenario.db.practiceRecord.findMany({ where: { userId: scenario.user.id, examAttemptId: secondRestored.id } });
        expect(secondRecords).toHaveLength(5);
        expect(secondRecords.every((record) => record.wrongAnswerText === '同日第二份答案' && record.source === 'exam' && secondRestored.answers.some((answer) => answer.examQuestionId === record.examQuestionId))).toBe(true);
        await page.goto(`/exam-attempts/${restored.id}`);
        await expect(page.getByText('成绩已确认', { exact: true })).toBeVisible();
        await expect(page.getByText('待人工映射答案', { exact: true })).toBeVisible();
    });
}
