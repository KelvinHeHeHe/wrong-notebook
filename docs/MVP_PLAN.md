# 家庭小学生 AI 智能错题系统 MVP 实施计划

> 状态：任务 02～06与本地 Next.js 安全升级已完成；正式发布待远端 CI 和外部验收。
> 目标：以最小增量打通“外部整卷建档 → 打印作答 → 拍照回传 → 人工复核 → 确认入账 → 成绩趋势 → 备份恢复”。
> 架构：保留 Next.js + TypeScript + Prisma + SQLite 和现有 AI Provider；扩展 `ExamPaper`，以 `ExamAttempt` 记录真实作答。

## 1. MVP 范围与完成状态

| 能力 | 状态 | 当前实现 |
| --- | --- | --- |
| 考试管理 | 已完成 | 试卷名称、学科快照、年级学期、类型、日期、总分 |
| 整卷导入 | 已完成 | 照片/PDF、页图、分题识别、单页重试、人工校对发布 |
| 纸质回传 | 已完成 | 多页上传、两阶段识别、题目映射、逐题评分草稿 |
| 确认入账 | 已完成 | 事务与幂等确认、错题/练习记录、掌握度触发 |
| 成绩趋势 | 已完成 | 学科/时间筛选、摘要、得分率、详情跳转 |
| 本地备份 | 已完成 | 当前 v13，兼容导入 v11/v12 |
| 发布前收口 | 本地门禁已完成 | 分段证据矩阵、维护者文档及 Next.js 16.4.3 → 16.4.6 安全升级复测已完成；正式发布待远端 CI 与外部验收 |

MVP 不包含学校/班级、多孩子共享账号、教师批改、排名、固定答题卡 OMR、对象存储、消息队列或独立 Python OCR 服务。

## 2. 已实现流程

### 2.1 外部整卷导入

1. 用户上传 PDF 或有序照片。
2. 客户端复用现有 PDF 渲染、图片校验和压缩；服务端复用视觉模型分题。
3. `ExamPaperPage` 保存页图与校验和，`ExamQuestion` 保存题号、页码、区域和置信度。
4. 单页失败可重试，用户校对元数据和题目后发布为 `ready`。
5. 发布后的外部卷复用现有详情、打印和答案页；发布前不产生错题记录。

### 2.2 纸质作答回传

1. 用户从试卷详情创建 `ExamAttempt`，上传已作答页。
2. 第一阶段保存页级识别候选，第二阶段按试卷题目匹配并形成 `ExamAttemptAnswer` 草稿。
3. 用户逐题核对识别答案、结果、得分、理由和置信度。
4. 确认接口在事务中校验归属、总分和状态，并保证重复提交不重复入账。
5. 错误/未作答题创建或复用 `ErrorItem`，再写 `PracticeRecord(source='exam')`；正确题保留评分记录。

### 2.3 成绩趋势与恢复

- `/api/stats/exams` 只统计当前用户、状态为 `confirmed` 的作答。
- 得分率以 `totalScore / maxScore` 计算，支持不同满分试卷比较。
- 备份 v13 保存试卷页、作答页、识别候选、逐题评分和练习关联；v11/v12 导入后可按 v13 再导出。

## 3. 已实现 API 清单

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/exams/import` | 创建外部整卷草稿 |
| `POST /api/exams/:id/pages` | 保存或替换试卷页 |
| `POST /api/exams/:id/recognize` | 分页识别整卷草稿 |
| `GET/PATCH /api/exams/:id` | 读取、校对并发布试卷 |
| `GET/POST /api/exams/:id/attempts` | 查询历史或新建纸质作答 |
| `GET /api/exam-attempts/:id` | 获取作答、页和逐题草稿 |
| `POST /api/exam-attempts/:id/pages` | 上传回传页 |
| `POST /api/exam-attempts/:id/recognize` | 识别并生成评分草稿 |
| `PATCH /api/exam-attempts/:id/answers/:answerId` | 人工复核一题 |
| `POST /api/exam-attempts/:id/confirm` | 幂等确认并入账 |
| `GET /api/stats/exams` | 查询考试成绩趋势 |

所有路由沿用现有鉴权、`userId` 隔离、zod 校验、统一错误和本地图片限制。

## 4. 开发任务状态

### 任务 02：数据模型与备份（已完成）

- [实施计划](superpowers/plans/2026-11-08-task-02-data-model-backup-v12.md)
- 完成考试模型增量迁移和备份集合；后续纸质识别候选使当前格式升至 v13。
- 旧生成试卷安全默认，v11/v12 保持兼容导入。

### 任务 03：考试管理与整卷导入（已完成）

- [设计](superpowers/specs/2026-11-08-exam-paper-import-design.md) / [实施计划](superpowers/plans/2026-11-08-task-03-exam-paper-import.md)
- 照片和 PDF 可形成一份可校对试卷；单页失败不丢其他页，发布后复用打印。

### 任务 04：纸质练习回传与确认（已完成）

- [设计](superpowers/specs/2026-11-08-task-04-paper-return-design.md) / [实施计划](superpowers/plans/2026-11-08-task-04-paper-return.md)
- 回传照片只产生草稿；人工确认后才写错题、练习记录和掌握度输入。

### 任务 05：成绩趋势（已完成）

- [设计](superpowers/specs/2026-11-10-task-05-exam-trends-design.md) / [实施计划](superpowers/plans/2026-11-10-task-05-exam-trends.md)
- 已完成聚合 API、图表、时区/边界、空状态和可访问性覆盖。

### 任务 06：MVP 收口（本地功能验收已完成）

- [设计](superpowers/specs/2026-11-17-task-06-mvp-closure-design.md) / [实施计划](superpowers/plans/2026-11-17-task-06-mvp-closure.md)
- 使用分段证据矩阵，不新增重复而脆弱的巨型浏览器用例。
- 固定近端旧库升级、v11→v13 再导出、导入卷到纸质回传入口三个证据缺口。
- 运行本地完整 CI 与全量 Playwright并生成 [MVP 验收报告](MVP_ACCEPTANCE.md)。
- 本任务的本地功能门禁已通过；后续独立安全升级把 Next.js 16.4.3 升至 16.4.6，并再次通过完整 CI 与 96 项 Playwright。仍不能把远端 CI、真实家庭样本、生产签名或正式发布宣称为已完成。

### 发布门禁：Next.js 安全升级（本地已完成）

- [设计](superpowers/specs/2026-11-17-next-security-upgrade-design.md) / [实施计划](superpowers/plans/2026-11-17-next-security-upgrade.md)
- 官方 security 升级器确认同主版本目标为 16.4.6；React 与 React DOM 保持 19.3.1。
- 本地完整 CI 与 96/96 Chromium E2E 通过，详见 [MVP 验收报告](MVP_ACCEPTANCE.md#9-验证命令与结果)。
- 当前只形成已验证的本地分支，不自动合并、推送、打标签、发布包或镜像；正式发布前仍需 GitHub Actions 远端证据。

## 5. MVP 验收口径

- 新数据库和停在 `20261105135634_add_telemetry_tables` 的旧数据库都能升级到当前 Schema。
- 旧试卷、题目和练习记录不丢失；新考试集合为空且约束存在。
- v11→v13、v12→v13、v13 往返保持考试关联与本地页图。
- 导入、打印、回传、复核、确认、趋势和恢复分别有稳定自动化证据。
- AI 外发继续受用户同意和 Provider 配置控制；本地数据与文件随 SQLite/备份保存。
- 家庭真实样本准确率单独人工验收，不把合成夹具结果宣称为 95%。

## 6. 推荐的第二批开发任务

1. 打印二维码/短码，稳定关联 `paperId`、页码和版次。
2. 建立按年级、学科、题型分层的脱敏家庭样本评测集。
3. 当 SQLite/JSON 体积达到家庭使用上限时，引入本地文件存储适配器和 ZIP 清单备份。
4. 将掌握度重算和长整卷识别改为可恢复的持久任务。
5. 只有基准证明成本、隐私或版面需要时，再引入可选本地预处理/OCR。
6. 复用趋势、错题和掌握度生成本地可打印家长周报。
