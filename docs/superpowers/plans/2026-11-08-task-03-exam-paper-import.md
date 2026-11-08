# 任务 03：考试管理与整卷导入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持家庭用户把 1～20 页 PDF/照片导入为可校对、可重试、可打印的外部试卷，且发布前后都不写入错题历史。

**Architecture:** 浏览器把 PDF/照片统一转换为受限 JPEG 页图，服务端以 `ExamPaper`/`ExamPaperPage` 保存草稿，并按页调用现有 `splitQuestionsForUser`。校对通过现有试卷 PATCH 路由的独立请求分支原子保存，发布后复用现有详情、打印和答案页。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、Prisma 5、SQLite、Zod、Vitest、Playwright、pdfjs-dist。

**Spec:** `docs/superpowers/specs/2026-11-08-exam-paper-import-design.md`，并遵循主工作区 `/Users/example/projects/wrong-notebook/docs/MVP_PLAN.md` 与 `docs/DATA_MODEL.md` 的任务 03 边界。

## Global Constraints

- 复用现有 AI Provider、`splitQuestionsForUser`、PDF 渲染、图片压缩和区域编辑，不增加 Python OCR 服务。
- 任务 03 不创建 `ErrorItem`、`PracticeRecord`、`ExamAttempt` 或成绩趋势数据。
- 每卷 1～20 页；只接收受支持图片 data URL；每页沿用 1.5 MB、4096 px 和总像素限制。
- 不修改 Prisma schema、备份版本或现有生成试卷行为。
- 新 API 使用 `withUser`、Zod、统一错误响应和服务端 logger。
- 中英文翻译 key 一致，页面移动优先，TypeScript 避免 `any`，lint 零警告。
- 全部逻辑严格执行 TDD；每个任务先观察预期失败，再实现最小代码。

## Review Focus

- 同一卷出现重复页序或重复图片时必须拒绝，不能静默覆盖错误页面；由任务 1、2 测试固定。
- 20 页中任一页 AI 失败时其他成功页必须保留，失败页可单独重试且不删除旧草稿；由任务 3 测试固定。
- 跨用户试卷、学科、题目 ID 或页码不能读取或写入；由任务 2、4 测试固定。
- 标称总分与题目分值不一致、题目页无题、非法区域时不能发布；由任务 4 测试固定。
- 导入和发布全过程不得产生错题或练习记录；由任务 2、4、7 的数据库断言固定。

---

### Task 1: 外部试卷共享 schema 与领域纯函数

**Files:**
- Create: `src/lib/schemas/exam.ts`
- Create: `src/lib/exam/exam-import.ts`
- Test: `src/__tests__/unit/exam-import.test.ts`

**Interfaces:**
- Consumes: `DraftRegion`、`draftRegionSchema`、现有图片 data URL 和分值限制。
- Produces: `createImportedExamSchema`、`upsertExamPagesSchema`、`recognizeExamPagesSchema`、`updateImportedExamSchema`、`parseExamRegions(raw)`、`buildImportedQuestions(pageOrder, splitResult)`、`validateImportedExamForPublish(input)`；更新 schema 支持可选题目 ID、页面角色与有序题目替换。

- [ ] **Step 1: 写页数/MIME/物理页序/checksum、页面角色、可选题目 ID、区域兼容、识别映射和发布不变量的失败测试**
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/unit/exam-import.test.ts`，确认因模块不存在或行为缺失而失败**
- [ ] **Step 3: 实现最小 Zod schema、区域解析、题目映射与发布校验**
- [ ] **Step 4: 重跑单测，确认全部通过**
- [ ] **Step 5: 提交 `feat: 新增外部试卷导入领域校验`**

### Task 2: 创建草稿与页面幂等写入 API

**Files:**
- Create: `src/app/api/exams/import/route.ts`
- Create: `src/app/api/exams/[id]/pages/route.ts`
- Modify: `src/app/api/exams/route.ts`
- Modify: `src/app/api/exams/[id]/route.ts`
- Test: `src/__tests__/integration/exam-import.test.ts`

**Interfaces:**
- Consumes: Task 1 的创建/页面 schema。
- Produces: `POST /api/exams/import`、`POST /api/exams/:id/pages`，以及包含 `origin`/元数据/页面的列表与详情响应。

- [ ] **Step 1: 写创建 1～20 页草稿、拒绝跨用户学科/跨角色重复物理页、页面替换/角色切换删除页内草稿和现有 GET 兼容的失败测试**
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/integration/exam-import.test.ts src/__tests__/integration/exams.test.ts`，确认新接口缺失而失败**
- [ ] **Step 3: 实现事务创建、服务端 checksum 校验、幂等页面写入及详情扩展**
- [ ] **Step 4: 重跑两组集成测试，确认通过且未调用错题/练习记录写入**
- [ ] **Step 5: 提交 `feat: 新增外部整卷草稿与页面接口`**

### Task 3: 按页视觉识别与部分失败恢复

**Files:**
- Create: `src/app/api/exams/[id]/recognize/route.ts`
- Modify: `src/lib/exam/exam-import.ts`
- Test: `src/__tests__/integration/exam-import-recognition.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `recognizeExamPagesSchema`、`buildImportedQuestions` 和现有 `splitQuestionsForUser`。
- Produces: `POST /api/exams/:id/recognize`，响应 `{ successes, failures, status }`；每页成功后独立持久化。

- [ ] **Step 1: 写两页一成一败、失败后重试、重复识别仅替换目标页、空结果和跨用户访问的失败测试**
- [ ] **Step 2: 运行目标测试，确认路由缺失或行为不符**
- [ ] **Step 3: 实现逐页 AI 调用、成功页事务替换、全卷顺序重排和最终 `review` 状态更新**
- [ ] **Step 4: 重跑目标测试，确认成功页不因其他页失败而回滚，且旧草稿只在成功后替换**
- [ ] **Step 5: 提交 `feat: 新增外部试卷按页识别与重试`**

### Task 4: 校对保存与发布

**Files:**
- Modify: `src/app/api/exams/[id]/route.ts`
- Modify: `src/lib/exam/exam-import.ts`
- Test: `src/__tests__/integration/exam-import-review.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `updateImportedExamSchema` 和 `validateImportedExamForPublish`。
- Produces: `PATCH /api/exams/:id` 的 `kind='import-draft'` 分支，支持保存或 `publish=true`。

- [ ] **Step 1: 写元数据/页面角色/题目新增删除重排原子保存、跨卷题目拒绝、失败页/空题干/非法区域/总分不符拒绝发布、发布零错题副作用的失败测试**
- [ ] **Step 2: 运行目标测试，确认请求落入旧分支并失败**
- [ ] **Step 3: 在现有 PATCH 的最前面增加严格独立分支，事务更新题目并在校验通过后发布**
- [ ] **Step 4: 重跑新旧 exams 集成测试，确认旧配图、分值和分组更新行为不变**
- [ ] **Step 5: 提交 `feat: 新增外部试卷校对与发布接口`**

### Task 5: PDF/照片客户端导入流程

**Files:**
- Create: `src/lib/exam/exam-import-client.ts`
- Create: `src/lib/hooks/use-exam-import.ts`
- Create: `src/components/exam-import/exam-import-form.tsx`
- Create: `src/components/exam-import/page-preview-list.tsx`
- Create: `src/app/exams/import/page.tsx`
- Modify: `src/app/exams/page.tsx`
- Modify: `src/types/api.ts`
- Test: `src/__tests__/unit/exam-import-client.test.ts`
- Test: `src/__tests__/unit/exam-import-form.test.tsx`

**Interfaces:**
- Consumes: `loadPdfjsBrowser`、`renderPdfPages`、`prepareImage`、`renderRegion` 和任务 2/3 API。
- Produces: `prepareExamImportFiles(files, deps)`、`useExamImport` 和 `/exams/import` 页面。

- [ ] **Step 1: 写文字型 PDF 仍全页渲染、照片按选择顺序压缩、超过 20 页/混合 PDF 与照片拒绝、识别单页失败仍继续的失败测试**
- [ ] **Step 2: 运行目标单测，确认客户端模块/页面缺失而失败**
- [ ] **Step 3: 实现文件准备纯流程、hook、移动优先表单、页预览排序和创建后逐页识别进度**
- [ ] **Step 4: 重跑组件与客户端单测，确认成功后跳转校对页且失败页信息被保留**
- [ ] **Step 5: 提交 `feat: 新增整卷 PDF 与照片导入页面`**

### Task 6: 整卷校对 UI 与现有打印衔接

**Files:**
- Create: `src/components/exam-import/exam-import-review.tsx`
- Create: `src/components/exam-import/import-question-card.tsx`
- Create: `src/app/exams/[id]/import/page.tsx`
- Modify: `src/app/exams/[id]/page.tsx`
- Modify: `src/types/api.ts`
- Test: `src/__tests__/unit/exam-import-review.test.tsx`

**Interfaces:**
- Consumes: 扩展后的 `ExamPaperDetail`、现有 `RegionEditorDialog`、任务 3 重试 API 和任务 4 保存/发布 API。
- Produces: 页面状态、题目页/答案页切换、单页重试、题目新增删除重排、字段与区域编辑、保存与发布 UI。

- [ ] **Step 1: 写失败页提示与重试、页面角色切换、题目新增删除重排、题干/题号/分值编辑、区域编辑、保存和发布跳转的失败组件测试**
- [ ] **Step 2: 运行目标测试，确认组件缺失而失败**
- [ ] **Step 3: 实现校对页面与组件；外部卷 `review/importing` 详情自动导向校对，`ready` 继续使用现有详情/打印**
- [ ] **Step 4: 重跑组件测试和既有试卷 UI 单测，确认生成试卷界面无回退**
- [ ] **Step 5: 提交 `feat: 新增外部试卷校对与发布界面`**

### Task 7: 国际化、端到端与整批验证

**Files:**
- Modify: `src/lib/i18n/zh.ts`
- Modify: `src/lib/i18n/en.ts`
- Modify: `README.md`
- Modify: `README.en.md`
- Create: `e2e/exam-import.spec.ts`
- Modify: `e2e/support/mock-ai.mjs`（仅在需要稳定分题回复时）

**Interfaces:**
- Consumes: Tasks 1～6 的完整流程。
- Produces: 中英文用户文案、用户文档和“导入→部分失败→重试→校对→发布→打印”的 E2E 证据。

- [ ] **Step 1: 写 E2E，用两页图片触发一页失败并断言另一页已持久化、重试后发布且 `ErrorItem`/`PracticeRecord` 数量不变**
- [ ] **Step 2: 运行目标 E2E，确认新流程缺失而失败**
- [ ] **Step 3: 补齐中英文文案、mock AI 分题场景和 README 使用说明**
- [ ] **Step 4: 运行 `npm run lint`、`npx tsc --noEmit`、任务 03 单元/集成测试、`npm test` 与 `npm run test:e2e -- e2e/exam-import.spec.ts`**
- [ ] **Step 5: 检查 `git diff --check`、无 `npmmirror`、无 schema/backup 变化，并提交 `test: 完善整卷导入验收覆盖`**

