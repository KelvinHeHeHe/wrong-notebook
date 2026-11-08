# 任务 04：纸质练习回传与确认实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持孩子直接在系统打印试卷上作答，家长上传照片后由 AI 提取答案、给出判分建议，经人工复核后原子确认成绩、错题和练习历史。

**Architecture:** 浏览器复用现有图片方向校正与压缩流程，服务端按页调用新增的视觉答案提取方法，再按已匹配题目复用 `gradeAnswer`。页级候选、逐题草稿与最终确认分别持久化；只有确认事务写入 `ErrorItem`、`PracticeRecord` 和掌握度后续任务，未确认前不改变学习历史。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、Prisma 5、SQLite、Zod、Sharp、Vitest、Playwright、现有多 Provider AI 封装。

**Spec:** `docs/superpowers/specs/2026-11-08-task-04-paper-return-design.md`

## Global Constraints

- 使用方式固定为“直接在系统打印试卷题目页作答并拍照回传”；不支持独立答题卡、草稿纸或自动猜卷。
- 每次作答上传 1～20 张 JPEG/PNG/WebP；复用现有 1.5 MB、4096 px、总像素和真实解码限制，并顺序解码控制 Apple Silicon 家庭设备内存。
- 复用现有 AI Provider、`getAIService({ userId, kind: 'grade' })`、AI 授权/额度入口和 `gradeAnswer`；不增加 Python OCR、队列、对象存储或云数据库。
- 第一阶段只提取答案，第二阶段逐题判分；置信度阈值固定为 `0.80`，主观题、未匹配、缺答案/分值及异常结果必须人工复核。
- `confirmed` 是终态；重复确认必须幂等，任何失败不得留下半份成绩、重复错题或重复练习记录。
- 新增 `ExamAttemptPage.recognitionResult` 可空字段，正式迁移兼容已有数据；备份版本由 v12 升至 v13，并兼容导入 v12。
- 未匹配/冲突候选必须持久化并支持人工映射；MVP 只查看答案区域，不实现拖拽框选，区域无效时错题原图回退整页。
- 所有新 API 使用 `withUser`、Zod、统一 API 错误和服务端 logger；耗时识别/重判使用 `withRecoverableResponse`，且它位于鉴权包装器外层。
- 中英文翻译 key 必须一致，页面移动优先；TypeScript 避免 `any`，服务端模块首行使用 `import "server-only"`，lint 零警告。
- 不修改现有 `/api/exams/:id/results` 的请求/响应行为；抽取共享写入逻辑后必须保持既有结果录入测试通过。
- 除新增正式迁移和备份 v13 外，不做破坏性迁移、不删除现有数据；全部任务严格执行 TDD，并按任务独立提交。

## File Structure

- `src/lib/ai/exam-answer-extraction.ts`：视觉提取的 Zod 解析、长度/坐标/置信度规范化。
- `src/lib/ai/prompts/exam-answer-extraction.ts`：只描述提取任务与 JSON 输出，不包含真实题目数据。
- `src/lib/exam/exam-attempt.ts`：共享状态、候选信封、确定性匹配、复核与分数纯函数。
- `src/lib/exam/exam-attempt-recognition.ts`：页级提取、逐题判分、部分成功和迟到结果保护。
- `src/lib/exam/exam-attempt-confirm.ts`：确认不变量、错题创建/复用、练习记录和原子提交。
- `src/lib/exam/exam-attempt-image.ts`：按相对区域裁剪回传图片，非法区域回退整页。
- `src/lib/schemas/exam-attempt.ts`：创建、上传、识别、人工修改和确认请求 schema。
- `src/lib/exam/exam-attempt-client.ts` 与 `src/lib/hooks/use-exam-attempt-*.ts`：浏览器图片准备和页面状态。
- `src/components/exam-attempt/`：上传、答案卡、区域预览、未匹配候选和确认界面。
- `src/app/api/exam-attempts/`、`src/app/api/exams/[id]/attempts/`：作答生命周期 API；路由只做鉴权、解析与错误映射。

## Review Focus

- 同页重复照片、页序替换和识别返回期间页面被替换：必须拒绝旧结果覆盖新页；由任务 4、5 的 checksum 与 `expectedUpdatedAt` 测试固定。
- AI 同时返回短 ID/题号冲突、同题多个候选或未知短 ID：必须持久化候选并要求人工映射，不能模糊猜测；由任务 3、5、7 测试固定。
- 人工复核后重试识别或迟到 AI 响应：不得覆盖 `reviewed` 结果；由任务 5 的并发测试固定。
- 确认请求重放或两个标签页并发确认：只产生每题一条 `PracticeRecord`，错题只创建/复用一次且总分一致；由任务 6、7 测试固定。
- 正确的外部题没有 `ErrorItem` 时仍应进入成绩历史但不能进入错题本；做错后应创建/复用错题并回写 `ExamQuestion.errorItemId`；由任务 6 测试固定。

---

### Task 1: `recognitionResult` 迁移与备份 v13

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261108160000_add_attempt_page_recognition/migration.sql`
- Modify: `src/lib/backup/format.ts`
- Modify: `src/lib/backup/import-parser.ts`
- Modify: `src/lib/backup/import-writer/attempts.ts`
- Modify: `src/__tests__/integration/database-migrations.test.ts`
- Modify: `src/__tests__/unit/backup-format.test.ts`
- Modify: `src/__tests__/unit/backup-import-parser.test.ts`
- Modify: `src/__tests__/integration/data-backup.test.ts`

**Interfaces:**
- Consumes: 任务 02 已有 `ExamAttemptPage` 和备份 v12 映射。
- Produces: `ExamAttemptPage.recognitionResult: String?`、`BACKUP_VERSION = 13`、`BackupExamAttemptPage.recognitionResult: string | null`；v12 缺字段时规范化为 `null`。

- [ ] **Step 1: 写失败测试**：断言全量迁移后字段存在且旧行保持可读；v13 导出/导入完整保留 JSON；把导出对象改成 `version: 12` 并删除字段后仍可导入且恢复值为 `null`；跨用户页仍不导出。
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/integration/database-migrations.test.ts src/__tests__/unit/backup-format.test.ts src/__tests__/unit/backup-import-parser.test.ts src/__tests__/integration/data-backup.test.ts`**，确认因字段和版本未更新而失败。
- [ ] **Step 3: 实现最小迁移与备份变更**：SQL 只执行 `ALTER TABLE "ExamAttemptPage" ADD COLUMN "recognitionResult" TEXT`；格式、顶层校验、规范化和 writer 同步字段，不改其他模型。
- [ ] **Step 4: 运行 `npx prisma generate` 后重跑上述测试**，确认 v13 往返和 v12 兼容均通过。
- [ ] **Step 5: 提交**：`feat: 升级纸质作答页备份至 v13`

### Task 2: 视觉答案提取 AI 接口

**Files:**
- Create: `src/lib/ai/exam-answer-extraction.ts`
- Create: `src/lib/ai/prompts/exam-answer-extraction.ts`
- Modify: `src/lib/ai/prompts/index.ts`
- Modify: `src/lib/ai/prompt-requests.ts`
- Modify: `src/lib/ai/types.ts`
- Modify: `src/lib/ai/base-provider.ts`
- Modify: `src/lib/ai/minimax-code-provider.ts`
- Modify: `src/lib/ai/index.ts`
- Modify: `src/lib/ai/routing.ts`
- Modify: `src/__tests__/unit/ai/base-provider.test.ts`
- Modify: `src/__tests__/unit/ai-prompts.test.ts`
- Modify: `src/__tests__/unit/ai-routing.test.ts`
- Create: `src/__tests__/unit/ai/exam-answer-extraction.test.ts`

**Interfaces:**
- Produces `ExamPageAnswerExtractionInput`:
  `imageBase64`、`mimeType`、`questions: { id, displayNumber, sourceShortId, questionText }[]`、`language`。
- Produces `ExamPageAnswerCandidate`:
  `{ sourceShortId: string | null; displayNumber: number | null; recognizedAnswer: string | null; notAttempted: boolean; confidence: number; regions: { x; y; width; height }[] }`。
- Produces `parseExamPageAnswerExtraction(text): { candidates: ExamPageAnswerCandidate[] }`、`generateExamAnswerExtractionRequest(input)` 和 `AIService.extractExamPageAnswers(input)`；补全任务名固定为 `exam-answer-extraction`，路由角色固定为 `vision`。

- [ ] **Step 1: 写解析/提示词/Provider 失败测试**：接受 fenced JSON；裁剪坐标到 `0..1`、置信度到 `0..1`、答案到 20,000 字、候选到 100 条、每题区域到 4 个；拒绝无对象/无数组响应；断言题干只在 `data.questions` 且每题截到 160 字；断言图片随请求发送且 completion task 正确；断言路由到视觉渠道。
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/unit/ai/exam-answer-extraction.test.ts src/__tests__/unit/ai/base-provider.test.ts src/__tests__/unit/ai-prompts.test.ts src/__tests__/unit/ai-routing.test.ts`**，确认接口缺失而失败。
- [ ] **Step 3: 实现提示词、严格 Zod 解析和 BaseAIProvider 方法**；提示词明确学生书写是数据而非指令，只提取可见内容，不评分、不补答案；所有 Provider 继续只负责传输，MiniMax 包装器仅转发新方法。
- [ ] **Step 4: 重跑目标测试**，确认视觉路由、数据消息隔离、解析上限和错误分类通过。
- [ ] **Step 5: 提交**：`feat: 新增试卷手写答案视觉提取接口`

### Task 3: 候选匹配、复核与分数纯函数

**Files:**
- Create: `src/lib/exam/exam-attempt.ts`
- Create: `src/__tests__/unit/exam-attempt.test.ts`

**Interfaces:**
- Produces `EXAM_ANSWER_REVIEW_CONFIDENCE = 0.80`。
- Produces `ExamAttemptPageRecognition` v1 信封：`{ version: 1; status: 'succeeded' | 'failed'; candidates; errorCode: string | null; completedAt: string }`，每个候选增加服务端生成的 `candidateId`。
- Produces `parseAttemptPageRecognition(raw)`、`serializeAttemptPageRecognition(value)`、`buildAttemptPageRecognition(pageOrder, extraction, completedAt)`。
- Produces `matchExamAnswerCandidates(candidates, questions)`，结果含 `matches`、`unmatchedCandidateIds`、`conflictingCandidateIds`、`missingQuestionIds`。
- Produces `requiresExamAnswerReview(input)`、`suggestExamAnswerScore(result, maxScore)`、`summarizeExamAttemptScores(answers)` 和 `parseAttemptRegionJson(raw)`。

- [ ] **Step 1: 写失败测试**：短 ID 完全匹配优先；仅短 ID 缺失时允许唯一连续题号回退；短 ID/题号指向不同题、同题多候选、未知短 ID均不匹配；候选 ID 在相同输入下稳定；低于 0.80、`solution|reading|writing|other`、无标准答案/满分、判分失败和未作答均要求复核；正确得满分、错误/未作答得 0、汇总保留一位小数；坏 JSON/非法区域返回安全空值；区域 JSON 保留可空 `candidateId`。
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/unit/exam-attempt.test.ts`**，确认模块不存在而失败。
- [ ] **Step 3: 实现纯函数**；候选 ID 使用页序和规范化内容的确定性摘要，仅在内容完全重复时追加重复序号，不做题干模糊匹配；解析未知信封版本时返回 `null`。
- [ ] **Step 4: 重跑单测**，确认全部通过且模块不导入 Prisma、Node-only 或浏览器对象。
- [ ] **Step 5: 提交**：`feat: 新增纸质作答匹配与复核规则`

### Task 4: 作答创建、详情与页面上传 API

**Files:**
- Create: `src/lib/schemas/exam-attempt.ts`
- Create: `src/app/api/exams/[id]/attempts/route.ts`
- Create: `src/app/api/exam-attempts/[id]/route.ts`
- Create: `src/app/api/exam-attempts/[id]/pages/route.ts`
- Create: `src/__tests__/integration/exam-attempts.test.ts`

**Interfaces:**
- Produces `createExamAttemptSchema`：`takenAt` 为带 offset datetime，`comment` 最长 500 字。
- Produces `upsertExamAttemptPagesSchema`：1～20 个现有 `importedExamPageSchema.omit({ role: true })` 页面和 `expectedUpdatedAt`。
- Produces `GET/POST /api/exams/:id/attempts`、`GET /api/exam-attempts/:id?includePages=1`、`POST /api/exam-attempts/:id/pages`。
- 所有写接口响应返回新的 `updatedAt`；详情默认只返回页元数据，`includePages=1` 才返回 `imageData`。

- [ ] **Step 1: 写失败集成测试**：只有本人 `ready` 试卷可创建；列表按 `takenAt desc` 且不含页图；详情隔离他人数据；上传校验真实 MIME/尺寸/checksum、拒绝重复 checksum 和超过 20 页；替换页时仅清除该页 `reviewStatus!='reviewed'` 的答案，`reviewed` 的人工答案/评分/状态保留但清除已失效的区域与候选引用；过期 `expectedUpdatedAt` 与 `confirmed` 均返回 409。
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/integration/exam-attempts.test.ts`**，确认路由不存在而失败。
- [ ] **Step 3: 实现 schema 和三个路由**；复用 `validateExamPageImages` 顺序解码；上传事务用 `updateMany({ id, userId, updatedAt: expectedUpdatedAt, status: { not: 'confirmed' } })` 获取乐观锁，替换页时清空该页 `recognitionResult`。
- [ ] **Step 4: 重跑目标测试并运行 `npx vitest run src/__tests__/integration/exam-import.test.ts`**，确认页面校验复用且整卷导入无回退。
- [ ] **Step 5: 提交**：`feat: 新增纸质试卷作答与页面接口`

### Task 5: 按页识别、逐题判分与部分失败恢复

**Files:**
- Create: `src/lib/exam/exam-attempt-recognition.ts`
- Create: `src/app/api/exam-attempts/[id]/recognize/route.ts`
- Create: `src/__tests__/integration/exam-attempt-recognition.test.ts`

**Interfaces:**
- Produces `recognizeExamAttemptPages(input: { attemptId; user; pageOrders; language; expectedUpdatedAt; replaceReviewed?: boolean }): Promise<{ successes; failures; status; updatedAt }>`。
- `successes` 每项包含 `pageOrder`、`candidateCount`、`matchedCount`；`failures` 每项包含 `pageOrder`、稳定错误码。
- Produces `POST /api/exam-attempts/:id/recognize`，使用 `withRecoverableResponse(withUser(...))`；一次用户操作只调用一次 `consumeAiQuota(user, 'grade')`，提取和逐题判分均使用同一个 `getAIService({ userId, kind: 'grade' })`。

- [ ] **Step 1: 写失败集成测试**：两页一成一败仍保存成功页信封；匹配成功题调用 `gradeAnswer`，`not_attempted` 和缺标准答案不调用；未识别题补 `required` 占位；低置信度/主观题为 `required`；失败重试不删旧成功草稿；AI 返回期间替换页、人工 PATCH 或确认时迟到结果被拒绝；默认不覆盖 `reviewed`，只有 `replaceReviewed=true` 才替换；日志断言不含图片和答案全文。
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/integration/exam-attempt-recognition.test.ts`**，确认编排器/路由缺失而失败。
- [ ] **Step 3: 实现识别编排**：开始时乐观锁转 `recognizing`；每页传全卷最多 100 题的短 ID、`order` 和 160 字摘要；页提取后使用 Task 3 确定性匹配；逐题判分独立捕获错误；每页事务复检 attempt 状态、页 checksum 和调用前 `updatedAt`，再保存信封与非人工答案。
- [ ] **Step 4: 重跑目标测试**，确认最终有任一可复核结果为 `review`、全部失败为 `failed`，进程重启遗留的 `recognizing` 可由新请求重试。
- [ ] **Step 5: 提交**：`feat: 新增纸质作答识别与判分流程`

### Task 6: 确认事务与错题复用领域逻辑

**Files:**
- Create: `src/lib/question/question-write.ts`
- Modify: `src/lib/question/question-save.ts`
- Modify: `src/lib/question/question-deduplication.ts`
- Create: `src/lib/exam/exam-results.ts`
- Modify: `src/lib/exam/exam.ts`
- Create: `src/lib/exam/exam-attempt-image.ts`
- Create: `src/lib/exam/exam-attempt-confirm.ts`
- Modify: `src/__tests__/integration/question-save-hooks.test.ts`
- Modify: `src/__tests__/integration/exams.test.ts`
- Create: `src/__tests__/unit/exam-attempt-image.test.ts`
- Create: `src/__tests__/integration/exam-attempt-confirm.test.ts`

**Interfaces:**
- Produces `createErrorItemInTransaction(tx: Prisma.TransactionClient, user: User, body: ImportQuestionInput, context: { gradeSemester: string | null; resolvedPaperLevel: string | null; extraErrorItemData?: Partial<Prisma.ErrorItemUncheckedCreateInput> }): Promise<SavedQuestionItem>`：只创建新错题，不创建 `PracticeRecord`；现有 `saveQuestion` 继续在同一判重事务调用它，外部行为不变。
- Produces `createExamPracticeRecord(tx: Prisma.TransactionClient, input: { userId: string; errorItemId: string | null; examQuestionId: string; examAttemptId?: string | null; result: 'correct' | 'wrong' | 'not_attempted'; takenAt: Date; difficulty: string | null; subject: string | null; questionText: string | null; answerText: string | null; analysis: string | null; wrongAnswerText?: string | null; originalImageUrl?: string | null; figureSvg?: string | null }): Promise<PracticeRecord>`：统一写入 `source='exam'` 的题目快照；`examAttemptId` 可空，现有手工录入路径保持可多次记录。
- Produces `cropAttemptAnswerImage(imageData, mimeType, regionJson): Promise<string>`；1～4 个合法区域取联合外接矩形裁图，空区域、解码失败或越界时返回原整页 data URL。
- Produces `confirmExamAttempt(input: { attemptId; user; expectedUpdatedAt }): Promise<{ summary; affectedErrorItemIds }>`；事务内返回结果，掌握度调度由路由在提交后执行。

- [ ] **Step 1: 先写现有逻辑保护测试**：`saveQuestion` 新题、重复题和钩子行为不变；`recordExamResults` 请求/响应与可多次录入行为不变；运行目标测试确认基线通过。
- [ ] **Step 2: 写新失败测试**：缺题目记录、`required` 未复核、空结果/分值越界/满分缺失拒绝确认；正确外部题创建 `errorItemId=null` 的记录；错误/未作答外部题创建或判重复用错题、裁图并回写 `ExamQuestion.errorItemId`；已有错题直接复用；事务中任一步失败全部回滚；重复/并发确认计数不增加；人工部分分进入汇总；仅受影响错题 ID 返回调度。
- [ ] **Step 3: 运行 `npx vitest run src/__tests__/unit/exam-attempt-image.test.ts src/__tests__/integration/exam-attempt-confirm.test.ts`**，确认领域模块缺失而失败。
- [ ] **Step 4: 抽取共享写入并实现确认事务**；确认以数据库中所有 `ready` 题和答案重算总分，不信任客户端；用 `PracticeRecord(examAttemptId, examQuestionId)` 唯一约束兜底幂等；判重复用 `findDuplicateQuestion`，但不调用会额外写 `duplicate_import` 的 `recordDuplicateQuestion`。
- [ ] **Step 5: 运行新旧测试 `npx vitest run src/__tests__/integration/question-save-hooks.test.ts src/__tests__/integration/exams.test.ts src/__tests__/unit/exam-attempt-image.test.ts src/__tests__/integration/exam-attempt-confirm.test.ts`**，确认全部通过后提交：`feat: 新增纸质作答确认事务`

### Task 7: 人工修正、候选映射、重判与确认 API

**Files:**
- Modify: `src/lib/schemas/exam-attempt.ts`
- Create: `src/app/api/exam-attempts/[id]/answers/[answerId]/route.ts`
- Create: `src/app/api/exam-attempts/[id]/confirm/route.ts`
- Create: `src/__tests__/integration/exam-attempt-review.test.ts`

**Interfaces:**
- Produces `updateExamAttemptAnswerSchema`：可更新 `recognizedAnswer`、`result`、`awardedScore`、`maxScore`、`gradingReason`；可选 `candidateRef: { pageOrder; candidateId }`、`regrade`、`expectedUpdatedAt`。
- Produces `confirmExamAttemptSchema`：只含 `expectedUpdatedAt`。
- Produces `PATCH /api/exam-attempts/:id/answers/:answerId` 和 `POST /api/exam-attempts/:id/confirm`。

- [ ] **Step 1: 写失败集成测试**：只能改本人未确认作答且答案必须属于该作答；得分范围和一位小数校验；候选必须来自本作答页且不能同时映射给另一题；映射复制答案/区域/置信度；手工保存写 `manual/reviewed`；重判调用一次额度检查和 `gradeAnswer`，但保留 `reviewStatus='required'`；确认后拒绝修改；确认成功后才调度掌握度；重复确认返回相同摘要。
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/integration/exam-attempt-review.test.ts`**，确认路由缺失而失败。
- [ ] **Step 3: 实现 PATCH 与 confirm 路由**；PATCH 和 AI 返回后的写入都检查 `expectedUpdatedAt`；候选映射从持久化信封读取，不接受客户端伪造内容；confirm 调用 Task 6 领域函数并在事务提交后 `scheduleMasteryEvaluation`。
- [ ] **Step 4: 重跑任务 4～7 集成测试**，确认权限、状态机、并发和幂等全部通过。
- [ ] **Step 5: 提交**：`feat: 新增纸质作答人工复核接口`

### Task 8: 回传入口、照片上传和作答历史界面

**Files:**
- Create: `src/lib/exam/exam-attempt-client.ts`
- Create: `src/lib/hooks/use-exam-attempt-upload.ts`
- Create: `src/components/exam-attempt/exam-attempt-upload-form.tsx`
- Create: `src/app/exams/[id]/attempts/new/page.tsx`
- Modify: `src/app/exams/[id]/page.tsx`
- Modify: `src/types/api.ts`
- Modify: `src/lib/i18n/zh.ts`
- Modify: `src/lib/i18n/en.ts`
- Create: `src/__tests__/unit/exam-attempt-client.test.ts`
- Create: `src/__tests__/unit/exam-attempt-upload-form.test.tsx`
- Modify: `src/__tests__/unit/exam.test.ts`

**Interfaces:**
- Consumes: `prepareImage`、`renderRegion`、现有 `PagePreviewList` 和任务 4/5 API。
- Produces `prepareExamAttemptPhotos(files, deps)`、`createAndRecognizeExamAttempt(input, deps)`、`useExamAttemptUpload` 与 `/exams/:id/attempts/new`。
- 试卷详情为 `ready` 试卷显示“回传纸质作答”，并列出作答日期、状态、分数和继续复核链接。

- [ ] **Step 1: 写失败测试**：只接受 1～20 张图片，不接受 PDF；按选择顺序方向校正、压缩和重新排序；先创建作答再上传、识别，部分失败仍跳转复核页；重复点击时按钮禁用；试卷非 `ready` 不显示入口；历史摘要不加载 Base64 页图。
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/unit/exam-attempt-client.test.ts src/__tests__/unit/exam-attempt-upload-form.test.tsx src/__tests__/unit/exam.test.ts`**，确认客户端与页面缺失而失败。
- [ ] **Step 3: 实现客户端纯流程、hook、移动优先表单和详情入口**；文件 input 使用 `accept="image/*" multiple capture="environment"`，复用预览排序组件；请求保存并传递服务端返回的最新 `updatedAt`。
- [ ] **Step 4: 补齐 `t.examAttempt` 中英文 key 并重跑组件、翻译和既有试卷 UI 测试**：`npx vitest run src/__tests__/unit/exam-attempt-client.test.ts src/__tests__/unit/exam-attempt-upload-form.test.tsx src/__tests__/unit/exam.test.ts src/__tests__/unit/translations.test.ts`。
- [ ] **Step 5: 提交**：`feat: 新增纸质试卷照片回传入口`

### Task 9: 移动端复核与确认界面

**Files:**
- Create: `src/lib/hooks/use-exam-attempt-review.ts`
- Create: `src/components/exam-attempt/attempt-region-preview.tsx`
- Create: `src/components/exam-attempt/attempt-answer-card.tsx`
- Create: `src/components/exam-attempt/unmatched-candidates.tsx`
- Create: `src/components/exam-attempt/exam-attempt-review.tsx`
- Create: `src/app/exam-attempts/[id]/page.tsx`
- Modify: `src/types/api.ts`
- Modify: `src/lib/i18n/zh.ts`
- Modify: `src/lib/i18n/en.ts`
- Create: `src/__tests__/unit/exam-attempt-review.test.tsx`

**Interfaces:**
- Consumes: 任务 4 详情、任务 5 重试、任务 7 PATCH/confirm API。
- Produces: 按题号的复核卡、只读区域预览、未匹配候选映射、单题重判、单页重试、手工部分分和整卷确认流程。

- [ ] **Step 1: 写失败组件测试**：`required` 数量和总分摘要；区域预览正确定位且非法区域显示整页；答案/结果/满分/得分/备注编辑；候选映射目标选择且已用候选禁用；重试页不覆盖本地已保存人工结果；所有 `required` 未完成时禁用确认并显示具体缺项；确认成功跳回试卷详情；API 409 时刷新而非覆盖。
- [ ] **Step 2: 运行 `npx vitest run src/__tests__/unit/exam-attempt-review.test.tsx`**，确认组件缺失而失败。
- [ ] **Step 3: 实现 hook 与组件**；页面用 `includePages=1` 一次加载回传图，卡片按需显示；底部操作栏固定且适配移动端；不提供拖拽框选；所有写入串行并更新 `expectedUpdatedAt`。
- [ ] **Step 4: 补齐中英文文案并运行 `npx vitest run src/__tests__/unit/exam-attempt-review.test.tsx src/__tests__/unit/translations.test.ts`**，再运行 `npm run lint` 确认零警告。
- [ ] **Step 5: 提交**：`feat: 新增纸质作答复核与确认界面`

### Task 10: 端到端、评测工具、文档与整批验证

**Files:**
- Create: `e2e/exam-attempt.spec.ts`
- Modify: `e2e/support/mock-ai.mjs`
- Modify: `src/__tests__/unit/e2e-mock-ai.test.ts`
- Create: `scripts/evaluate-exam-answer-extraction.mjs`
- Create: `doc/EXAM_ANSWER_EVALUATION.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `doc/E2E_MOCK_AI_TEST_DESIGN.md`

**Interfaces:**
- Consumes: Tasks 1～9 完整流程。
- Produces: 可重复的“打印卷回传→部分失败→重试→人工复核→确认→备份恢复”E2E 证据；本地评测脚本读取不入库的 JSON manifest 和图片路径，输出匹配/答案准确率报告到调用者指定位置。

- [ ] **Step 1: 扩展 mock AI 并写失败 E2E**：两页照片第一轮一成一败；重试后出现低置信度客观题、主观题、未匹配候选；人工映射并给部分分；确认前断言 `ErrorItem`/`PracticeRecord`/掌握度未变化，确认后断言总分、每题记录、错题回写和正确题不建错题；重复确认计数不增；导出 v13 并恢复候选与作答。
- [ ] **Step 2: 运行 `npm run test:e2e -- e2e/exam-attempt.spec.ts`**，确认新场景尚未支持而失败。
- [ ] **Step 3: 实现评测脚本和文档**：manifest 至少包含 `image`、`paperId`/候选题、期望题目 ID 和标准化答案；报告分别计算“题目匹配正确率”和“匹配且答案完全一致率”；文档明确至少 60 道、覆盖数学/语文/英语和不同书写质量，样本含儿童数据时不得提交仓库；95% 是推荐 Provider/模型目标而非所有 Provider 的 CI 门槛。
- [ ] **Step 4: 更新中英文 README 与 E2E 设计**，说明直接在打印卷作答、AI 两阶段处理、必须人工确认、数据/照片/候选保存在本地、备份 v13、无需 Python OCR。
- [ ] **Step 5: 运行整批验证**：
  `npm run lint`；
  `npx tsc --noEmit`；
  `npm run test:unit`；
  `DEBUG=prisma:* RUST_LOG=debug npm run test:integration`；
  `DEBUG=prisma:* RUST_LOG=debug npm test`；
  `npm run test:e2e -- e2e/exam-attempt.spec.ts e2e/exam-import.spec.ts e2e/exams.spec.ts e2e/data-backup.spec.ts`；
  `git diff --check`；
  `rg -n "npmmirror" package-lock.json` 应无结果；
  检查工作区未包含真实儿童照片、API Key 或评测输出。全部通过后提交：`test: 完善纸质作答回传验收覆盖`
