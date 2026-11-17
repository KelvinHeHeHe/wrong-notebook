# 家庭考试与纸质回传数据模型

> 状态：已实现。
> 数据源：当前 `prisma/schema.prisma`、正式迁移和备份 v13。
> 原则：复用 `ExamPaper` / `ExamQuestion`，只做兼容旧数据的增量迁移。

## 1. 当前关系

```text
User
 ├─ ErrorItem ── PracticeRecord
 └─ ExamPaper
     ├─ ExamPaperPage
     ├─ ExamQuestion ── ExamAttemptAnswer
     └─ ExamAttempt
         ├─ ExamAttemptPage
         └─ ExamAttemptAnswer

PracticeRecord.examAttemptId ──(写入侧校验)──> ExamAttempt.id
```

`ExamPaper` 同时承载生成卷和外部整卷，`origin` 区分来源。`ExamAttempt` 表示同一试卷的一次真实作答；错误/未作答题在确认后才进入 `ErrorItem` 和 `PracticeRecord`。

## 2. 现有模型增量字段

### 2.1 `ExamPaper`

| 字段 | 当前类型/默认值 | 用途 |
| --- | --- | --- |
| `origin` | `String @default("generated")` | `generated` 生成卷；`imported` 外部整卷 |
| `subjectId` | `String?` | 主学科快照，用于管理和趋势 |
| `gradeSemester` | `String?` | 年级学期快照 |
| `examType` | `String?` | 单元、期中、期末、日常等类型 |
| `examDate` | `DateTime?` | 考试日期 |
| `totalScore` | `Float?` | 标称满分 |
| `sourceFileName` | `String?` | 原始文件名，用于本地追溯 |

关系：`pages ExamPaperPage[]`、`attempts ExamAttempt[]`。`subjectId` 当前是快照列而非 Prisma 外键，以避免重建旧 SQLite 表；服务层负责校验用户与学科归属。索引为 `@@index([userId, createdAt])` 和 `@@index([subjectId])`。

### 2.2 `ExamQuestion`

| 字段 | 当前类型 | 用途 |
| --- | --- | --- |
| `externalNumber` | `String?` | 原卷题号，如 `2(1)` |
| `pageNumber` | `Int?` | 1 基原卷页码 |
| `regionJson` | `String?` | 归一化题目区域 |
| `recognitionConfidence` | `Float?` | 整卷识别置信度 |

既有题干、答案、解析、分值、题型、配图、留白和来源错题字段继续复用。`sourceShortId` 仍为非空快照；导入卷使用稳定本地值，不把它误解析为现有错题短 ID。

### 2.3 `PracticeRecord`

`examAttemptId String?` 保存确认来源作答 ID，但当前 Prisma Schema 不声明到 `ExamAttempt` 的关系。这是刻意的增量迁移取舍：避免 SQLite 重建旧表，归属与存在性由确认和备份导入写入侧校验。

相关索引：

- `@@index([examAttemptId])`
- `@@unique([examAttemptId, examQuestionId])`，防止同一次确认重复写同一题
- 既有 `examQuestion` 关系保留，删除试题时使用 `SetNull`

## 3. 已实现新模型

### 3.1 `ExamPaperPage`

保存外部整卷的本地页面快照：`paperId`、`order`、`role`、`imageData`、`mimeType`、尺寸、`checksum` 和时间戳。

- `paperId` 外键到 `ExamPaper`，删除试卷时级联。
- `@@unique([paperId, role, order])`
- `@@index([paperId, order])`

### 3.2 `ExamAttempt`

保存一次真实纸质作答：用户、试卷、状态、作答时间、得分/满分、备注、确认时间和时间戳。

- `userId`、`paperId` 均为级联外键。
- `@@index([userId, takenAt])` 支持用户成绩趋势。
- `@@index([paperId, takenAt])` 支持试卷作答历史。

### 3.3 `ExamAttemptPage`

保存回传页图：`attemptId`、页序、data URL、MIME、尺寸、校验和，以及 v13 新增的 `recognitionResult String?`。该 JSON 字段保存页级识别候选，使第二阶段题目匹配可复用已持久化候选，恢复后无需重新识别。

- `attemptId` 外键到 `ExamAttempt`，删除作答时级联。
- `@@unique([attemptId, order])`

### 3.4 `ExamAttemptAnswer`

保存 AI 识别后、人工确认前的逐题评分草稿：识别答案、结果、得分、评分来源/理由、置信度、复核状态和区域。

- `attemptId` 外键到 `ExamAttempt`，`examQuestionId` 外键到 `ExamQuestion`，均级联删除。
- `@@unique([attemptId, examQuestionId])`
- `@@index([attemptId, reviewStatus])`

## 4. 状态与写入不变量

外部试卷使用既有字符串状态并增加导入阶段语义：

```text
importing → review → ready
     └──────────────→ failed → importing
```

纸质作答状态：

```text
uploaded → recognizing → review → confirmed
                 └─────→ failed → recognizing
```

- 未确认作答不得写入学习历史或趋势。
- 已确认作答不能被 AI 识别覆盖。
- 每题得分必须在 0 与题目满分之间；总分由确认事务校验。
- 确认事务同时更新作答状态、创建/复用错题并写练习记录，失败整体回滚。
- `PracticeRecord.examAttemptId + examQuestionId` 提供数据库级幂等屏障；写入侧还校验作答、试卷、题目和用户属于同一数据边界。

## 5. 正式迁移

### `20261108090000_add_exam_attempts`

- 为 `ExamPaper`、`ExamQuestion`、`PracticeRecord` 增加可空列或安全默认列。
- 创建 `ExamPaperPage`、`ExamAttempt`、`ExamAttemptPage`、`ExamAttemptAnswer`。
- 创建外键、唯一索引和趋势/复核索引。
- 不删除、不重命名、不重写旧表数据；旧 `ExamPaper` 自动得到 `origin='generated'`。

### `20261108160000_add_attempt_page_recognition`

- 为 `ExamAttemptPage` 增加可空 `recognitionResult TEXT`。
- 旧作答页升级后该值为 `null`。

任务 06 的迁移特征测试在 `20261105135634_add_telemetry_tables` 处建立近端旧库，写入用户、学科、错题、旧试卷、题目和练习记录，再部署全部正式迁移，验证旧行保留、新集合为空、默认值和约束正确、重复部署幂等。测试只操作系统临时 SQLite。

## 6. 备份兼容

| 格式 | 考试数据能力 | 当前导入行为 |
| --- | --- | --- |
| v11 | 旧试卷/题目，不含新页面和作答集合 | 缺省 `origin='generated'`，新集合为空；可再导出为 v13 |
| v12 | 引入试卷元数据、页面、作答、逐题评分和 `examAttemptId` | 缺失 `recognitionResult` 时规范化为 `null`；可再导出为 v13 |
| v13 | 增加作答页级识别候选 | 当前完整往返格式 |

导入顺序保证依赖先于引用：用户/学科 → 试卷/题目 → 页/作答 → 作答页/逐题评分 → 练习记录。旧 ID 经现有映射重写；跨用户、跨试卷关联被跳过或拒绝。图片 data URL 与识别候选随本地 JSON 备份导出。

## 7. 本地图片与容量边界

MVP 继续使用“data URL 存 SQLite、备份 JSON 携带图片”，减少第一批部署复杂度。页面上传沿用 MIME、页数、尺寸、像素和压缩限制，并用 checksum 处理重复页。

代价是数据库、导出文件和导入内存峰值会随页图线性增长。当前设置页把整份 JSON 一次提交，导入接口对 `Content-Length` 超过 50 MiB 的请求返回 400，导出端没有对称上限；现有自动化只验证远低于该上限的小型夹具。因此家庭积累的合法大备份可能可以导出、却无法通过设置页恢复。达到该规模前应使用[实例级备份恢复](../doc/wiki/Backup-and-Restore.md)；第二批再增加导出体积预警，或把 `imageData` 抽象成受控应用数据目录的 `storageKey` 并使用 ZIP + manifest 备份。
