# 家庭考试 MVP 验收报告

> 验收日期：2026-11-17
> 范围：任务 02～06，本地发布前门禁
> 状态：验证待执行

## 1. 验收口径

本报告采用用户确认的“分段证据矩阵 + 最小接缝断言”，不新增一个把导入、打印、回传、趋势和恢复全部重复一遍的巨型浏览器用例。

`e2e/exam-import.spec.ts` 与 `e2e/exam-attempt.spec.ts` 各自在隔离数据库中验证不同流程段；它们共享同一套生产 Prisma 模型、API 和页面契约，但不是同一张测试试卷跨两个 E2E 环境贯穿全程。任务 06 在整卷导入用例末尾增加“发布后的真实试卷 → 详情页 → 该卷回传上传页”桥接断言，以覆盖两个流程段之间原有的证据缺口。

本任务只形成可发布证据，不创建或推送标签、Release、安装包、容器镜像或 npm 包。

## 2. 分段流程证据矩阵

| 用户步骤/边界 | 自动化证据 | 验收重点 | 结果 |
| --- | --- | --- | --- |
| 照片整卷导入 | `e2e/exam-import.spec.ts` | 两页照片、部分失败、单页重试、校对发布 | 待执行 |
| PDF 整卷输入 | `src/__tests__/unit/exam-import-client.test.ts`、`e2e/file-import-pdf.spec.ts` | 全页渲染、扫描页、页数/范围限制、异常 PDF | 待执行 |
| 发布与打印 | `e2e/exam-import.spec.ts` | 发布后复用现有详情、打印 6 题 | 待执行 |
| 导入卷进入纸质回传 | `e2e/exam-import.spec.ts` | 真实 `paperId` 打开 `/exams/:id/attempts/new`，标题与上传控件正确 | 待执行 |
| 打印卷拍照回传 | `e2e/exam-attempt.spec.ts` | 桌面/手机、多页、部分失败、两阶段识别 | 待执行 |
| 人工复核与部分分 | `e2e/exam-attempt.spec.ts`、作答复核集成测试 | 题目映射、识别候选、人工更正、低置信度复核 | 待执行 |
| 确认入账 | `e2e/exam-attempt.spec.ts`、`exam-attempt-confirm.test.ts` | 事务、幂等、错题/练习记录、掌握度触发 | 待执行 |
| 成绩趋势与详情 | `e2e/exam-attempt.spec.ts`、`exam-trends` 单元/集成测试 | 仅 confirmed、得分率、时区、详情跳转 | 待执行 |
| v13 导出与空账号恢复 | `e2e/exam-attempt.spec.ts`、`data-backup.test.ts` | 页图、识别候选、逐题评分、同日双作答和关联练习记录 | 待执行 |
| AI 外发授权 | `e2e/auth-flow.spec.ts`、`ai-consent.test.ts`、作答识别 SQLite 测试 | 未授权拒绝、用户 Provider 配置、本地模拟模型 | 待执行 |
| 新库和旧库升级 | `database-migrations.test.ts` | 全新库、近端旧库、约束、幂等部署 | 待执行 |

## 3. SQLite 迁移验收

### 3.1 全新数据库

迁移集成测试在系统临时目录创建空 SQLite，部署全部正式迁移并检查 Prisma 模型、外键、唯一索引、查询索引和第二次部署幂等。测试不读取或覆盖 `prisma/dev.db`。

结果：待执行。

### 3.2 考试 MVP 前近端旧库

断点固定在 `20261105135634_add_telemetry_tables` 已应用、`20261108090000_add_exam_attempts` 尚未应用。测试先写入用户、学科、错题、旧 `ExamPaper`、`ExamQuestion` 和 `PracticeRecord` 快照，再升级到当前版本并验证：

- 原行与关系保持；
- 旧试卷得到 `origin='generated'`，新增元数据为 `null`；
- `PracticeRecord.examAttemptId` 为 `null`；
- `ExamPaperPage`、`ExamAttempt`、`ExamAttemptPage`、`ExamAttemptAnswer` 存在且为空；
- 外键与索引正确，第二次部署无待执行迁移。

结果：待执行。

## 4. 备份兼容矩阵

| 输入格式 | 当前恢复与再导出契约 | 结果 |
| --- | --- | --- |
| v11 | 旧试卷恢复为 `generated`，四个新集合为空，再导出为 v13 | 待执行 |
| v12 | 作答页缺失的 `recognitionResult` 规范化为 `null`，再导出为 v13 | 待执行 |
| v13 | 元数据、页图、识别候选、独立作答、逐题评分和练习关联完整往返 | 待执行 |

真实 SQLite 集成测试还覆盖重复导入幂等、同日两次作答保留、跨用户/跨试卷关联隔离和事务回滚。

## 5. 数据、本地文件与 AI 边界

- 业务数据和页图存于本地 SQLite；导出时进入本地 JSON 备份。
- AI 调用继续使用现有可配置 Provider，且受用户数据外发同意控制；没有把家庭数据写入代码或测试夹具。
- 自动化 E2E 使用本地模拟模型验证协议，不消耗真实外部服务。
- MVP 不增加 Python OCR 服务。现有多模态 Provider 已覆盖图片分题、识题、答案提取和评分，人工复核是安全边界。
- 严格离线、固定答题卡 OMR、精确版面校正或真实基准不达标时，才评估可选本地预处理/OCR 适配器。

## 6. 发布摘要

- 任务 02：安全增量迁移和考试数据备份集合。
- 任务 03：照片/PDF 外部整卷草稿、校对、发布和打印复用。
- 任务 04：纸质回传、页级识别候选、逐题复核、幂等确认和学习历史入账。
- 任务 05：已确认考试的成绩趋势、筛选、摘要和详情跳转。
- 任务 06：近端迁移、v11 再导出、导入卷回传入口和维护者验收文档。
- 当前备份格式 v13，兼容导入 v11/v12；旧生成试卷和旧练习记录保留。

## 7. 已知限制

1. 自动化使用合成图片和固定模型响应，只证明流程、数据和安全边界；数学、语文、英语真实家庭样本上的 95% 目标尚需用户提供脱敏样本人工验收。
2. 页图以 data URL 存 SQLite 并进入 JSON 备份，数据库和导入内存随页数增长；超过家庭可接受体积后再引入本地文件存储适配器。
3. 掌握度后台评估使用进程内队列，重启时不能保证重放；练习记录会先持久化，第二批再做可恢复任务。
4. 不同视觉 Provider 的公式、手写和长答表现不同，低置信度和主观题仍需人工复核。

## 8. 发布前外部待办

- 当前工作区没有 `../wrong-notebook-github-pages`，正式发布前需在官网仓库同步中英文功能说明并单独提交。
- Windows 生产签名依赖 SignPath 生产证书和维护者人工批准；本任务只验证签名检查逻辑，不生成生产签名包。
- 完成三学科、1～6 年级的脱敏家庭样本验收，记录识别、题号匹配和客观题判定指标。
- 若用户决定推送本分支，再以 GitHub Actions 结果补充远端证据；本地收口不自动推送。

## 9. 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm_config_registry=https://registry.npmjs.org RUST_LOG=info TELEMETRY_DISABLED=false bash scripts/ci.sh` | 待执行 |
| `npm run test:e2e` | 待执行 |
| `python3 scripts/check-public-history.py HEAD` | 待执行 |
| `rg -n "npmmirror" package-lock.json` | 待执行；预期无输出 |
| 业务 Schema、迁移和备份实现差异检查 | 待执行；预期无输出 |

被验收提交、系统版本、Node/npm/Python 版本、测试数量和 Playwright 报告路径将在上述命令完成后写入本报告。报告结果更新前的提交作为可复现锚点，避免把报告自身提交写成自引用的“最终 SHA”。
