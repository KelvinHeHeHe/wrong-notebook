# 成绩趋势实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有统计中心增加按当前用户、学科和时间筛选的已确认考试趋势，并能从趋势进入既有作答详情。

**Architecture:** 扩展现有统计范围工具但保留原 30 天默认值；新增服务端 `getExamTrendStats` 直接查询 `ExamAttempt(status='confirmed')` 并返回不含图片的 DTO。前端在 `/stats?tab=exams` 复用筛选栏、统计状态和 Recharts，考试标签页单独以 90 天为默认范围，图表与可访问列表共享同一响应数据。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、Prisma 5、SQLite、Recharts、Tailwind CSS 4、Vitest、Playwright

**Spec:** `docs/superpowers/specs/2026-11-10-task-05-exam-trends-design.md`

## Global Constraints

- 不修改 Prisma Schema，不新增迁移，不升级备份格式。
- 只统计当前用户且 `status='confirmed'`、`totalScore != null`、`maxScore > 0` 的 `ExamAttempt`。
- 得分率为 `totalScore / maxScore * 100`，平均值为各次得分率的算术平均，均四舍五入到 1 位小数。
- 错题数为逐题结果 `wrong | not_attempted` 的次数之和，不按题目去重。
- 考试趋势默认 90 天；现有错题和练习统计默认仍为 30 天。
- `90d` 在既有错题/练习统计中按月分桶；考试趋势按每次考试独立展示，不分桶。
- 所有日期边界和服务端 `dateLabel` 使用 `getAppTimeZone()` 返回的应用时区。
- API 使用 `withUser`；服务端统计模块首行 `import "server-only"`；查询不得选择页面图片、识别结果或答案原文。
- 中英文 key 必须一致；移动优先；组件超过约 200 行时继续拆分。
- 不增加依赖，不引入 Python/OCR 服务，不主动运行生产构建。
- 每个任务先写失败测试，再实现最小代码；lint 必须零警告，不弱化既有断言。

## Review Focus

- 外部用户的 `subjectId` 或作答不能泄露：Task 2 集成测试固定“非法学科按未筛选处理但仍只查当前用户”。
- `maxScore` 为 0、分数为空或非确认状态不能产生 `NaN`/虚构 0%：Task 2 查询与空响应测试固定。
- 同一 `takenAt` 的多次作答必须稳定保留：Task 2 单元测试和 Task 4 E2E 固定 `createdAt + id` 次级排序。
- `90d` 不得改变其他统计默认值，跨时区边界不能串日：Task 1 单元测试和 Task 2 集成测试固定。
- SVG 数据点不能成为唯一入口：Task 3 单元测试固定键盘操作与普通详情 `<Link>`，Task 4 E2E 验证移动端列表导航。

---

### Task 1: 扩展 90 天范围与标签感知筛选

**Files:**
- Modify: `src/lib/stats/stats-range-core.ts`
- Modify: `src/lib/stats/stats-range.ts`
- Modify: `src/types/api.ts`
- Modify: `src/components/stats/stats-filter-bar.tsx`
- Modify: `src/lib/i18n/zh.ts`
- Modify: `src/lib/i18n/en.ts`
- Modify: `src/__tests__/unit/stats-range.test.ts`
- Create: `src/__tests__/unit/stats-filter-bar.test.tsx`

**Interfaces:**
- Produces: `StatsRange = '7d' | '30d' | '90d' | '6m' | 'all'`。
- Produces: `parseStatsRange(raw, defaultRange?: StatsRange): StatsRange`，`defaultRange` 缺省为 `'30d'`。
- Produces: `StatsFilterBar({ defaultRange?: StatsRange })`，缺省仍为 `'30d'`。
- Consumes: 现有 `getDayRange`、`getMonthStart` 和 Next.js URL 查询参数逻辑。

- [ ] **Step 1: 写 `stats-range` 失败测试**

在 `src/__tests__/unit/stats-range.test.ts` 增加以下断言：

```ts
expect(parseStatsRange('90d')).toBe('90d');
expect(parseStatsRange(null, '90d')).toBe('90d');
expect(parseStatsRange('invalid', '90d')).toBe('90d');
expect(parseStatsRange(null)).toBe('30d');
expect(getStatsGranularity('90d')).toBe('month');
expect(getRangeStart('90d', now, 'Asia/Shanghai')?.toISOString())
    .toBe('2026-07-20T16:00:00.000Z');
```

再验证 `resolveStatsRange('90d', null, now, TZ)` 从 90 天起点所在月到当前月生成月桶，首桶允许早于范围起点；增加纽约夏令时和跨年样例，断言起点是应用时区 89 天前零点。

- [ ] **Step 2: 写筛选栏失败测试**

创建 `src/__tests__/unit/stats-filter-bar.test.tsx`，mock `usePathname`、`useSearchParams`、`useRouter`、`apiClient.get('/api/notebooks')` 与语言上下文，验证：

```ts
// /stats?tab=exams，无 range
await renderWithCreateRoot(<StatsFilterBar defaultRange="90d" />);
const range90d = [...container.querySelectorAll('button')]
    .find((button) => button.textContent === '近 90 天');
expect(range90d?.getAttribute('aria-pressed')).toBe('true');

// 考试标签显式选择 30d，不能因全局旧默认而删除
await act(async () => range30d?.click());
expect(router.replace).toHaveBeenCalledWith('/stats?tab=exams&range=30d', { scroll: false });

// 普通标签仍以 30d 为默认
await renderWithCreateRoot(<StatsFilterBar />);
expect(range30d?.getAttribute('aria-pressed')).toBe('true');
```

测试沿用仓库现有 `react-dom/client`、`act` 和原生 DOM 查询，不新增 Testing Library 依赖。同时验证考试标签选回 `90d` 时删除 `range`，显式 `range=7d` 优先于默认值。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/__tests__/unit/stats-range.test.ts src/__tests__/unit/stats-filter-bar.test.tsx`

Expected: FAIL，原因包括 `90d` 不在枚举、`parseStatsRange` 无默认参数、筛选栏无 `defaultRange`。

- [ ] **Step 4: 实现共享范围接口**

在 `src/lib/stats/stats-range-core.ts` 和 `src/types/api.ts` 同步扩展 `StatsRange`。实现：

```ts
export function parseStatsRange(
    raw: string | null | undefined,
    defaultRange: StatsRange = '30d',
): StatsRange;
```

`raw` 缺失或非法时返回 `defaultRange`；`getRangeStart('90d')` 使用 `getDayRange(now, timeZone, -89).start`；`getStatsGranularity('90d')` 返回 `'month'`。`buildStatsBuckets` 沿用月桶算法，从范围起点所在月开始。

- [ ] **Step 5: 实现标签感知筛选栏**

为 `StatsFilterBar` 增加 Props：

```ts
interface StatsFilterBarProps {
    defaultRange?: StatsRange;
}
```

用 `parseStatsRange(searchParams.get('range'), defaultRange)` 解析；选择值等于 `defaultRange` 时删除 URL 的 `range`。在范围选项和中英文 `stats` 文案中增加 `range90d`。

- [ ] **Step 6: 运行 Task 1 测试与翻译一致性测试**

Run: `npx vitest run src/__tests__/unit/stats-range.test.ts src/__tests__/unit/stats-filter-bar.test.tsx src/__tests__/unit/translations.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交 Task 1**

```bash
git add src/lib/stats/stats-range-core.ts src/lib/stats/stats-range.ts src/types/api.ts src/components/stats/stats-filter-bar.tsx src/lib/i18n/zh.ts src/lib/i18n/en.ts src/__tests__/unit/stats-range.test.ts src/__tests__/unit/stats-filter-bar.test.tsx
git commit -m "feat: 扩展统计九十天范围"
```

---

### Task 2: 新增考试趋势领域聚合与 API

**Files:**
- Create: `src/lib/stats/exam-trends.ts`
- Create: `src/app/api/stats/exams/route.ts`
- Modify: `src/types/api.ts`
- Create: `src/__tests__/unit/exam-trends.test.ts`
- Create: `src/__tests__/integration/stats-exams.test.ts`

**Interfaces:**
- Consumes: Task 1 `StatsRange`、`parseStatsRange(raw, '90d')`、`getRangeStart`。
- Consumes: `resolveStatsSubjectId(userId, subjectIdParam)` 与 `getAppTimeZone()`。
- Produces: `ExamTrendPoint`、`ExamTrendSummary`、`ExamTrendStatsData`（字段与设计文档第 5.2 节完全一致）。
- Produces: `buildExamTrendStats(rows, options): ExamTrendStatsData` 纯聚合函数。
- Produces: `getExamTrendStats(input): Promise<ExamTrendStatsData>` 服务端查询函数。
- Produces: `GET /api/stats/exams?range=<StatsRange>&subjectId=<id>`。

- [ ] **Step 1: 写纯聚合失败测试**

在 `src/__tests__/unit/exam-trends.test.ts` 用固定行数据验证：

```ts
expect(result.points.map((point) => point.attemptId)).toEqual(['same-day-a', 'same-day-b', 'latest']);
expect(result.points.map((point) => point.rate)).toEqual([50, 80, 90]);
expect(result.points.map((point) => point.wrongCount)).toEqual([2, 1, 0]);
expect(result.summary).toEqual({
    examCount: 3,
    averageRate: 73.3,
    latestRate: 90,
    changeFromPrevious: 10,
    wrongCount: 3,
});
```

`same-day-a` 与 `same-day-b` 使用相同 `takenAt`，以不同 `createdAt` 和 `id` 固定稳定排序。另测空数组返回零计数与三个 `null` 比率字段，单次考试 `changeFromPrevious=null`，10 分卷与 100 分卷按算术平均而非加权平均。
增加跨 UTC 日期但同属北京时间日期的行，断言 `dateLabel` 使用应用时区的 `yyyy-MM-dd`。

- [ ] **Step 2: 写 API 集成失败测试**

创建 `src/__tests__/integration/stats-exams.test.ts`，沿用现有统计路由的 `next-auth`、`user.findUnique`、`subject.findFirst` mock 模式，覆盖：

- 无参数默认响应 `range='90d'`，查询起点为应用时区 89 天前零点；
- 查询 `where` 同时包含 `userId`、`status='confirmed'`、合法分数、时间范围；
- `select` 只含 attempt 摘要、`paper.id/title/subjectId`、`answers.result`，不含 `pages`、`imageData`、`recognitionResult`、答案文本；
- `uploaded/recognizing/review/failed` 与其他用户不可能被查询条件命中；
- 合法 `subjectId` 追加 `paper.subjectId` 条件并回传学科；其他用户学科 ID 按未筛选处理，但顶层 `userId` 不变；
- `range=all` 不添加 `takenAt.gte`；非法 range 回落 `90d`；
- `maxScore=0`、分数为空由查询条件排除，空响应不含 `NaN`；
- 未登录返回 `401`；
- 北京时间范围起点前后 1 毫秒的样例只包含边界内作答。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/__tests__/unit/exam-trends.test.ts src/__tests__/integration/stats-exams.test.ts`

Expected: FAIL，模块和路由不存在。

- [ ] **Step 4: 定义考试趋势 DTO**

在 `src/types/api.ts` 增加设计文档第 5.2 节的 `ExamTrendPoint`、`ExamTrendSummary`、`ExamTrendStatsData`。分数与比率使用 `number`；空摘要的比率使用 `null`，不使用可选字段。

- [ ] **Step 5: 实现纯聚合函数**

在 `src/lib/stats/exam-trends.ts` 首行添加 `import "server-only"`，定义最小查询行类型与：

```ts
export function buildExamTrendStats(
    rows: ExamTrendSourceRow[],
    options: {
        range: StatsRange;
        timeZone: string;
        subject?: { id: string; name: string } | null;
        subjectNames: ReadonlyMap<string, string>;
    },
): ExamTrendStatsData;

export async function getExamTrendStats(input: {
    userId: string;
    range: StatsRange;
    subjectIdParam: string | null;
    now?: Date;
}): Promise<ExamTrendStatsData>;
```

`buildExamTrendStats` 先按 `takenAt/createdAt/id` 升序排序，计算 1 位小数比率、`wrong | not_attempted` 次数、应用时区 `yyyy-MM-dd` 标签和摘要。不得修改入参数组。

- [ ] **Step 6: 实现受限 Prisma 查询**

`getExamTrendStats` 校验学科，计算 `getRangeStart`，调用一次 `prisma.examAttempt.findMany` 和一次必要的 `prisma.subject.findMany` 名称映射。学科名称查询也必须带 `userId`，不能用悬空或错误快照 ID读取其他用户学科。作答查询必须显式 `select`，排序为 `takenAt/createdAt/id` 升序，不读取图片或答案内容。

- [ ] **Step 7: 实现 API 路由**

`src/app/api/stats/exams/route.ts` 使用：

```ts
export const GET = withUser(async (
    req: Request,
    { user }: AuthenticatedContext,
) => NextResponse.json(await getExamTrendStats({
    userId: user.id,
    range: parseStatsRange(new URL(req.url).searchParams.get('range'), '90d'),
    subjectIdParam: new URL(req.url).searchParams.get('subjectId'),
}));
```

实际实现只构造一次 `URL`；异常由 `withUser` 统一处理，不在路由重复额度或会话逻辑。

- [ ] **Step 8: 运行 Task 2 测试**

Run: `npx vitest run src/__tests__/unit/exam-trends.test.ts src/__tests__/integration/stats-exams.test.ts`

Expected: PASS。

- [ ] **Step 9: 提交 Task 2**

```bash
git add src/lib/stats/exam-trends.ts src/app/api/stats/exams/route.ts src/types/api.ts src/__tests__/unit/exam-trends.test.ts src/__tests__/integration/stats-exams.test.ts
git commit -m "feat: 新增考试成绩趋势接口"
```

---

### Task 3: 实现考试趋势图表、摘要与逐次列表

**Files:**
- Create: `src/components/stats/exam-trends.tsx`
- Create: `src/components/stats/exam-trend-chart.tsx`
- Create: `src/components/stats/exam-trend-list.tsx`
- Modify: `src/components/stats/chart-colors.ts`
- Modify: `src/lib/i18n/zh.ts`
- Modify: `src/lib/i18n/en.ts`
- Create: `src/__tests__/unit/exam-trends-component.test.tsx`
- Create: `src/__tests__/unit/exam-trend-chart.test.tsx`

**Interfaces:**
- Consumes: Task 2 `ExamTrendStatsData`、`ExamTrendPoint`。
- Consumes: `useStatsData`、`StatsEmpty`、`StatsError`、`StatCard`、Recharts 和既有主题色。
- Produces: `ExamTrends({ url }: { url: string })`。
- Produces: `ExamTrendChart({ points }: { points: ExamTrendPoint[] })`。
- Produces: `ExamTrendList({ points }: { points: ExamTrendPoint[] })`。

- [ ] **Step 1: 写整体组件失败测试**

创建 `src/__tests__/unit/exam-trends-component.test.tsx`，mock `useStatsData`，验证：

- loading 显示加载状态；error 显示重试并调用 `reload`；
- 空 `points` 显示考试空状态和 `/exams` 链接；
- 三条数据时五张摘要卡分别显示 `3`、`73.3%`、`90%`、`+10.0 个百分点`、`3`；
- 单次考试变化显示 `—`，负变化显示负号；
- 逐次列表完整显示试卷标题、`17 / 50`、`34%`、错题数，并链接 `/exam-attempts/<id>`；
- 组件只使用 API DTO，不自行重算另一套摘要。

- [ ] **Step 2: 写图表交互失败测试**

创建 `src/__tests__/unit/exam-trend-chart.test.tsx`，mock Recharts 容器与路由，直接渲染自定义数据点/Tooltip，验证：

```ts
expect(dot.getAttribute('role')).toBe('link');
expect(dot.getAttribute('tabindex')).toBe('0');
dot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
expect(router.push).toHaveBeenCalledWith('/exam-attempts/attempt-1');
```

测试使用 `react-dom/client`、`act` 与原生 DOM 事件，不新增 Testing Library。另验证 Space 与点击导航、`aria-label` 含试卷名/日期/得分率；Tooltip 同时显示 `17 / 50`、`34%` 和错题数；mock `YAxis` 捕获并断言 domain 为 `[0, 100]`。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/__tests__/unit/exam-trends-component.test.tsx src/__tests__/unit/exam-trend-chart.test.tsx`

Expected: FAIL，组件不存在。

- [ ] **Step 4: 增加考试趋势文案与主题色**

在中英文 `stats` 下增加完全一致的 `examTrends` 对象，至少覆盖：标签标题、区块说明、五个摘要标题、变化单位、图表标题、得分率、得分、错题数、逐次详情、空状态标题/说明、前往试卷、详情链接 aria 文案。英文不得含中文字符。

在 `chart-colors.ts` 增加考试趋势主线颜色常量，引用现有 CSS 主题变量，不写十六进制颜色。

- [ ] **Step 5: 实现拆分组件**

`ExamTrends` 负责请求和状态，摘要使用 `StatCard`；`ExamTrendChart` 负责折线、0–100 纵轴、Tooltip 与可键盘操作的数据点；`ExamTrendList` 使用普通 Next.js `<Link>` 渲染同一 `points`。任何单文件接近 200 行时继续拆出 Tooltip 或摘要组件。

- [ ] **Step 6: 运行 Task 3 测试与翻译测试**

Run: `npx vitest run src/__tests__/unit/exam-trends-component.test.tsx src/__tests__/unit/exam-trend-chart.test.tsx src/__tests__/unit/translations.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交 Task 3**

```bash
git add src/components/stats/exam-trends.tsx src/components/stats/exam-trend-chart.tsx src/components/stats/exam-trend-list.tsx src/components/stats/chart-colors.ts src/lib/i18n/zh.ts src/lib/i18n/en.ts src/__tests__/unit/exam-trends-component.test.tsx src/__tests__/unit/exam-trend-chart.test.tsx
git commit -m "feat: 新增考试成绩趋势组件"
```

---

### Task 4: 接入统计中心并补齐桌面/移动端 E2E

**Files:**
- Modify: `src/app/stats/page.tsx`
- Create: `src/__tests__/unit/stats-exam-tab.test.tsx`
- Modify: `e2e/exam-attempt.spec.ts`
- Modify: `doc/E2E_MOCK_AI_TEST_DESIGN.md`

**Interfaces:**
- Consumes: Task 1 `StatsFilterBar({ defaultRange })` 与 `parseStatsRange(raw, defaultRange)`。
- Consumes: Task 3 `ExamTrends({ url })`。
- Produces: `/stats?tab=exams` 第四标签页，默认请求 `/api/stats/exams`（即 90 天）。

- [ ] **Step 1: 写统计页接线失败测试**

创建 `src/__tests__/unit/stats-exam-tab.test.tsx`，mock Next navigation、语言上下文和重型统计子组件，验证：

- 页面有四个 tab，考试 tab 的值为 `exams`；
- `/stats?tab=exams` 选中考试 tab，筛选栏收到 `defaultRange="90d"`，`ExamTrends` URL 为 `/api/stats/exams`；
- `/stats?tab=exams&range=30d&subject=math` 生成 `/api/stats/exams?range=30d&subjectId=math`；
- `/stats?tab=practice` 的筛选栏仍收到 `defaultRange="30d"`；
- 旧 `tag-stats` 映射保持不变；
- 移动标签容器使用两列布局，不把四项挤在一行。

测试使用 `react-dom/client` 与原生 DOM 查询，不新增 Testing Library。

- [ ] **Step 2: 运行接线测试确认失败**

Run: `npx vitest run src/__tests__/unit/stats-exam-tab.test.tsx`

Expected: FAIL，考试标签不存在。

- [ ] **Step 3: 接入第四标签页**

在 `src/app/stats/page.tsx`：

- `STATS_TABS` 增加 `exams`；
- 使用 `defaultRange = tab === 'exams' ? '90d' : '30d'`；
- `parseStatsRange(searchParams.get('range'), defaultRange)` 同时驱动筛选栏和 URL；
- `buildUrl` 仅在 `range !== defaultRange` 时发送 `range`，因此考试默认请求不带参数，普通标签的 30 天默认也保持原样；
- 标签列表移动端改为 `grid-cols-2`，桌面保持 `sm:inline-flex`；
- 考试标签渲染 `ExamTrends`，URL 仍把页面的 `subject` 转为接口的 `subjectId`。

- [ ] **Step 4: 在现有纸质回传 E2E 中加入趋势验收**

在 `e2e/exam-attempt.spec.ts` 的桌面和手机循环中，第一次确认后、创建第二次同日作答前：

```ts
await page.goto('/stats?tab=exams');
await expect(page.getByRole('tab', { name: '考试趋势' })).toHaveAttribute('aria-selected', 'true');
await expect(page.getByText('合成纸质作答验收卷', { exact: true })).toBeVisible();
await expect(page.getByText('17 / 50', { exact: true })).toBeVisible();
await expect(page.getByText('34%', { exact: true })).toBeVisible();
```

通过逐次列表链接进入 `/exam-attempts/<id>` 并验证“成绩已确认”。创建第二次同日 50/50 作答后再打开考试趋势，断言考试次数 2、平均得分率 67%、最近一次 100%、变化 `+66.0` 个百分点、两条逐次记录均存在。手机视口额外断言四个 tab 为两列布局且列表链接可见。
进入详情完成断言后使用 `page.goBack()` 或显式导航返回，避免后续夹具步骤依赖浏览器历史的偶然状态。

- [ ] **Step 5: 更新 E2E 设计矩阵**

在 `doc/E2E_MOCK_AI_TEST_DESIGN.md` 的纸质回传场景中补充“确认后进入考试趋势、同日两次独立展示、点击回到作答详情”的桌面/手机验收，不新增外网请求。

- [ ] **Step 6: 运行 Task 4 单元与定向 E2E**

Run: `npx vitest run src/__tests__/unit/stats-exam-tab.test.tsx`

Expected: PASS。

Run: `npm run test:e2e -- --grep E2E-PAPER-RETURN`

Expected: 桌面和手机 2 个场景 PASS。

- [ ] **Step 7: 提交 Task 4**

```bash
git add src/app/stats/page.tsx src/__tests__/unit/stats-exam-tab.test.tsx e2e/exam-attempt.spec.ts doc/E2E_MOCK_AI_TEST_DESIGN.md
git commit -m "feat: 接入考试成绩趋势页面"
```

---

### Task 5: 同步用户文档并完成整批验证

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `doc/wiki/User-Guide.md`
- Modify: `doc/wiki/en/User-Guide.md`
- External repository when available: `../wrong-notebook-github-pages/index.html`
- External repository when available: `../wrong-notebook-github-pages/en/index.html`

**Interfaces:**
- Consumes: Tasks 1–4 已完成的用户可见行为。
- Produces: 中英文安装入口文档、Wiki 与官网说明一致。

- [ ] **Step 1: 更新仓库中英文文档**

在 README 和 Wiki 的考试/统计说明中写清：

- 纸质成绩确认后才进入趋势；草稿和失败作答不可见；
- 入口为“统计中心 → 考试趋势”；
- 默认 90 天，可按学科和时间筛选；
- 主线为得分率，原始得分/满分和错题数在 Tooltip/逐次列表展示；
- 点击一次考试进入既有作答详情。

中文与英文内容语义一致。

- [ ] **Step 2: 同步官网项目或记录明确阻塞**

检查 `../wrong-notebook-github-pages`。若存在，分别更新 `index.html`、`en/index.html` 的成绩趋势功能说明，在该项目独立提交 `docs: 同步考试成绩趋势说明`。若目录不存在，不虚构文件；在交付报告中明确列为外部仓库缺失阻塞，并在任务 06 发布前补齐。

- [ ] **Step 3: 运行静态与单元/集成验证**

Run: `npm run lint`

Expected: 0 errors，0 warnings。

Run: `npx tsc --noEmit`

Expected: exit 0。

Run: `npm run test:unit && npm run test:integration`

Expected: 全部 PASS。

- [ ] **Step 4: 运行完整 Vitest 与 Playwright**

Run: `TELEMETRY_DISABLED=false RUST_LOG=info npm test`

Expected: 全部 PASS，0 failures。

Run: `npm run test:e2e`

Expected: 全部 Playwright 场景 PASS。

- [ ] **Step 5: 检查公开历史与仓库卫生**

Run: `git diff --check`

Expected: 无输出。

Run: `rg -n "npmmirror" package-lock.json`

Expected: 无输出。

Run: `python3 scripts/check-public-history.py HEAD`

Expected: 公开历史检查通过。

Run: `git status --short`

Expected: 只显示本任务计划内的文档改动（提交前）或为空（提交后），不包含临时日志、截图和测试数据库。

- [ ] **Step 6: 提交 Task 5**

```bash
git add README.md README.en.md doc/wiki/User-Guide.md doc/wiki/en/User-Guide.md
git commit -m "docs: 补充考试成绩趋势说明"
```

- [ ] **Step 7: 最终复核任务范围**

逐条对照设计第 9.4 节，确认 API、摘要、Tooltip、逐次列表和 E2E 的数值来自同一 DTO；确认 `git diff main...HEAD -- prisma src/lib/backup src/app/api/export src/app/api/import` 没有数据库或备份格式改动。

再次运行 `python3 scripts/check-public-history.py HEAD`，确保 Task 5 文档提交也进入公开历史检查；最终 `git status --short --branch` 只显示当前分支且工作树干净。
