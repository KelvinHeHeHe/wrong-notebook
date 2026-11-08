# 任务 04：纸质练习回传与确认设计

> 日期：2026-11-08
> 状态：已确认
> 前置：任务 02 数据模型与备份 v12、任务 03 考试管理与整卷导入已完成
> 使用方式：孩子直接在系统打印的试卷题目页上作答，家长按页拍照回传

## 1. 意图与范围

任务 04 在现有试卷上补齐“打印作答 → 拍照回传 → AI 提取答案 → AI 建议判分 → 家长复核 → 确认入账”的闭环。

本任务服务家庭场景，核心不是无人值守自动批卷，而是用 AI 减少家长录入工作，同时保证任何不确定结果在改变错题历史、掌握度和成绩前都可人工纠正。

### 1.1 目标

- 支持对一张 `ready` 试卷创建一次真实纸质作答。
- 支持按实际拍摄顺序上传 1～20 张已作答试卷照片。
- 从每页照片提取题号/来源短 ID、学生答案、答案区域和置信度。
- 持久化未匹配、冲突和重复提取候选，允许家长在复核页手工映射到试卷题目。
- 对匹配成功且有标准答案的题目复用现有 `gradeAnswer` 进行第二阶段判分。
- 逐题展示原页区域、识别答案、标准答案、判定理由、置信度和分数，允许家长修正。
- 低置信度、主观题、未匹配题、缺标准答案和分数异常必须人工复核。
- 确认时一次事务写入作答成绩；错题和未作答题进入现有错题/练习历史并触发掌握度更新。
- 重复确认必须幂等，不能重复创建 `ErrorItem` 或 `PracticeRecord`。

### 1.2 非目标

- 不支持独立草稿纸、空白答题纸、固定答题卡或 OMR。
- 不从照片自动猜测属于哪张试卷；用户必须先进入试卷并创建作答。
- 不增加 Python OCR、消息队列、对象存储或云数据库。
- 不把 AI 判分直接视为最终成绩；用户必须执行整次确认。
- 不在本任务实现成绩趋势图，趋势属于任务 05。
- 不在已确认作答上重新运行 AI；后续更正需作为第二批带审计的显式流程。

## 2. 已选方案与备选方案

### 2.1 采用：两阶段识别与评分

第一阶段由视觉模型按回传页提取学生答案，第二阶段对每个已匹配答案调用现有 `gradeAnswer`。识别和判分分别保存失败原因并可分别重试。

优点：

- 能区分“手写答案识别错误”和“判分错误”。
- 复用现有 Provider、额度、判题提示词和错误分类。
- 单页或单题失败不丢失其他成功结果。
- 人工复核界面能直接修改识别答案后重新判分。

代价：AI 调用次数高于单次页级批改，但家庭试卷规模有限，可靠性和可解释性优先。

### 2.2 未采用：单次视觉调用同时提取并评分

每页一次调用即可得到答案和判定，调用较少；但题目匹配、手写识别与评分耦合，错误难定位，重试会覆盖更多人工结果，也难复用现有 `gradeAnswer`。

### 2.3 未采用：先增加本地 OCR 服务

传统 OCR 仍不能可靠完成小学手写答案、题号关联和语义判分，还会增加 Python 运行时与部署复杂度。现有多模态 Provider 已满足 MVP。

## 3. 关键设计约束

### 3.1 以打印标识匹配，不复用原始卷面坐标

任务 03 保存的 `ExamQuestion.regionJson` 是导入原卷上的区域；系统重新排版打印后坐标已经变化，不能用于回传定位。

现有打印页每题固定显示：

- 全卷连续题号；
- `sourceShortId` 来源短 ID。

视觉提取结果必须返回 `sourceShortId`、连续题号、学生答案、0～1 相对区域和置信度。服务端只做以下确定性匹配：

1. 来源短 ID 完全一致时匹配；
2. 短 ID缺失时，连续题号唯一且在范围内才匹配；
3. 两者指向不同题、重复匹配或无法唯一匹配时，不猜测；原始候选保存在对应回传页中，由家长在复核页选择目标题目。

不做模糊字符串匹配，避免把一个孩子的答案记到另一题。

### 3.2 逐页提取、逐题判分、部分成功保留

- 每个回传页独立调用视觉模型。
- 页级调用失败不删除该页已有草稿，也不影响其他页。
- 提取成功后，按匹配到的题目逐题调用 `gradeAnswer`。
- `not_attempted` 不调用判题模型，自动建议 0 分并标记为需复核。
- 缺少标准答案的题目不自动判分。
- 重试识别不得覆盖 `reviewStatus='reviewed'` 的人工结果；除非用户显式选择“用 AI 结果替换”。

### 3.3 主观题与置信度

默认阈值为 `0.80`。以下任一条件成立时 `reviewStatus='required'`：

- 提取置信度低于阈值；
- 题型为解答、证明、作文或其他开放题；
- 没有标准答案；
- 没有可用满分；
- 短 ID 与题号冲突、重复或无法匹配；
- AI 判分失败；
- 建议得分超出 `0..maxScore`；
- 全卷建议得分与逐题合计不一致。

高置信度客观题保存为 `pending`，表示已有 AI 建议、尚未单题人工确认；整卷确认可接受 `pending`，但所有 `required` 必须先变为 `reviewed`。

### 3.4 分数规则

现有 `gradeAnswer` 只返回布尔正确性：

- 正确：建议得分为本题 `maxScore`；
- 错误：建议得分为 0；
- 未作答：建议得分为 0；
- 部分分：仅由家长在复核页手工设置。

本题满分优先取 `ExamQuestion.score`。若为空，家长必须在确认前补充。`ExamAttempt.maxScore` 为所有逐题满分之和，`totalScore` 为所有逐题得分之和；确认时由服务端重新计算，不信任客户端汇总值。

## 4. 数据模型变更

任务 02 已提供以下模型：

- `ExamAttempt`：一次真实纸质作答，状态 `uploaded | recognizing | review | confirmed | failed`。
- `ExamAttemptPage`：回传页图、页序、MIME、尺寸和字节 checksum。
- `ExamAttemptAnswer`：逐题识别、评分和复核草稿。
- `PracticeRecord.examAttemptId + examQuestionId` 唯一约束：确认幂等的数据库兜底。

为避免 AI 漏配、错配结果在刷新页面或服务重启后丢失，给 `ExamAttemptPage` 增加一个最小持久字段：

- `recognitionResult String?`：JSON 信封，保存页级状态（`succeeded | failed`）、稳定候选 ID、标准化提取候选、错误码和完成时间；不保存提示词或模型原始自由文本。

这是一项核心数据结构变更，因此：

- 新增兼容已有数据的可空字段和正式 Prisma 迁移；
- 备份格式从 v12 升至 v13；
- 同步更新导入、导出和备份往返测试；
- 旧版备份导入时将该字段视为 `null`。

回传区域写入 `ExamAttemptAnswer.regionJson`，统一格式：

```json
{
  "pageOrder": 1,
  "candidateId": "candidate-id",
  "regions": [{ "x": 0.1, "y": 0.4, "width": 0.8, "height": 0.2 }]
}
```

`candidateId` 用于防止同一提取候选被人工映射给多道题；纯手工录入时可为 `null`。该字段仍为 JSON 字符串，不额外改变备份结构。

## 5. 状态机

```text
创建作答
   │
   ▼
uploaded ──上传/替换页──► uploaded
   │
   ├──开始识别──► recognizing ──有可复核结果──► review
   │                              └─全部失败──► failed
   │
   └───────────────────────────────────────────┐
                                               ▼
review ──单页重试/单题重判──► review ──确认──► confirmed
failed ──重试识别──────────► recognizing
```

`confirmed` 是终态。上传、识别、重判和普通 PATCH 均拒绝修改已确认作答。确认接口重复调用返回已有确认摘要，不再次写历史。

## 6. AI 扩展

### 6.1 新增页级答案提取方法

遵循现有 AI 约定，在 `BaseAIProvider` 增加统一业务方法，各 Provider 不复制业务逻辑：

```ts
extractExamPageAnswers(input: {
  imageBase64: string;
  mimeType: string;
  questions: Array<{
    id: string;
    displayNumber: number;
    sourceShortId: string;
    questionText: string;
  }>;
  language: 'zh' | 'en';
}): Promise<ExamPageAnswerExtractionResult>
```

新增内容集中在：

- `src/lib/ai/types.ts`：输入输出类型；
- `src/lib/ai/base-provider.ts`：唯一业务实现；
- `src/lib/ai/prompts/`：提示词；
- `src/lib/ai/prompt-requests.ts`：自由文本按数据消息传递；
- 独立解析模块：zod 严格解析并裁剪区域、置信度和长度；
- `CompletionTask` 增加 `exam-answer-extraction`。

AI 额度与用量记为 `kind='grade'`，通过 `getAIService({ userId, kind: 'grade' })` 取得服务，不在路由复制额度逻辑。

### 6.2 候选题控制

每页调用携带整卷候选题的短 ID、连续题号和最多 160 字题干摘要。最多 100 题；完整题干和标准答案不发送给视觉提取阶段，降低提示词体积。第二阶段只发送匹配到的单题全文、标准答案、解析和学生答案。

### 6.3 安全边界

- 回传照片和学生书写属于待处理数据，不能作为系统指令。
- 日志只记录页序、图片字节数、题数、错误码和耗时，不记录图片或学生答案全文。
- 所有模型输出均经 zod 解析；未知题目 ID、非法区域、非法置信度和超长文本被拒绝或标记复核。

## 7. API 设计

所有新路由使用 `withUser`；耗时识别路由外层使用 `withRecoverableResponse`。

### 7.1 `GET /api/exams/:id/attempts`

返回当前用户该试卷的作答摘要，按 `takenAt desc`：状态、得分、满分、确认时间和页数。默认不返回页图。

### 7.2 `POST /api/exams/:id/attempts`

输入：`takenAt`、可选 `comment`。只允许当前用户的 `ready` 试卷。创建 `uploaded` 作答并返回 `attemptId`。

### 7.3 `GET /api/exam-attempts/:id`

返回作答、试卷摘要、逐题草稿和页摘要。`?includePages=1` 仅供复核页加载 Base64 原图；其他详情不返回大字段。

### 7.4 `POST /api/exam-attempts/:id/pages`

输入 1～20 个浏览器已方向校正和压缩的 JPEG/PNG/WebP 页图。复用任务 03 的真实解码、MIME、像素、字节和 checksum 校验，并顺序解码控制内存。

- 同页序替换时删除该页尚未人工复核的识别草稿；
- 不覆盖其他页；
- checksum 重复返回冲突；
- 乐观锁防止上传请求与确认并发；
- `confirmed` 返回 409。

### 7.5 `POST /api/exam-attempts/:id/recognize`

输入：`pageOrders`、`language`。流程：

1. 校验作答归属、状态和页；
2. 乐观锁转为 `recognizing`；
3. 每页独立提取答案；
4. 服务端确定性匹配试卷题目；
5. 对已匹配答案执行第二阶段判分；
6. 事务保存每页标准化候选，upsert 非人工结果，并补齐未识别题目的 `required` 占位记录；
7. 返回逐页 successes/failures，最终状态为 `review` 或 `failed`。

AI 等待后在事务内复检 `status`、页 checksum 和 `updatedAt`，迟到结果不能覆盖确认或人工修改。

### 7.6 `PATCH /api/exam-attempts/:id/answers/:answerId`

允许家长更新：

- `recognizedAnswer`；
- `result`；
- `awardedScore`；
- `maxScore`；
- `gradingReason`（人工备注）。
- `candidateRef`（`pageOrder + candidateId`）：把未匹配候选映射到本题，并复制其识别答案、区域和置信度。

服务端校验答案属于当前用户、当前作答和同一试卷；得分在 `0..maxScore`。保存后写 `gradingSource='manual'`、`reviewStatus='reviewed'`。

可选 `regrade=true`：保存修正后的识别答案并重新调用现有 `gradeAnswer`，仍不自动标为人工复核完成。

### 7.7 `POST /api/exam-attempts/:id/confirm`

确认前校验：

- 状态不是 `confirmed` 之外的非法状态；
- 本卷每道 `ready` 题都有逐题记录；
- `required` 已全部变为 `reviewed`；
- 每题结果、得分和满分完整且合法；
- 服务端重算汇总。

确认事务：

1. 对每题创建带 `examAttemptId + examQuestionId` 的 `PracticeRecord`；
2. 已关联 `ErrorItem` 的题目直接复用；
3. 外部卷中做错/未作答且 `errorItemId=null` 的题目，按题干判重后创建或复用错题，并把回传区域裁图保存为 `originalImageUrl`；随后回写 `ExamQuestion.errorItemId`，供同一试卷后续作答复用；
4. 正确且没有 `ErrorItem` 的外部题仍创建 `errorItemId=null` 的 `PracticeRecord`，用于完整成绩历史和任务 05 趋势，但不创建错题，不污染错题本；
5. 写入 `totalScore`、`maxScore`、`confirmedAt` 和 `status='confirmed'`；
6. 事务提交后调度受影响错题的掌握度评估。

实现时从现有 `recordExamResults`、`question-save` 和判重逻辑抽取事务内可复用领域函数，避免服务端调用自身 HTTP，也避免重复题路径额外写一条 `duplicate_import` 记录。

## 8. 页面与交互

### 8.1 入口

- 试卷详情增加“回传纸质作答”按钮；仅 `ready` 试卷显示。
- 试卷详情增加作答历史摘要；已确认显示得分，草稿可继续复核。

### 8.2 上传页 `/exams/:paperId/attempts/new`

- 默认作答日期为今天，可填写备注。
- 选择 1～20 张照片，沿用任务 03 图片方向校正、压缩、排序和预览。
- 创建作答、上传页并开始识别；单页失败进入复核页并可重试。

### 8.3 复核页 `/exam-attempts/:id`

移动优先布局：

- 顶部显示试卷、日期、识别进度、建议总分和必须复核数量；
- 按题号排列卡片，显示回传页区域、题干摘要、识别答案、标准答案、AI 判定理由、置信度和分数；
- `required` 使用醒目状态，支持直接编辑与标记已复核；
- 单独列出未匹配/冲突候选，允许选择试卷题目完成映射；已使用候选不能重复映射，改映射需先解除原关联；
- 支持单页重试和单题重新判分；
- 固定底栏提供“保存草稿”和“确认成绩”。

确认按钮在客户端可提前提示缺项，但最终约束只由服务端决定。

## 9. 并发、幂等与故障恢复

- 创建、上传、识别、人工更新和确认均检查 `userId` 与试卷归属。
- 上传、识别和确认使用 `updatedAt` 乐观锁；AI 调用前后都复检。
- 唯一约束 `PracticeRecord(examAttemptId, examQuestionId)` 防止重复入账。
- 确认已完成时返回相同确认摘要，视为幂等成功。
- AI 页级失败保留成功页；判分失败只影响对应题。
- 进程重启后 `recognizing` 不自动继续；详情页检测悬挂状态并允许用户重试，MVP 不增加后台队列。

## 10. 测试与验收

### 10.1 单元测试

- 提取结果解析：短 ID、题号、区域、置信度、长度和重复项。
- 确定性匹配：短 ID优先、题号回退、冲突不猜测。
- 页级候选 JSON 的读写、错误兼容和手工映射唯一性。
- 主观题/低置信度复核规则。
- 分数计算、确认前不变量和 region JSON。
- 回传图片准备与页序。

### 10.2 集成测试

- 作答/页面/逐题 API 的用户隔离与状态机。
- 页级部分失败和重试不覆盖人工结果。
- 人工修正和重新判分。
- 确认事务回滚与重复确认幂等。
- 外部卷错题创建/复用、正确题不建错题。
- `PracticeRecord`、`ExamAttemptAnswer`、`ErrorItem` 关联正确。
- 确认后掌握度调度只包含受影响错题。
- 备份 v13 往返保留页级识别候选，且 v12 导入后该字段为空。

### 10.3 E2E

使用本地 mock AI 和真实 SQLite：

1. 创建一张可打印试卷并打印；
2. 上传两张模拟手写作答照片；
3. 第一页成功、第二页失败，确认成功结果保留；
4. 重试第二页；
5. 修正一个低置信度答案并给主观题部分分；
6. 确认前断言 `ErrorItem`、`PracticeRecord`、掌握度和趋势未变化；
7. 确认后断言分数、错题、练习记录和关联正确；
8. 重复确认，所有计数不增加；
9. 导出备份并验证本次作答数据及未匹配候选存在。

### 10.4 验收标准

- 回传照片只产生评分草稿，确认前不改变学习历史。
- 每题可查看答案区域并修改识别与评分；未匹配候选可人工映射。MVP 不提供拖拽框选，区域缺失或无效时创建错题使用整页图作为兜底。
- 所有低置信度与主观题必须复核。
- 确认重复提交无重复副作用，任一步失败不留下半份确认成绩。
- 将“正确题目匹配且标准化答案完全一致”作为客观题提取准确率口径；使用至少 60 道、覆盖数学/语文/英语及不同书写质量的本地样本生成评测报告，95% 是推荐 Provider/模型的产品目标，不作为所有可配置 Provider 的确定性 CI 门槛。低置信度或未匹配结果必须进入复核，不能静默误记。
- 不增加 Python 服务；全部图片、候选和成绩仍保存在本地 SQLite 并进入现有备份 v13。

## 11. 文档与兼容性

- 更新 `README.md`、`README.en.md` 和相关 `doc/` 页面。
- 中英文 UI 文案 key 同步。
- 不改变已有 `/api/exams/:id/results` 行为。
- 备份版本升级为 v13，仅新增 `ExamAttemptPage.recognitionResult`；旧版备份继续兼容导入。
