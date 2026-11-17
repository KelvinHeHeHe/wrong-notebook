# 任务 06：MVP 收口实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用最小新增测试和可追踪文档证明家庭考试 MVP 可从旧数据安全升级，并完整覆盖整卷导入、打印、纸质回传、确认、趋势和备份恢复。

**Architecture:** 复用现有 Prisma 迁移测试、真实 SQLite 备份测试和分段 Playwright；只补考试模型迁移前断点、v11 再导出和导入卷回传入口三个证据缺口。任务 01 的审计设计稿更新为实施后事实，最终验收报告汇总本地 CI、E2E 和发布前外部待办，不创建发布标签。

**Tech Stack:** Next.js 16、React 19、TypeScript、Prisma 5、SQLite、Vitest 5、Playwright、Python unittest、Markdown。

**Spec:** `docs/superpowers/specs/2026-11-17-task-06-mvp-closure-design.md`

## Global Constraints

- 不修改 `prisma/schema.prisma`，不新增迁移，不升级 `BACKUP_VERSION = 13`。
- 所有数据库测试只使用 `mkdtemp` 下的临时 SQLite；不得读取、覆盖或删除 `prisma/dev.db`。
- 不提交 `config/setup-token`、`.env`、API Key、家庭真实数据或主工作区其他未跟踪文件。
- 不新增业务功能、Python OCR、外部服务或依赖；若验收暴露缺陷，先写回归测试并用单独提交修复。
- 采用用户选择的分段证据矩阵；不新增贯穿全部步骤的巨型 Playwright。
- 不创建或推送标签、Release、npm 包、镜像或安装包。
- 完整验证使用官方 npm registry；本机 Prisma Schema Engine 如需要，测试命令显式设置 `RUST_LOG=info`，但不修改产品配置。
- 所有回复、注释、文档和提交信息使用简体中文；中英文 README 文档索引保持同步。

## Review Focus

- 迁移断点恰好停在 `20261105135634_add_telemetry_tables`，不得误把考试模型迁移提前应用；升级后旧行保持、MVP 新表为空且约束存在。
- v11 备份导入后必须由当前导出接口写成 v13，旧试卷保留且页面/作答集合为空；不能只验证内存规范化。
- 外部整卷发布后的详情页必须真实提供回传入口并打开该卷的 `/exams/:id/attempts/new`，不能用数据库直建试卷取代接缝证据。
- 三份用户所有的未跟踪审计草稿只复制指定 Markdown；`config/setup-token` 和其他未跟踪内容不得出现在索引或历史中。
- 验收报告不得把照片 E2E 写成 PDF E2E、把合成夹具写成真实儿童样本，或把尚未推送的 GitHub Actions 写成已通过。

---

### Task 1: 固定考试 MVP 前 SQLite 升级证据

**Files:**
- Modify: `src/__tests__/integration/database-migrations.test.ts`

**Interfaces:**
- Consumes: `deploy(names?: string[])`、`openDatabase()`、`rows(table)`、`expectConstraints()`；正式迁移断点 `20261105135634_add_telemetry_tables`。
- Produces: 近端旧库升级特征测试；不产生生产接口或 Schema 变化。

- [ ] **Step 1: 添加明确断点的特征测试**

在 `真实 Prisma 数据库迁移` 中新增测试 `考试 MVP 前数据库升级后保留旧试卷并创建空的新考试集合`：

1. `deploy(migrations.filter(name => name <= '20261105135634_add_telemetry_tables'))`。
2. 插入一个用户、学科、错题、`origin` 字段尚不存在时的旧 `ExamPaper`、`ExamQuestion` 和 `PracticeRecord`。
3. 升级前保存上述表的行快照并关闭数据库。
4. `deploy()` 到当前版本后断言旧行及关联保留，`ExamPaper.origin === 'generated'`，考试元数据为空，`PracticeRecord.examAttemptId === null`。
5. 断言 `ExamPaperPage`、`ExamAttempt`、`ExamAttemptPage`、`ExamAttemptAnswer` 均存在且行数为 0，并调用 `expectConstraints()`。
6. 关闭数据库后再次 `deploy()`，断言输出包含 `No pending migrations`。

- [ ] **Step 2: 运行迁移测试并记录基线**

Run:

```bash
RUST_LOG=info npx vitest run src/__tests__/integration/database-migrations.test.ts
```

Expected: 新测试与现有全新库、旧库、识别结果迁移测试全部 PASS。若 FAIL，只修复测试夹具或真实迁移缺陷；不得改动用户数据库。

- [ ] **Step 3: 检查本任务没有业务 Schema 变化**

Run:

```bash
git diff main...HEAD -- prisma/schema.prisma prisma/migrations
```

Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add src/__tests__/integration/database-migrations.test.ts
git commit -m "test: 固定考试数据升级路径"
```

---

### Task 2: 固定 v11 导入后按 v13 再导出

**Files:**
- Modify: `src/__tests__/integration/data-backup.test.ts`

**Interfaces:**
- Consumes: `exportBackup()`、`importBackup()`、`clearUserData()`、现有 v11/v12/v13 真实 SQLite 备份用例。
- Produces: v11 → 当前 v13 的 API 级往返断言；不改变备份格式或导入实现。

- [ ] **Step 1: 扩展现有 v11 兼容测试**

把测试名改为 `v11 备份恢复 generated 试卷并按 v13 再导出`。在现有导入及空集合断言之后调用 `exportBackup()`，断言：

- `reexported.version === 13`；
- 标题为 `旧版试卷` 的试卷仍存在，`origin === 'generated'`；
- `examPaperPages`、`examAttempts`、`examAttemptPages`、`examAttemptAnswers` 均为空数组。

不要新增 v12 同义测试；现有 `v13/v12 外部试卷作答页识别结果往返` 已断言 v12 缺失 `recognitionResult` 恢复为 `null`、再次导出版本 13，计划只复跑它。

- [ ] **Step 2: 运行真实 SQLite 备份测试**

Run:

```bash
RUST_LOG=info TELEMETRY_DISABLED=false npx vitest run src/__tests__/integration/data-backup.test.ts
```

Expected: 全文件 PASS；v11、v12、v13、同日双作答、重复导入及隔离测试均保持绿色。

- [ ] **Step 3: 确认格式单一来源未变化**

Run:

```bash
git diff main...HEAD -- src/lib/backup/format.ts src/app/api/export/route.ts src/app/api/import/route.ts prisma/schema.prisma
```

Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add src/__tests__/integration/data-backup.test.ts
git commit -m "test: 固定旧版备份升级导出"
```

---

### Task 3: 固定导入卷与纸质回传入口接缝

**Files:**
- Modify: `e2e/exam-import.spec.ts`

**Interfaces:**
- Consumes: 现有 `[E2E-EXAM-IMPORT]` 场景、发布后的 `paperId`、试卷详情页回传链接。
- Produces: 导入发布得到的真实 `ExamPaper` 能进入该卷作答上传页的浏览器证据。

- [ ] **Step 1: 在既有场景末尾添加桥接断言**

打印断言完成后返回 `/exams/${paperId}`，真实点击名称为 `回传纸质作答` 的链接，断言：

- URL 为 `/exams/${paperId}/attempts/new`；
- 页面上的试卷标题为 `E2E 外部整卷周测`；
- 上传控件 `已作答试卷照片` 可见。

不继续执行识别与确认；这些行为由 `e2e/exam-attempt.spec.ts` 独立覆盖。

- [ ] **Step 2: 运行定向 Playwright**

Run:

```bash
npm run test:e2e -- e2e/exam-import.spec.ts
```

Expected: `[E2E-EXAM-IMPORT]` 1/1 PASS，且报告写入系统临时目录。

- [ ] **Step 3: 提交**

```bash
git add e2e/exam-import.spec.ts
git commit -m "test: 衔接整卷导入与纸质回传"
```

---

### Task 4: 把任务 01 设计稿更新为实施后事实

**Files:**
- Create: `docs/PROJECT_AUDIT.md`
- Create: `docs/MVP_PLAN.md`
- Create: `docs/DATA_MODEL.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `README.en.md`

**Interfaces:**
- Consumes: 主工作区中用户所有的三份未跟踪 Markdown 草稿（只读来源）、当前 `prisma/schema.prisma`、`BACKUP_VERSION = 13`、任务 02～05设计与测试证据。
- Produces: 入库后的项目审计、MVP 状态、已实现数据模型和中英文文档入口。

- [ ] **Step 1: 只读取并重建三份指定草稿**

从主工作区只读取 `docs/PROJECT_AUDIT.md`、`docs/MVP_PLAN.md`、`docs/DATA_MODEL.md`，使用 `apply_patch` 在任务工作树创建同名文件。不得复制整个目录，不得读取或暂存 `config/setup-token`。

- [ ] **Step 2: 更新 `docs/PROJECT_AUDIT.md`**

保留源码审计的 commit、LICENSE、技术栈、AI/OCR 结论和初始环境异常；新增“任务 02～05 实施结果”章节，并把功能矩阵更新为：

- 整卷导入、纸质回传、确认入账、成绩趋势均已实现；
- 本地数据与页图进入 v13 备份；
- 不需要 Python OCR；真实家庭样本 95% 仍是发布前人工验收项；
- 测试数量只写本次最终验证结果，不作为永久阈值。

- [ ] **Step 3: 更新 `docs/MVP_PLAN.md`**

把任务 02～05标为已完成并链接对应设计/计划；把备份说明统一为“当前 v13，兼容 v11/v12”；把任务 06 标为本分支收口；保留第二批候选。删除“尚未开始任务 02”的门禁表述，不把本任务写成实际发布。

- [ ] **Step 4: 更新 `docs/DATA_MODEL.md`**

将状态改为“已实现”，以当前 Prisma 为准描述：

- `ExamPaper`、`ExamQuestion` 增量字段；
- `ExamPaperPage`、`ExamAttempt`、`ExamAttemptPage.recognitionResult`、`ExamAttemptAnswer`；
- `PracticeRecord.examAttemptId` 仅保存关联 ID且写入侧校验；
- 正式迁移 `20261108090000_add_exam_attempts` 与 `20261108160000_add_attempt_page_recognition`；
- 备份 v12 引入考试集合，v13 增加页级识别候选，v11/v12 可导入；
- 图片存 SQLite/JSON 的容量边界与第二批文件存储建议。

不得把设计草案中的 Prisma 伪代码当成当前 Schema；字段、关系和索引逐项核对 `prisma/schema.prisma`。

- [ ] **Step 5: 修正文档入口和内部版本说明**

- `AGENTS.md` 把“当前 version 11”修正为“当前 version 13”。
- `README.md` 与 `README.en.md` 的文档表增加四个 `docs/` 文件入口，并注明审计/验收文档主要为中文维护者文档。
- 不修改 Wiki 用户行为说明；本任务没有改变产品行为。

- [ ] **Step 6: 做静态文档检查**

Run:

```bash
rg -n "当前 version 11|备份 v12 可|尚未修改.*schema|3512 个测试|88/88" AGENTS.md docs/PROJECT_AUDIT.md docs/MVP_PLAN.md docs/DATA_MODEL.md
rg -n "setup-token|API Key|BEGIN.*PRIVATE|内网" docs/PROJECT_AUDIT.md docs/MVP_PLAN.md docs/DATA_MODEL.md
git diff --check
```

Expected: 第一条不命中过时结论；第二条不命中凭据或私有部署信息；diff 无空白错误。允许历史章节明确标注“任务 01 当时”的旧测试数量，但不得作为当前状态。

- [ ] **Step 7: 提交**

```bash
git add AGENTS.md README.md README.en.md docs/PROJECT_AUDIT.md docs/MVP_PLAN.md docs/DATA_MODEL.md
git commit -m "docs: 更新家庭考试 MVP 实施状态"
```

---

### Task 5: 生成验收报告并完成发布前门禁

**Files:**
- Create: `docs/MVP_ACCEPTANCE.md`
- Modify: `docs/superpowers/specs/2026-11-17-task-06-mvp-closure-design.md`（状态已批准，仅在实际结果与设计偏离时补裁决）

**Interfaces:**
- Consumes: Tasks 1～4 的提交、Git HEAD、系统版本、Node/npm 版本、所有验证命令输出。
- Produces: 可审阅的分段证据矩阵、发布摘要和最终本地门禁结果。

- [ ] **Step 1: 创建验收报告骨架**

`docs/MVP_ACCEPTANCE.md` 包含：

1. 验收日期与范围；
2. 分段流程矩阵，明确照片、PDF、授权、迁移、备份各自证据；
3. 全新 SQLite 与 `20261105135634` 旧库断点结果；
4. v11→v13、v12→v13、v13 往返结果；
5. 本地数据、AI 外发和无 Python OCR 结论；
6. 发布摘要（任务 02～05功能、备份 v13、兼容性）；
7. 已知限制（真实家庭样本、SQLite 图片容量、进程内掌握度队列）；
8. 发布前外部待办（官网仓库、SignPath 生产证书）；
9. 验证命令表，结果先标记为“待执行”。

文档必须说明用户选择分段证据矩阵，不能声称同一试卷贯穿两个独立 E2E。

- [ ] **Step 2: 提交验收报告骨架**

```bash
git add docs/MVP_ACCEPTANCE.md docs/superpowers/specs/2026-11-17-task-06-mvp-closure-design.md
git commit -m "docs: 新增家庭考试 MVP 验收报告"
```

- [ ] **Step 3: 运行本地完整 CI**

Run:

```bash
npm_config_registry=https://registry.npmjs.org RUST_LOG=info TELEMETRY_DISABLED=false bash scripts/ci.sh
```

Expected: `npm ci`、Prisma Client、lint、全量 Vitest、Python publication、公开历史脚本、shell/Node 语法和生产构建全部 PASS。

- [ ] **Step 4: 运行全量 Playwright**

Run:

```bash
npm run test:e2e
```

Expected: 所有 Chromium 用例 PASS，0 unexpected、0 flaky、0 skipped；报告位于运行器打印的系统临时目录。

- [ ] **Step 5: 记录可复现证据**

Run:

```bash
git rev-parse HEAD
node --version
npm --version
sw_vers
python3 --version
python3 scripts/check-public-history.py HEAD
rg -n "npmmirror" package-lock.json
git diff main...HEAD -- prisma/schema.prisma prisma/migrations src/lib/backup/format.ts src/app/api/export/route.ts src/app/api/import/route.ts
```

Expected: 公开历史通过；`npmmirror` 无输出；业务 Schema、迁移和备份实现无差异。把被验收提交 SHA（报告结果更新前的 HEAD）、环境、测试文件/用例数量、E2E 报告路径和命令结果写入 `docs/MVP_ACCEPTANCE.md`。不要把报告自身提交 SHA 写成自引用“最终 SHA”。

- [ ] **Step 6: 提交最终证据**

```bash
git add docs/MVP_ACCEPTANCE.md
git commit -m "docs: 记录家庭考试 MVP 验收结果"
```

- [ ] **Step 7: 最终只读复核**

Run:

```bash
git status --short
git diff --check main...HEAD
python3 scripts/check-public-history.py HEAD
git log --oneline main..HEAD
```

Expected: 工作区干净；差异和公开历史检查通过；提交按测试、文档和证据分离。GitHub Actions 只在用户后续明确选择推送时跟踪，不在此计划内自动推送。
