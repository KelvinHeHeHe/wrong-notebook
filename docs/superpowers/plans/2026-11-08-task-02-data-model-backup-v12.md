# Task 02 Data Model and Backup v12 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the local exam-page and paper-attempt persistence needed by the approved MVP, and preserve it through backup v12 without changing existing product flows.

**Architecture:** Extend `ExamPaper`, `ExamQuestion`, and `PracticeRecord` additively; create four new page/attempt tables with foreign keys. Export the new entities as top-level v12 collections, normalize missing v11 data to safe defaults, and restore in dependency order with old-to-new ID maps.

**Tech Stack:** Prisma 5.22, SQLite, Next.js route handlers, TypeScript, Vitest.

**Spec:** `/Users/example/projects/wrong-notebook/docs/DATA_MODEL.md` and `/Users/example/projects/wrong-notebook/docs/MVP_PLAN.md` (Task 02 only).

## Global Constraints

- Use the existing Next.js/TypeScript/Prisma/SQLite stack and existing backup architecture.
- Migration is additive only: `ADD COLUMN`, `CREATE TABLE`, and `CREATE INDEX`; no table rebuild, drop, destructive enum conversion, or old-row rewrite.
- Preserve v1–v11 import compatibility; v11 defaults to `origin='generated'` and empty new collections.
- New core entities and images must round-trip in backup v12.
- Do not implement exam-import, recognition, attempt-confirmation, UI, or trend APIs in this batch.
- Every behavior change follows RED→GREEN TDD and the full existing suite must remain green.

## Review Focus

- A v11 backup with no new fields must restore an existing generated paper without pages or attempts.
- A v12 backup containing an attempt answer whose question belongs to another paper must not create a cross-paper association.
- Re-importing the same v12 backup must not duplicate paper pages, attempts, attempt pages, attempt answers, or attempt-linked practice records.
- Invalid scores, confidence values, page roles, states, dates, and image metadata must normalize to safe values or be skipped without aborting unrelated valid rows.
- An old SQLite database with populated papers, questions, and practice records must upgrade without losing or rewriting those values.

---

### Task 1: Additive Prisma schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261108090000_add_exam_attempts/migration.sql`
- Modify: `src/__tests__/integration/database-migrations.test.ts`

**Interfaces:**
- Consumes: existing `User`, `Subject`, `ExamPaper`, `ExamQuestion`, and `PracticeRecord` IDs.
- Produces: Prisma models `ExamPaperPage`, `ExamAttempt`, `ExamAttemptPage`, `ExamAttemptAnswer`; scalar fields documented in `DATA_MODEL.md`; `PracticeRecord.examAttemptId` uniqueness per exam question.

- [ ] **Step 1: Write the failing migration tests**

Add behavior tests that deploy all migrations and assert:

- `ExamPaper.origin` defaults to literal `generated`, with the six nullable metadata columns present.
- `ExamQuestion` has `externalNumber`, `pageNumber`, `regionJson`, and `recognitionConfidence`.
- `PracticeRecord` has `examAttemptId` and a unique index covering `examAttemptId, examQuestionId`.
- All four new tables and their unique/query indexes exist; `PRAGMA foreign_key_check` is empty.
- A populated pre-migration database keeps its existing rows byte-for-byte except for the documented new defaults/null columns.

- [ ] **Step 2: Run the migration test and verify RED**

Run: `RUST_LOG=info TELEMETRY_DISABLED=false npx vitest run src/__tests__/integration/database-migrations.test.ts`

Expected: FAIL because the new columns/tables are absent.

- [ ] **Step 3: Implement the schema and additive SQL**

Use nullable scalar references on the two existing tables where SQLite cannot add a foreign key without rebuilding; create real foreign keys on all new tables. Add only the indexes needed by page uniqueness, attempt history, review filtering, and attempt-linked practice idempotency.

- [ ] **Step 4: Verify GREEN and validate Prisma**

Run: `RUST_LOG=info TELEMETRY_DISABLED=false npx vitest run src/__tests__/integration/database-migrations.test.ts`

Expected: all migration tests PASS.

Run: `DATABASE_URL=file:/tmp/wrong-notebook-task02-validate.db npx prisma validate`

Expected: schema valid.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261108090000_add_exam_attempts/migration.sql src/__tests__/integration/database-migrations.test.ts
git commit -m "feat: add exam attempt data model"
```

### Task 2: Define and export backup v12

**Files:**
- Modify: `src/lib/backup/format.ts`
- Modify: `src/lib/backup/import-parser.ts`
- Modify: `src/app/api/export/route.ts`
- Modify: `src/__tests__/unit/backup-format.test.ts`
- Modify: `src/__tests__/unit/backup-import-parser.test.ts`
- Modify: `src/__tests__/integration/data-backup.test.ts`

**Interfaces:**
- Consumes: Task 1 Prisma models and columns.
- Produces: `BACKUP_VERSION = 12`; typed top-level `examPaperPages`, `examAttempts`, `examAttemptPages`, `examAttemptAnswers`; normalized collections for the writer.

- [ ] **Step 1: Write failing format/default/export tests**

Tests must assert literal v12 output, all new metadata and page/attempt fields, and v11 normalization to `origin='generated'` plus empty new collections. Add invalid-value cases for role/status, finite scores/confidence, dates, and dimensions.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `RUST_LOG=info TELEMETRY_DISABLED=false npx vitest run src/__tests__/unit/backup-format.test.ts src/__tests__/unit/backup-import-parser.test.ts src/__tests__/integration/data-backup.test.ts`

Expected: FAIL because v12 structures and export queries do not exist.

- [ ] **Step 3: Implement types, normalization, and export**

Keep v12 collections top-level. Export only records owned by the selected user(s), order pages/answers deterministically, preserve local image data and checksums, and avoid exporting credentials or AI usage records.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command.

Expected: all focused tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backup/format.ts src/lib/backup/import-parser.ts src/app/api/export/route.ts src/__tests__/unit/backup-format.test.ts src/__tests__/unit/backup-import-parser.test.ts src/__tests__/integration/data-backup.test.ts
git commit -m "feat: export exam data in backup v12"
```

### Task 3: Restore backup v12 with ownership and idempotency

**Files:**
- Modify: `src/lib/backup/import-writer/types.ts`
- Modify: `src/lib/backup/import-writer/index.ts`
- Modify: `src/lib/backup/import-writer/exams.ts`
- Modify: `src/lib/backup/import-writer/practice.ts`
- Create: `src/lib/backup/import-writer/attempts.ts`
- Modify: `src/__tests__/integration/data-backup.test.ts`

**Interfaces:**
- Consumes: Task 2 `NormalizedImportData` collections.
- Produces: `examAttemptIdMap`/owner map and restored pages, attempts, answers, and `PracticeRecord.examAttemptId` links.

- [ ] **Step 1: Write failing round-trip, v11, re-import, and isolation tests**

Create a paper with question page, confirmed attempt, return page, answer, and attempt-linked practice record. Assert full export → clear → import preservation. Re-import and assert no duplicate new entities. Mutate a fixture so an answer targets another paper's question and assert it is skipped while valid rows survive. Import a v11-shaped fixture and assert generated origin with no new rows.

- [ ] **Step 2: Run integration test and verify RED**

Run: `RUST_LOG=info TELEMETRY_DISABLED=false npx vitest run src/__tests__/integration/data-backup.test.ts`

Expected: FAIL because the writer does not restore v12 entities or attempt links.

- [ ] **Step 3: Implement dependency-ordered import**

Restore paper pages after papers/questions; attempts after papers; attempt pages/answers after attempts; practice records last. Reuse mapped existing rows on re-import, verify target ownership and paper/question consistency, and skip invalid references rather than creating dangling rows.

- [ ] **Step 4: Run integration test and verify GREEN**

Run the Step 2 command.

Expected: all data-backup integration tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backup/import-writer src/__tests__/integration/data-backup.test.ts
git commit -m "feat: restore exam data from backup v12"
```

### Task 4: Whole-batch verification and documentation alignment

**Files:**
- Modify if findings require: files changed by Tasks 1–3 only.
- Verify against: `/Users/example/projects/wrong-notebook/docs/DATA_MODEL.md`

**Interfaces:**
- Consumes: completed schema and backup v12 implementation.
- Produces: a verified Task 02 branch with no Task 03+ product behavior.

- [ ] **Step 1: Run generated-client, formatting, and focused safety checks**

Run: `DATABASE_URL=file:/tmp/wrong-notebook-task02-validate.db npx prisma generate`

Run: `npm run lint`

Run: `RUST_LOG=info TELEMETRY_DISABLED=false npx vitest run src/__tests__/integration/database-migrations.test.ts src/__tests__/unit/backup-format.test.ts src/__tests__/unit/backup-import-parser.test.ts src/__tests__/integration/data-backup.test.ts`

Expected: every command exits 0.

- [ ] **Step 2: Run the full regression suite**

Run: `RUST_LOG=info TELEMETRY_DISABLED=false npm test`

Expected: all test files and tests PASS with zero failures.

- [ ] **Step 3: Inspect migration and branch diff**

Verify no table/column deletion, no unrelated business changes, and no generated database, secret, report, or runtime file is tracked.

- [ ] **Step 4: Commit verification-only fixes if any**

```bash
git add <only-task-02-files>
git commit -m "test: verify backup v12 migration"
```
