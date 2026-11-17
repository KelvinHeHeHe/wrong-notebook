# 家庭小学生 AI 智能错题系统项目审计

> 首次审计：2026-11-08
> 实施状态更新：2026-11-18
> 上游仓库：`https://github.com/margrop/wrong-notebook.git`
> 首次审计提交：`4d8e88bf68f642a3526648d1901e25b0f0c63009`
> 许可证：MIT License（Copyright 2025 wttwins；Copyright 2026 margrop）

## 1. 审计边界与结论

首次审计只检查源码、数据库模型、自动化测试和本地运行环境，不以 README 声明代替实现验证，也未修改业务代码或执行破坏性迁移。随后任务 02～07 按已批准方案完成增量开发；本文现以当前仓库实现为准，同时保留首次审计时的环境记录。

结论：

1. 原项目的错题管理、图片识题、多题分割、AI 变式题、掌握度、组卷、打印、统计和备份均可复用。
2. 外部整卷现已复用 `ExamPaper` / `ExamQuestion` 建档，并保存页图、外部题号、区域和考试元数据，没有建立第二套试卷体系。
3. 打印卷现已支持照片回传、两阶段识别、逐题人工复核、幂等确认、错题/练习入账和成绩趋势。
4. 当前备份版本为 v14，包含试卷打印短码、考试元数据、试卷页、作答页、页级识别候选、逐题评分和练习关联，并兼容导入 v11～v13。
5. 现有多模态 Provider 足以承担 MVP 的视觉识别，不需要单独增加 Python OCR 服务。真实家庭样本上的 95% 目标仍须发布前人工验收，自动化合成夹具不能代替该指标。

## 2. 仓库与技术栈

| 项目 | 审计结果 |
| --- | --- |
| 应用框架 | Next.js 16 App Router、React 19、TypeScript |
| UI | Tailwind CSS 4、Radix UI / shadcn 风格组件、Recharts |
| 数据 | Prisma 5 + SQLite，默认 `file:./dev.db` |
| 认证 | NextAuth v4，用户名/密码，数据按用户隔离 |
| AI | `BaseAIProvider` 统一业务能力；Gemini、OpenAI/compatible、Azure、Anthropic 等 Provider |
| 文件导入 | JSON、CSV、XLSX、DOCX、PDF、照片；扫描 PDF 转图片后处理 |
| 打印 | 浏览器打印/保存 PDF，可下载独立 HTML |
| 测试 | Vitest、Playwright、Python unittest |
| 部署 | 源码、npm、Docker、Electron、Android、飞牛 OS 等 |

`package.json` 声明 MIT，仓库 `LICENSE` 为完整 MIT 文本，允许使用、修改、合并、发布和再授权，但必须保留版权与许可声明。第三方 HEIC 解码组件的单独许可说明也必须随发布保留。

## 3. 已审阅范围

- `README.md`、`package.json`、`LICENSE`、环境示例和维护文档。
- `prisma/schema.prisma`、正式迁移、种子和真实 SQLite 迁移测试。
- `src/app/api/`，重点包括导入、试卷、作答、统计和备份路由。
- `src/lib/ai/` 的 Provider、提示词、解析、错误分类、额度和用户配置。
- `src/lib/import/`、`src/lib/question-split/`、`src/lib/exam/`、PDF 与图像处理。
- `src/__tests__/unit`、`src/__tests__/integration`、`e2e/`、`tests/publication/`。

## 4. 功能复用矩阵

| 能力 | 当前代码证据 | 当前状态 | 处理结论 |
| --- | --- | --- | --- |
| 单题/多题照片识别 | `ImportTask`、`ImportBatch`、`splitQuestions`、图片导入 E2E | 已实现 | 直接复用 |
| 扫描 PDF | PDF 渲染与 `e2e/file-import-pdf.spec.ts` | 已实现 | 复用渲染、页数限制与异常处理 |
| 外部整卷导入 | `/api/exams/import`、页/识别路由、`e2e/exam-import.spec.ts` | 已实现 | 复用现有试卷、打印和题目编辑 |
| 错题建档 | `ErrorItem`、短 ID、标签、图片和解析字段 | 已实现 | 只在确认错误/未作答时创建或复用 |
| AI 变式题 | `generateSimilarQuestion`、练习与试卷测试 | 已实现 | 直接复用 |
| AI/本地判题 | `gradeAnswer`、练习判题、作答识别与评分 | 已实现 | AI 结果先进入复核草稿 |
| 掌握度 | AI 评估 + 规则兜底，基于 `PracticeRecord` | 已实现 | 确认入账后复用 |
| 组卷与打印 | `ExamPaper`、原题/变式题、A/B 卷、打印页 | 已实现 | 外部整卷共用同一体系 |
| 纸质作答回传 | `ExamAttempt*`、回传页面与识别/复核/确认 API | 已实现 | 未确认不改变学习历史 |
| 打印二维码回传 | `ExamPaper.printCode`、打印身份块、扫码页与所有权 API | 已实现 | 试卷级身份，登录保护，旧版内容警告 |
| 成绩趋势 | `/api/stats/exams`、`src/lib/stats/exam-trends.ts` | 已实现 | 仅统计已确认作答 |
| 本地备份恢复 | v14 格式、导入导出路由、真实 SQLite 往返测试 | 已实现 | 兼容 v11～v13 |

## 5. 任务 02～05 与 07 实施结果

### 任务 02：数据模型与备份

- 计划：[任务 02 实施计划](superpowers/plans/2026-11-08-task-02-data-model-backup-v12.md)。
- 正式迁移以安全默认值、可空列、新表和索引为主，旧生成试卷默认 `origin='generated'`。
- 备份当前为 v14；v12 引入考试集合，v13 增加作答页 `recognitionResult`，v14 增加试卷打印短码，v11～v13 均可导入。

### 任务 03：考试管理与整卷导入

- 设计与计划：[整卷导入设计](superpowers/specs/2026-11-08-exam-paper-import-design.md)、[实施计划](superpowers/plans/2026-11-08-task-03-exam-paper-import.md)。
- 支持照片/PDF 建立外部试卷草稿、单页失败重试、人工校对发布、现有详情和打印流程。
- 发布前不创建错题或练习记录；Task 06 的桥接测试验证发布后的真实试卷可进入纸质回传页。

### 任务 04：纸质回传与确认

- 设计与计划：[纸质回传设计](superpowers/specs/2026-11-08-task-04-paper-return-design.md)、[实施计划](superpowers/plans/2026-11-08-task-04-paper-return.md)。
- 支持多页上传、页级识别候选、题目映射、AI 评分草稿、人工复核和事务确认。
- 确认接口幂等；确认后才创建/复用错题、写入 `PracticeRecord(source='exam')` 并触发掌握度更新。

### 任务 05：成绩趋势

- 设计与计划：[成绩趋势设计](superpowers/specs/2026-11-10-task-05-exam-trends-design.md)、[实施计划](superpowers/plans/2026-11-10-task-05-exam-trends.md)。
- 支持学科、时间范围、摘要、得分率折线和作答详情跳转；只聚合当前用户已确认作答。

### 任务 07：纸质试卷二维码与稳定短码

- 设计与计划：[二维码设计](superpowers/specs/2026-11-17-task-07-paper-qr-design.md)、[实施计划](superpowers/plans/2026-11-17-task-07-paper-qr.md)。
- 打印稿和下载 HTML 携带试卷级二维码、稳定短码和内容版次；手机扫码登录后进入既有回传流程。
- 解析 API 只查当前用户；内容变化先显示旧版纸张警告。手机访问地址只保存在浏览器，不进入数据库或备份。
- 不引入页级二维码、Python OCR、外部短链服务或第二套认证。

## 6. AI Provider 与 OCR 评估

`BaseAIProvider` 已统一处理图片理解、分题、识题、判分和结构化解析，各 Provider 主要负责传输差异。对小学数学公式、语文材料题和英语版面，现有视觉模型能一次返回题干、区域、答案和置信度，MVP 再增加传统 OCR 与版面服务会引入额外运行时、进程管理和融合成本。

因此当前不增加 Python OCR。只有真实样本证明以下任一问题成立时才重新评估：

- 清晰打印卷的题号/区域匹配率仍低于目标，且提示词、分页和人工复核不能改善；
- 必须严格离线，不能把图片交给配置的视觉 Provider；
- 使用量使模型成本或延迟不可接受；
- 需要固定答题卡 OMR、精确表格或几何级版面校正。

后续即使增加，也应作为可选预处理适配器，不取代 Next.js + Prisma 主服务。

## 7. 本地环境与验证记录

首次审计在 Apple Silicon Mac 上完成依赖安装、Prisma Client 生成、隔离新库迁移、种子、开发服务和健康检查。受管执行环境曾出现两类环境异常：npm 安装后的联网审计等待，以及 Prisma Schema Engine 不带 Rust 日志时的空错误；使用官方 registry、关闭安装审计并显式设置 `RUST_LOG=info` 后稳定通过。沙箱禁止本地监听时，依赖本地模拟模型的测试还会报 `listen EPERM`，需在允许临时本地端口的环境运行。

2026-11-18 任务 07 的新鲜验证证据（数量仅代表本次运行，不是永久阈值）：

| 验证 | 结果 |
| --- | --- |
| `npm run lint` | 通过，0 警告 |
| `RUST_LOG=info TELEMETRY_DISABLED=false npm test` | 314 个文件、4143 个用例通过 |
| `npm run test:e2e` | 97/97 Chromium 用例通过 |
| 近端旧库迁移特征测试 | 6/6 通过 |
| 备份真实 SQLite 集成测试 | 56/56 通过 |

最终本地 CI、环境信息和报告路径以 [MVP 验收报告](MVP_ACCEPTANCE.md) 为准。

## 8. 风险与后续观察

| 风险 | 影响 | 当前措施 |
| --- | --- | --- |
| 自动评分误判 | 错误影响复习与掌握度 | 先保存草稿，人工确认后才入账 |
| 手写长答识别波动 | 自动化率不稳定 | 低置信度/主观题进入复核；发布前补真实样本验收 |
| 页图存 SQLite/JSON | 数据库与备份可能膨胀 | 限页、压缩；超限后再做文件存储适配器 |
| 掌握度队列在进程内 | 重启可能漏一次自动重评 | 练习记录先持久化，后续增加可恢复任务 |
| Provider 视觉能力差异 | 不同模型结果不一致 | 使用图片能力测试、备用渠道和明确错误 |
| 外部官网仓库不在当前工作区 | 无法同步发布页 | 列为正式发布前外部待办 |

## 9. 审计决策

- 保留 Next.js + TypeScript + Prisma + SQLite + 现有 AI Provider 架构。
- 不重写错题导入、变式题、掌握度、组卷、打印、统计和备份。
- 外部整卷继续作为 `ExamPaper` 的来源，纸质回传以 `ExamAttempt` 表示一次作答。
- 所有评分先复核，确认后才写学习历史。
- MVP 不增加 Python OCR 服务，不把任务 06 写成实际发布。
