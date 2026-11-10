# 任务 05：成绩趋势设计

> 日期：2026-11-10
>
> 前置：任务 02 数据模型与备份、任务 03 整卷导入、任务 04 纸质作答回传已完成
>
> 状态：待确认

## 1. 意图

家庭用户需要在确认纸质试卷成绩后，按学科和时间查看孩子的考试变化，并能从趋势点回到该次作答详情。任务 05 在现有统计中心增加“考试趋势”标签页，复用既有筛选、图表、加载/失败/空状态和作答详情，不建立第二套统计页面。

本任务只读取已经确认的 `ExamAttempt`。上传、识别或复核中的草稿不能提前进入趋势，也不能从 `PracticeRecord` 反推考试成绩。

## 2. 目标与非目标

### 2.1 目标

- 在 `/stats` 增加第四个“考试趋势”标签页。
- 默认展示最近 90 天；其他现有统计标签仍默认最近 30 天。
- 支持 `7d`、`30d`、`90d`、`6m`、`all` 时间范围和现有学科筛选。
- 折线按每次考试展示得分率；不同满分的试卷可直接比较。
- 同时展示原始得分、满分、错题数、考试标题和日期。
- 展示考试次数、平均得分率、最近一次得分率、较上一次变化和累计错题数。
- 点击图表数据点或逐次列表可进入现有 `/exam-attempts/:id` 详情页。
- 使用应用配置时区处理范围边界和日期显示。

### 2.2 非目标

- 不新增 Prisma 模型、字段、索引或迁移；现有 `ExamAttempt(userId, takenAt)` 已覆盖查询。
- 不修改确认成绩、判分、错题创建或掌握度计算。
- 不统计未确认、识别失败或仍在复核中的作答。
- 不做年级、学期、考试类型筛选，不生成家长周报。
- 不做按日/月平均后的聚合折线；每次真实作答保留为独立数据点。
- 不引入 Python、OCR 服务或新的图表依赖。

## 3. 方案比较与选择

### 方案 A：统计中心第四标签页（采用）

复用 `/stats`、`StatsFilterBar`、Recharts、统计状态组件和 URL 查询参数。考试标签无显式 `range` 时默认 `90d`，其他标签保持 `30d`。

优点：入口集中、复用最多、不会把考试和日常练习混在同一页面；现有统计默认行为不变。代价：筛选栏需要支持按标签页传入默认范围。

### 方案 B：并入“练习统计”标签页（不采用）

实现最少，但考试趋势和日常练习趋势语义不同，页面较长，空状态也会互相干扰。

### 方案 C：新增 `/stats/exams` 独立页面（不采用）

页面边界清楚，但会重复统计导航、筛选栏和 URL 状态，不符合最小扩展原则。

## 4. 数据来源与口径

### 4.1 查询来源

只查询：

```text
ExamAttempt.userId = 当前用户
ExamAttempt.status = confirmed
ExamAttempt.takenAt >= 所选范围起点（all 除外）
ExamAttempt.paper.subjectId = 已验证的学科 ID（选择学科时）
ExamAttempt.totalScore != null
ExamAttempt.maxScore > 0
```

查询只选择趋势所需列和逐题 `result`，不得读取 `ExamAttemptPage.imageData`、识别信封或题目图片。

`subjectId` 延续现有统计接口语义：先用 `resolveStatsSubjectId` 校验是否属于当前用户；不存在或属于其他用户时按“全部学科”处理，同时始终保留顶层 `userId` 隔离。

### 4.2 得分率

单次得分率：

```text
rate = totalScore / maxScore * 100
```

展示值统一四舍五入到 1 位小数。平均得分率是“每次考试得分率的算术平均”，不是总得分除以总满分；这样 10 分卷与 100 分卷权重相同，符合跨满分比较目标。

### 4.3 错题数

单次错题数统计该作答下 `ExamAttemptAnswer.result` 为 `wrong` 或 `not_attempted` 的记录。累计错题数为所选范围内各次错题数之和。它表示考试中的错误作答次数，不去重题目，也不依赖是否已创建 `ErrorItem`。

### 4.4 排序与变化值

- 序列按 `takenAt` 升序；时间相同则按 `createdAt`、`id` 升序，保证稳定。
- “最近一次”取序列最后一项。
- “较上一次变化”是最近两次得分率的百分点差，四舍五入到 1 位；只有一次考试时为 `null`。
- 同一天的多次作答各自保留，不合并、不覆盖。

### 4.5 时区与范围

- 扩展 `StatsRange` 为 `7d | 30d | 90d | 6m | all`。
- `getRangeStart('90d')` 返回应用时区下 89 天前的零点。
- 既有错题/练习统计在显式选择 `90d` 时按月分桶，避免移动端出现 90 根柱；首尾月允许是不完整月份。考试趋势不使用公共分桶，仍逐次展示真实作答。
- `parseStatsRange` 接受可选默认值，默认仍为 `30d`，避免改变现有 API。
- `/api/stats/exams` 和考试标签页传入默认值 `90d`。
- 其他统计 API 和标签页不传默认值，继续使用 `30d`。
- 每个趋势点由服务端使用应用时区产生 `dateLabel`，客户端不以浏览器时区重新分桶。

## 5. API 设计

### 5.1 路由

```http
GET /api/stats/exams?range=90d&subjectId=<id>
```

路由使用 `withUser`，通过 `getExamTrendStats` 读取并汇总数据。异常交给统一 API 处理器；日志不得包含页面图片或答案原文。

### 5.2 响应

```ts
interface ExamTrendPoint {
    attemptId: string;
    paperId: string;
    paperTitle: string;
    subjectId: string | null;
    subjectName: string | null;
    takenAt: string;
    dateLabel: string;
    totalScore: number;
    maxScore: number;
    rate: number;
    wrongCount: number;
}

interface ExamTrendSummary {
    examCount: number;
    averageRate: number | null;
    latestRate: number | null;
    changeFromPrevious: number | null;
    wrongCount: number;
}

interface ExamTrendStatsData {
    range: StatsRange;
    subjectId?: string;
    subjectName?: string;
    summary: ExamTrendSummary;
    points: ExamTrendPoint[];
}
```

空结果返回 `200`、零计数和空数组；比率字段为 `null`，不使用 `NaN` 或虚构的 `0%`。

## 6. 服务端结构

新增 `src/lib/stats/exam-trends.ts`，首行 `import "server-only"`，职责为：

- 解析已验证学科与范围起点；
- 只读查询当前用户已确认作答；
- 计算稳定序列、单次得分率、错题数和摘要；
- 返回不含图片与答案文本的 DTO。

新增 `src/app/api/stats/exams/route.ts`，只负责鉴权、读取查询参数并返回领域函数结果。路由不直接实现统计算法。

不修改备份格式：任务 05 不新增持久化数据，所有趋势均从备份 v13 已覆盖的考试与作答数据实时计算。

## 7. 页面与交互

### 7.1 统计中心入口

- `STATS_TABS` 增加 `exams`。
- 移动端标签改为两列两行，桌面端继续使用紧凑横排。
- 考试标签图标使用现有 Lucide 图标，不新增图标包。
- URL 使用 `?tab=exams`，筛选继续使用 `range` 和 `subject`。

### 7.2 标签感知的默认范围

`StatsFilterBar` 新增 `defaultRange?: StatsRange`：

- 考试标签传 `90d`；其他标签传 `30d`。
- 当前选择等于标签默认值时从 URL 删除 `range`。
- 显式选择的范围保留在 URL；切换标签时若 URL 没有 `range`，各标签恢复自己的默认值。

筛选栏增加“近 90 天”选项。该选项也可用于其他统计标签，但不会改变它们的默认值。

### 7.3 趋势内容

`ExamTrends` 复用 `useStatsData`、`StatsError`、`StatsEmpty` 和 `StatCard`：

- 空状态说明“确认一次考试成绩后显示趋势”，操作按钮进入 `/exams`。
- 摘要卡在移动端两列、桌面端五列，展示考试次数、平均得分率、最近一次、变化和错题数。
- 折线图的纵轴固定为 `0–100%`，主线为得分率。
- Tooltip 展示标题、日期、得分/满分、得分率和错题数。
- 数据点支持鼠标点击、键盘 Enter/Space，并带可读的 `aria-label`，导航到 `/exam-attempts/:attemptId`。
- 图表下方提供同一数据源的逐次列表，每行是普通 `<Link>`；既适配小屏，也为键盘和读屏提供稳定入口。
- 单次考试仍显示摘要、一个数据点和一条详情，不虚构变化值。

组件按职责拆分，避免单文件超过约 200 行：

- `src/components/stats/exam-trends.tsx`：请求、状态与整体布局；
- `src/components/stats/exam-trend-chart.tsx`：折线和 Tooltip；
- `src/components/stats/exam-trend-list.tsx`：逐次详情链接列表。

## 8. 国际化与文档

- 在 `src/lib/i18n/zh.ts`、`en.ts` 增加相同 key 的考试趋势、90 天范围、摘要、空状态和图表文案。
- 在 `README.md`、`README.en.md` 的考试功能说明中补充确认后成绩趋势。
- 更新 `doc/wiki/User-Guide.md` 和 `doc/wiki/en/User-Guide.md`，说明入口、统计口径和只有已确认成绩会显示。
- 不更新官网项目：本任务工作区未包含官网仓库；发布 MVP 时由任务 06 统一同步对外展示。

## 9. 测试与验收

### 9.1 单元测试

- `stats-range`：`90d` 的解析、89 天前零点、按月粒度、跨月/跨年/夏令时边界；原默认仍为 `30d`。
- 纯汇总：不同满分算术平均、单次变化为空、同日多次稳定排序、错误/未作答计数、1 位小数舍入。
- 筛选栏：考试默认 90 天、其他标签默认 30 天、显式范围的 URL 行为。
- 组件：加载、失败重试、空状态、单次考试、多科目、摘要值、Tooltip/列表值一致、详情链接。

### 9.2 集成测试

- 未认证返回 `401`。
- 只返回当前用户 `confirmed` 作答。
- 排除 `uploaded`、`recognizing`、`review`、`failed` 和其他用户数据。
- 合法学科只筛该学科；其他用户学科 ID 按未筛选处理且不泄露数据。
- `7d/30d/90d/6m/all` 范围正确，应用时区边界前后的作答不串日。
- 10 分卷与 100 分卷按得分率正确比较，摘要和逐次详情一致。
- 查询选择中不包含页面图片和识别结果。

### 9.3 E2E

- 用 mock AI 流程生成一条已确认作答，打开统计中心考试标签，验证摘要和趋势出现。
- 点击逐次详情进入现有作答复核详情页。
- 保留空状态覆盖；不在 E2E 重复穷举 API 的状态和边界矩阵。

### 9.4 完成标准

- 只统计当前用户且状态为 `confirmed` 的作答。
- 默认最近 90 天，其他统计默认仍为 30 天。
- 得分率使用 `totalScore / maxScore`，不同满分可正确比较。
- 图表、摘要、Tooltip 和逐次列表数值一致。
- 应用时区范围边界正确；同日多次考试不丢失。
- 数据点和列表均可进入既有作答详情页。
- lint、TypeScript、Vitest、相关 Playwright 测试全部通过。

## 10. 风险与控制

- **旧数据异常：** 查询要求非空分数且 `maxScore > 0`，避免除零；确认流程继续负责写入合法总分。
- **默认范围回归：** 默认值作为参数传递，不把全局默认从 30 天改为 90 天。
- **图表可访问性：** 数据点键盘操作与普通链接列表同时存在，不把 SVG 点击作为唯一入口。
- **大历史性能：** 只选摘要列和答案结果，不读取图片；现有 `(userId, takenAt)` 索引负责范围查询。
- **学科悬空 ID：** 学科名称映射失败时返回 `null`，仍可用试卷标题展示，不跨用户查找名称。
