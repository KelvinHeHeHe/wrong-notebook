# 家庭样本评测标注器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增仅在本机回环地址运行的可视化样本标注器，在仓库外安全积累分层家庭样本，并由现有评测 CLI 生成 v3 分层准确率报告。

**Architecture:** 抽取一个由评测 CLI 与标注器共同使用的 manifest 契约模块；标注器由无外部依赖的 Node.js 数据集核心、受令牌保护的 HTTP 服务和静态浏览器界面组成。真实图片、草稿、manifest 和报告始终位于仓库外，生产 Next.js、SQLite 与备份格式不变。

**Tech Stack:** Node.js 22 内置 `http`/`fs`/`crypto`、原生 HTML/CSS/JavaScript、Vitest/jsdom、现有 TypeScript/AI Provider。

**Spec:** `docs/superpowers/specs/2026-11-18-task-08-evaluation-labeler-design.md`

## Global Constraints

- 服务只监听 `127.0.0.1`，不提供 host 参数；所有 API 都需要随机会话令牌，写请求还需同源 `Origin` 和 JSON Content-Type。
- 数据集、照片、草稿、manifest、报告和真实凭据不得进入仓库、SQLite、备份、公开日志或 CI。
- 数据集必须位于源码根、Git common dir、主 checkout 和所有已注册 worktree 之外；符号链接不得绕过边界。
- 只支持 JPEG、PNG、WebP，单图 1 字节～20 MiB、最多 1000 页；目录遍历有深度和总条目上限。
- 草稿允许不完整；正式 manifest 必须通过共享严格契约。文件权限 `0600`，同目录临时文件原子替换。
- 题型只使用应用的 10 个标准 `QuestionType` key；旧 manifest 缺少分层字段仍可评测并归入“未标注”。
- 报告升级为 version 3；全局 v2 指标口径保持不变，公开交付只摘录汇总，原始报告仍视为私有数据。
- 不新增运行时依赖、Prisma 迁移、备份版本、生产页面或 Python OCR 服务。

## Review Focus

- 恶意或误配置的 dataset 路径（源码目录、其他 worktree、符号链接逃逸）必须在任何读取/写入前被拒绝；Task 2 的路径边界测试覆盖。
- 两个浏览器标签页基于同一 revision 保存时，后到请求必须得到 409，不能覆盖先到数据；Task 2/3 的并发测试覆盖。
- 本机恶意网页、DNS rebinding、无令牌读取和超大 JSON 不能读取图片或改写草稿；Task 3 的 HTTP 安全测试覆盖。
- 图片缩放、反向拖拽和越界拖拽不能产生错误坐标，且每题最多 4 框；Task 4 的几何测试覆盖。
- 从现有评测 CLI 抽取契约后，错误退出码、报告不覆盖和首次模型请求前完成全量校验不得回归；Task 1 的原有与新增测试覆盖。

---

### Task 1: 共享 manifest 契约与 v3 分层报告

**Files:**
- Create: `scripts/exam-evaluation/manifest.mjs`
- Create: `scripts/exam-evaluation/report.mjs`
- Modify: `scripts/evaluate-exam-answer-extraction.mjs`
- Modify: `src/__tests__/unit/exam-answer-evaluation.test.ts`

**Interfaces:**
- Consumes: 现有 manifest v2 兼容结构、`ExamPageAnswerCandidate`、现有评测 CLI 参数和退出码。
- Produces: `validateEvaluationManifest(value, options)`、`resolveEvaluationInputs(options)`、`buildEvaluationReport(options)` 与 `QUESTION_TYPE_KEYS`；Task 2 导出正式 manifest 时复用严格校验。

- [ ] **Step 1: 写失败测试**：新增“旧 manifest 缺少分层字段仍通过并归入未标注”“完整分层元数据生成 version 3 breakdowns”“未知题型和越界 grade 被拒绝”“所有页在首次模型请求前完成校验”的断言；保留原有退出码、脱敏和不覆盖测试。
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/unit/exam-answer-evaluation.test.ts`，确认新断言因共享模块/报告 v3 尚未实现而失败。**
- [ ] **Step 3: 实现 `manifest.mjs`**：导出固定题型 key、分层枚举、纯函数 `validateEvaluationManifest(value, { requireStrata?: boolean })`，以及异步 `resolveEvaluationInputs({ manifestPath, outputPath, repositoryRoot })`；保持当前 1～1000 页、1～100 题、区域、图片、输出路径与错误行为。
- [ ] **Step 4: 实现 `report.mjs`**：`buildEvaluationReport({ provider, model, results })` 输出 version 3、全局指标和按 `grade`/`subject`/`questionType`/`handwriting`/`photoQuality` 的固定维度汇总；缺失值使用 `unlabeled`，分母仍是全部 expected。
- [ ] **Step 5: 重构评测入口**：只替换输入验证与报告聚合，Provider、区域配对、匹配和错误退出流程保持不变；逐题结果携带固定分层标签但不新增答案、题干、框或路径。
- [ ] **Step 6: 运行目标测试与 `npm run test:unit`，确认通过且报告不含 Key、图片、答案原文。**
- [ ] **Step 7: 提交**：`git commit -m "feat: 增加评测分层报告契约"`。

### Task 2: 私有数据集与草稿核心

**Files:**
- Create: `scripts/exam-evaluation-labeler/dataset.mjs`
- Create: `src/__tests__/unit/exam-evaluation-labeler-dataset.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `validateEvaluationManifest(..., { requireStrata: true })` 和固定枚举。
- Produces: `resolveRepositoryBoundaries(repositoryRoot)`、`openDataset(options)`、`discoverDatasetImages(options)`、`loadDatasetDraft(context)`、`saveDatasetDraft(context, draft, expectedRevision)`、`exportDatasetManifest(context, expectedRevision)`；Task 3 只通过这些接口访问文件系统。

- [ ] **Step 1: 写失败测试**：使用 `mkdtemp` 创建仓库外数据集和合成图片，覆盖源码/主 checkout/其他 worktree/符号链接拒绝、隐藏或链接图片跳过、深度/条目/数量/大小限制、草稿恢复和相对路径稳定。
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/unit/exam-evaluation-labeler-dataset.test.ts`，确认模块缺失而失败。**
- [ ] **Step 3: 实现边界与发现**：通过 `git worktree list --porcelain` 和 Git common dir 建立拒绝边界；所有路径使用 realpath/lstat，递归深度最多 8、检查目录项最多 10000、图片最多 1000，不跟随符号链接。
- [ ] **Step 4: 实现草稿**：draft version 1、整数 revision、按稳定相对图片路径合并新增/缺失图片；`saveDatasetDraft` 校验 revision，使用 `0600` 临时文件加 rename 原子写入，冲突抛出可识别错误。
- [ ] **Step 5: 扩充失败测试**：两个调用者用同一 revision 保存，断言第一次成功、第二次冲突；模拟不完整草稿可保存、正式导出被拒绝、既有 manifest 更新时备份和正式文件均完整。
- [ ] **Step 6: 实现正式导出**：从草稿去除界面状态，调用 Task 1 严格校验；先原子生成 `manifest.previous.json`，再原子替换 `manifest.json`，失败时保留原文件，输出不含绝对路径和 revision。
- [ ] **Step 7: 运行目标测试与 `npm run test:unit`。**
- [ ] **Step 8: 提交**：`git commit -m "feat: 增加私有评测数据集核心"`。

### Task 3: 回环 HTTP 服务与安全边界

**Files:**
- Create: `scripts/exam-evaluation-labeler.mjs`
- Create: `scripts/exam-evaluation-labeler/server.mjs`
- Create: `src/__tests__/unit/exam-evaluation-labeler-server.test.ts`

**Interfaces:**
- Consumes: Task 2 的 dataset context、草稿保存和导出接口。
- Produces: `parseLabelerArgs(args)`、`createLabelerServer({ context, token, assetsRoot })`、`startLabeler(options)`；Task 4 的静态界面消费 `/api/state`、`/api/image/:id`、`PUT /api/draft`、`POST /api/export`。

- [ ] **Step 1: 写失败测试**：覆盖只接受绝对 `--dataset` 与可选 `--port`、固定绑定回环地址、启动 URL 用 fragment 携带令牌且日志不含数据集路径。
- [ ] **Step 2: 写 HTTP 失败测试**：无/错令牌读取、错误 Host、跨源写、非 JSON、超过 2 MiB、未知图片 ID、路径穿越分别返回 4xx；响应无 CORS 且含 CSP、no-referrer、nosniff。
- [ ] **Step 3: 运行 `npx vitest run src/__tests__/unit/exam-evaluation-labeler-server.test.ts`，确认入口和服务尚不存在。**
- [ ] **Step 4: 实现参数和启动**：只支持 `--dataset <绝对目录>`、`--port <0～65535>`，默认 0；生成 256-bit base64url token，固定监听 `127.0.0.1`，只打印通用计数和 `http://127.0.0.1:<port>/#token=...`。
- [ ] **Step 5: 实现同源服务**：严格 Host；所有 API 用 `X-Evaluation-Token`；写 API 还校验精确 Origin、JSON Content-Type 和 2 MiB 流式上限；固定 JSON 错误，不回显异常或私有字段。
- [ ] **Step 6: 实现端点**：state 返回不透明图片 ID、相对显示序号、草稿与完成度；image 只从启动白名单取普通文件并设置正确 MIME；draft/export 映射 Task 2 错误，revision 冲突为 409。
- [ ] **Step 7: 实现信号关闭和临时文件清理，运行目标测试与 `npm run test:unit`。**
- [ ] **Step 8: 提交**：`git commit -m "feat: 增加本机评测标注服务"`。

### Task 4: 可视化标注界面

**Files:**
- Create: `scripts/exam-evaluation-labeler/ui/index.html`
- Create: `scripts/exam-evaluation-labeler/ui/styles.css`
- Create: `scripts/exam-evaluation-labeler/ui/model.mjs`
- Create: `scripts/exam-evaluation-labeler/ui/app.mjs`
- Create: `src/__tests__/unit/exam-evaluation-labeler-ui.test.ts`
- Modify: `scripts/exam-evaluation-labeler/server.mjs`

**Interfaces:**
- Consumes: Task 3 的 API；`model.mjs` 不访问 DOM，提供 `normalizeDraggedRegion(...)`、`updateSample(...)`、`validateDraftProgress(...)`。
- Produces: 桌面双栏/移动单栏标注界面，支持元数据、候选题、期望答案、1～4 区域框、上一页/下一页、自动保存、冲突提示和显式导出。

- [ ] **Step 1: 写几何失败测试**：正向/反向拖拽、图片留白、越界裁剪、零面积、缩放前后稳定、第五个框拒绝。
- [ ] **Step 2: 写状态失败测试**：新增/删除候选题同步 expected、题号/短码重复提示、缺失分层字段和缺图完成度、revision 冲突进入只读重载提示。
- [ ] **Step 3: 运行 `npx vitest run src/__tests__/unit/exam-evaluation-labeler-ui.test.ts`，确认模块尚不存在。**
- [ ] **Step 4: 实现 `model.mjs` 纯函数**：所有坐标保留 0～1 数值并按图片实际内容矩形换算；题型使用 Task 1 固定 key；任何私有文本仅作为数据返回。
- [ ] **Step 5: 实现语义化 HTML/CSS**：可见 label、键盘焦点、状态区、桌面双栏和移动单栏；CSP 下不使用 inline script/style。
- [ ] **Step 6: 实现 `app.mjs`**：从 fragment 取 token 后清除 fragment；所有私有文本通过 `textContent`/value 设置；拖拽框选、选择/删除框、元数据与题目编辑、500ms 防抖保存、导航前 flush、409 停止自动保存并提示重载。
- [ ] **Step 7: 实现导出与可访问性**：未完成时列出固定字段错误；完成后调用 export；快捷键支持上一页、下一页、保存和删除当前框，不截获正在输入文本时的普通按键。
- [ ] **Step 8: 让 Task 3 安全提供四个静态资源并设置准确 MIME/安全头，运行 UI/服务目标测试和 `npm run test:unit`。**
- [ ] **Step 9: 提交**：`git commit -m "feat: 增加家庭样本可视化标注"`。

### Task 5: 命令、文档与整体验收

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `doc/EXAM_ANSWER_EVALUATION.md`
- Modify: `docs/MVP_PLAN.md`
- Modify: `src/__tests__/unit/exam-evaluation-labeler-server.test.ts`

**Interfaces:**
- Consumes: Tasks 1～4 的命令、API 和 UI。
- Produces: `npm run eval:label -- --dataset <仓库外绝对目录>` 的正式入口、双语开发者说明和任务 08 验收记录。

- [ ] **Step 1: 写 CLI 集成失败测试**：在临时目录启动真实入口，读取打印 URL，用令牌完成 state→draft→export，确认 manifest 为 `0600`、图片/答案不出现在 stdout/stderr，随后 SIGTERM 正常退出。
- [ ] **Step 2: 运行目标测试，确认 package script/完整入口尚未满足断言。**
- [ ] **Step 3: 增加 `eval:label` script，并更新中文/英文 README 的开发者命令；不把标注器放入生产用户导航。**
- [ ] **Step 4: 更新人工评测指南**：说明照片预脱敏、私有目录结构、可视化标注、报告 v3 分层字段、原始报告仍私有、≥60 题口径以及现有 Provider 运行方式。
- [ ] **Step 5: 更新 MVP 计划**：任务 08 标记为“工具已完成、真实家庭样本待用户采集验收”，明确没有凭真实数据宣称 95%，安全审计仍列为后续独立任务。
- [ ] **Step 6: 运行 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`git diff --check` 和 `rg -n "npmmirror" package-lock.json`；确认无真实照片、manifest、报告、密钥或绝对私有路径进入 Git。**
- [ ] **Step 7: 运行完整 `npm test`，再按 `scripts/ci.sh` 的项目门禁执行完整 CI；本任务不需要真实 Provider、Playwright 生产 E2E 或 Python OCR。**
- [ ] **Step 8: 提交**：`git commit -m "docs: 完善家庭样本评测工作流"`。

### Task 6: 最终审查与交付

**Files:**
- Modify only if review finds a release-blocking issue.

**Interfaces:**
- Consumes: Tasks 1～5 的完整分支。
- Produces: 独立代码审查结果、最终门禁证据和可供用户选择合并/推送/保留的分支。

- [ ] **Step 1: 对照设计逐项自查数据边界、HTTP 安全、报告隐私和旧 CLI 兼容性。**
- [ ] **Step 2: 运行公开历史检查 `python3 scripts/check-public-history.py HEAD`，检查 `git status` 和完整 diff。**
- [ ] **Step 3: 请求一次独立整分支代码审查；只修复 Important/Blocking 问题，Minor 记录到交付说明。**
- [ ] **Step 4: 修复后重跑受影响测试与完整门禁，提交独立修复 commit。**
- [ ] **Step 5: 使用 `superpowers:finishing-a-development-branch` 让用户选择本地合并、推送 PR 或保留分支。**
