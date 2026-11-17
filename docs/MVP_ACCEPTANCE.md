# 家庭考试 MVP 验收报告

> 验收日期：2026-11-17
> 范围：任务 02～06，本地发布前门禁
> 状态：本地功能门禁通过；正式发布前需处理 Next.js 安全升级待办

## 1. 验收口径

本报告采用用户确认的“分段证据矩阵 + 最小接缝断言”，不新增一个把导入、打印、回传、趋势和恢复全部重复一遍的巨型浏览器用例。

`e2e/exam-import.spec.ts` 与 `e2e/exam-attempt.spec.ts` 各自在隔离数据库中验证不同流程段；它们共享同一套生产 Prisma 模型、API 和页面契约，但不是同一张测试试卷跨两个 E2E 环境贯穿全程。任务 06 在整卷导入用例末尾增加“发布后的真实试卷 → 详情页 → 该卷回传上传页”桥接断言，以覆盖两个流程段之间原有的证据缺口。

本任务只形成可发布证据，不创建或推送标签、Release、安装包、容器镜像或 npm 包。

## 2. 分段流程证据矩阵

| 用户步骤/边界 | 自动化证据 | 验收重点 | 结果 |
| --- | --- | --- | --- |
| 照片整卷导入 | `e2e/exam-import.spec.ts` | 两页照片、部分失败、单页重试、校对发布 | 通过 |
| 整卷 PDF 客户端处理 | `src/__tests__/unit/exam-import-client.test.ts` | 注入模拟 PDF 文档/渲染器，验证全页、页序、页数上限与异常处理；不是浏览器发布流程 | 通过 |
| 首页题库 PDF 浏览器导入 | `e2e/file-import-pdf.spec.ts` | 文字/扫描 PDF、页码范围和异常文件进入题库批次；不经过 `/exams/import` | 通过 |
| 发布与打印 | `e2e/exam-import.spec.ts` | 发布后复用现有详情、打印 6 题 | 通过 |
| 导入卷进入纸质回传 | `e2e/exam-import.spec.ts` | 真实 `paperId` 打开 `/exams/:id/attempts/new`，标题与上传控件正确 | 通过 |
| 打印卷拍照回传 | `e2e/exam-attempt.spec.ts` | 桌面/手机、多页、部分失败、两阶段识别 | 通过 |
| 人工复核与部分分 | `e2e/exam-attempt.spec.ts`、作答复核集成测试 | 题目映射、识别候选、人工更正、低置信度复核 | 通过 |
| 确认入账 | `e2e/exam-attempt.spec.ts`、`exam-attempt-confirm.test.ts` | 事务、幂等、错题/练习记录、掌握度触发 | 通过 |
| 成绩趋势与详情 | `e2e/exam-attempt.spec.ts`、`exam-trends` 单元/集成测试 | 仅 confirmed、得分率、时区、详情跳转 | 通过 |
| v13 导出与空账号恢复 | `e2e/exam-attempt.spec.ts`、`data-backup.test.ts` | 页图、识别候选、逐题评分、同日双作答和关联练习记录 | 通过 |
| AI 外发授权 | `e2e/auth-flow.spec.ts`、`ai-consent.test.ts`、作答识别 SQLite 测试 | 未授权拒绝、用户 Provider 配置、本地模拟模型 | 通过 |
| 新库和旧库升级 | `database-migrations.test.ts` | 全新库、近端旧库、约束、幂等部署 | 通过 |

## 3. SQLite 迁移验收

### 3.1 全新数据库

迁移集成测试在系统临时目录创建空 SQLite，部署全部正式迁移并检查 Prisma 模型、外键、唯一索引、查询索引和第二次部署幂等。测试不读取或覆盖 `prisma/dev.db`。

结果：通过。迁移文件测试共 6/6 通过，包含全新库部署、Schema 差异和第二次部署幂等检查。

### 3.2 考试 MVP 前近端旧库

断点固定在 `20261105135634_add_telemetry_tables` 已应用、`20261108090000_add_exam_attempts` 尚未应用。测试先写入用户、学科、错题、旧 `ExamPaper`、`ExamQuestion` 和 `PracticeRecord` 快照，再升级到当前版本并验证：

- 原行与关系保持；
- 旧试卷得到 `origin='generated'`，新增元数据为 `null`；
- `PracticeRecord.examAttemptId` 为 `null`；
- `ExamPaperPage`、`ExamAttempt`、`ExamAttemptPage`、`ExamAttemptAnswer` 存在且为空；
- 外键与索引正确，第二次部署无待执行迁移。

结果：通过。断点快照、默认值、四个空集合、外键/索引和重复部署断言全部通过。

## 4. 备份兼容矩阵

| 输入格式 | 当前恢复与再导出契约 | 结果 |
| --- | --- | --- |
| v11 | 旧试卷恢复为 `generated`，四个新集合为空，再导出为 v13 | 通过 |
| v12 | 作答页缺失的 `recognitionResult` 规范化为 `null`，再导出为 v13 | 通过 |
| v13 | 元数据、页图、识别候选、独立作答、逐题评分和练习关联完整往返 | 通过 |

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
2. 页图以 data URL 存 SQLite 并进入 JSON 备份，数据库和导入内存随页数增长。当前 JSON 导入接口拒绝 `Content-Length` 超过 50 MiB 的请求，而导出没有对称上限；自动化只覆盖远低于该上限的小型夹具，因此合法导出的超大备份可能无法通过设置页恢复。达到该规模前应使用[实例级备份恢复](../doc/wiki/Backup-and-Restore.md)，并在第二批增加导出预警或文件存储适配器。
3. 掌握度后台评估使用进程内队列，重启时不能保证重放；练习记录会先持久化，第二批再做可恢复任务。
4. 不同视觉 Provider 的公式、手写和长答表现不同，低置信度和主观题仍需人工复核。

## 8. 发布前外部待办

- 当前工作区没有 `../wrong-notebook-github-pages`，正式发布前需在官网仓库同步中英文功能说明并单独提交。
- Windows 生产签名依赖 SignPath 生产证书和维护者人工批准；本任务只验证签名检查逻辑，不生成生产签名包。
- 最终门禁重跑时，Next.js 16.4.3 在构建完成后显示已知安全漏洞的一次性升级提示并要求重跑。任务 06 不擅自改变依赖；正式发布前应在独立工作树运行官方 `next upgrade --agent=security` 流程，完整复测后再发布。
- 完成三学科、1～6 年级的脱敏家庭样本验收，记录识别、题号匹配和客观题判定指标。
- 若用户决定推送本分支，再以 GitHub Actions 结果补充远端证据；本地收口不自动推送。

## 9. 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm_config_registry=https://registry.npmjs.org RUST_LOG=info TELEMETRY_DISABLED=false bash scripts/ci.sh` | 通过：依赖、Prisma、lint、309 个 Vitest 文件/4110 个用例、10 个 publication 用例、公开历史、脚本语法、TypeScript 与生产构建 |
| `npm run test:e2e` | 通过：96/96 Chromium，0 unexpected、0 flaky、0 skipped，耗时约 3.3 分钟 |
| `python3 scripts/check-public-history.py HEAD` | 通过：公开基线之后 12223 个可达对象及全历史私有路径检查通过 |
| `rg -n "npmmirror" package-lock.json` | 通过：无输出，锁文件未引用该镜像 |
| 业务 Schema、迁移和备份实现差异检查 | 通过：无输出 |

### 9.1 可复现环境

| 项目 | 值 |
| --- | --- |
| 被验收提交 | `b94070fc3fb898b4ee58130c452fae5733bd3062` |
| 系统 | macOS 15.8.1（Build 24H32），Apple Silicon |
| Node.js | v26.9.0 |
| npm | 11.19.1 |
| Python | 3.13.5 |
| Playwright 报告 | `/var/folders/hm/1zxwv_s97n37fv5w06g9qzj80000gn/T/wrong-notebook-e2e-crWK7j/report` |

完整 CI 的生产构建退出 0；Turbopack 对 `src/lib/background-tasks.ts` 的动态文件读取保留一条既有跟踪范围警告，不影响本次构建，但可在第二批独立评估打包体积。报告自身的结果提交不作为自引用“最终 SHA”；上表锚定的是写入结果前已通过门禁的提交。

最终证据提交后的第一次门禁重跑，Next.js 在构建产物生成完成后因新获取的安全公告主动退出 1，并明确要求重跑相同命令；这次中止未计为通过。按提示重跑后的最终结果记录在本任务账本中，但“构建可继续”不代表漏洞已修复，安全升级仍是正式发布阻断项。
