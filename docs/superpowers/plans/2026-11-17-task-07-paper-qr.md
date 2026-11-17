# 任务 07：纸质试卷二维码与稳定短码实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让打印试卷携带稳定短码、内容版次和二维码，扫码登录后安全进入该卷的纸质回传流程。

**Architecture:** `ExamPaper.printCode` 保存稳定身份；服务端对规范化可打印内容计算指纹；受鉴权 API 只解析当前用户的短码；打印页以内联 SVG 输出二维码；扫码页按版次一致性跳转或警告。备份升级为 v14，并保留 v11～v13 兼容。

**Tech Stack:** Next.js 16、React 19、TypeScript、Prisma 5、SQLite、Vitest、Playwright、`qrcode.react` 4.2.0。

**Spec:** `docs/superpowers/specs/2026-11-17-task-07-paper-qr-design.md`

## 全局约束

- 先写失败测试，再写最小实现；每项完成后运行定向测试。
- 只做增量迁移，不删除、重建或触碰真实 `prisma/dev.db`。
- 新路由使用 `withUser`，跨用户与不存在统一返回 404。
- 界面文案同步中英文；PC 与移动端都可用。
- 新字段同步备份格式、导出、导入和集成测试，版本从 13 升至 14。
- 不新增 Python OCR、匿名扫码、物理分页引擎或外部二维码服务。
- 依赖只从 npm 官方源安装，锁文件不得含 `npmmirror`。

---

### Task 1：建立打印身份数据层与备份 v14

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261117180000_add_exam_print_code/migration.sql`
- Create: `src/lib/exam/exam-print-identity.ts`
- Modify: `src/lib/exam/exam.ts`
- Modify: `src/app/api/exams/import/route.ts`
- Modify: `src/lib/backup/format.ts`
- Modify: `src/app/api/export/route.ts`
- Modify: `src/lib/backup/import-parser.ts`
- Modify: `src/lib/backup/import-writer/exams.ts`
- Modify: `src/__tests__/unit/exam-print-identity.test.ts`
- Modify: `src/__tests__/integration/data-backup.test.ts`
- Modify: `src/__tests__/integration/database-migrations.test.ts`

- [ ] 先添加短码格式、随机生成、唯一冲突重试和内容指纹的失败测试。
- [ ] 添加可空唯一 `printCode`、正式增量迁移和 Prisma Client。
- [ ] 实现 8 位 Base58 短码、并发安全惰性补齐与 12 位内容指纹。
- [ ] 新建/导入试卷时分配短码；不改变现有错题 `shortId`。
- [ ] 把备份升级到 v14；旧备份缺码时生成，v14 合法码优先保留，冲突时换码。
- [ ] 运行定向单元、迁移和真实 SQLite 备份测试。
- [ ] 提交：`feat: 增加试卷打印身份`

### Task 2：提供受鉴权的短码解析与安全登录回跳

**Files:**
- Create: `src/app/api/exams/print-code/[printCode]/route.ts`
- Modify: `src/app/api/exams/[id]/route.ts`
- Modify: `src/types/api.ts`
- Create: `src/lib/auth-callback.ts`
- Modify: `src/app/login/page.tsx`
- Create/Modify: 对应单元与集成测试

- [ ] 先写所有权隔离、格式错误、版次匹配和惰性补码的失败测试。
- [ ] 详情 API 返回 `printCode` 与当前 `printVersion`；解析 API 只查当前用户并返回匹配状态。
- [ ] 先写站内回跳白名单测试，再让登录页安全使用 `callbackUrl`。
- [ ] 运行相关单元、API 集成和认证测试。
- [ ] 提交：`feat: 增加试卷短码解析入口`

### Task 3：在打印稿输出二维码与地址提示

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/app/exams/[id]/print/page.tsx`
- Modify: `src/app/exams/[id]/print/exam-print-sheet.tsx`
- Modify: `src/lib/exam/exam-print.ts`
- Create: `src/lib/exam/print-access-url.ts`
- Modify: `src/lib/i18n/zh.ts`
- Modify: `src/lib/i18n/en.ts`
- Create/Modify: 对应单元与组件测试

- [ ] 从 npm 官方源安装 `qrcode.react@4.2.0`。
- [ ] 先写访问地址规范化、回环地址警告和打印身份块的失败测试。
- [ ] 添加本机保存的手机访问地址输入；生成 `/exams/scan/:code?v=:version`。
- [ ] 在打印稿和独立 HTML 中输出二维码 SVG、短码、版次；不影响答案页和现有打印布局。
- [ ] 运行打印相关单元/组件测试并检查锁文件来源。
- [ ] 提交：`feat: 在打印试卷中加入二维码`

### Task 4：实现扫码落地页与版次警告

**Files:**
- Create: `src/app/exams/scan/[printCode]/page.tsx`
- Create: `src/components/exam/exam-scan-landing.tsx`（若组件需要拆分）
- Modify: `src/lib/i18n/zh.ts`
- Modify: `src/lib/i18n/en.ts`
- Create: `e2e/exam-print-code.spec.ts`

- [ ] 先添加精确版次、旧版、未找到和未登录回跳的 Playwright/组件失败测试。
- [ ] 精确版次自动替换到既有回传页面；旧版显示警告并允许手工继续；错误态不泄露所有权。
- [ ] 验证窄屏扫码页面和移动端上传入口可用。
- [ ] 运行定向 E2E。
- [ ] 提交：`feat: 增加纸质试卷扫码回传`

### Task 5：同步文档并完成门禁

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/MVP_PLAN.md`
- Modify: `docs/DATA_MODEL.md`
- Modify: 受影响的 `doc/`/Wiki 中英文页面（按实际入口定位）

- [ ] 记录二维码需要手机可访问的 Mac 地址、登录保护、旧版警告、备份 v14 和试卷级而非物理页级身份。
- [ ] 运行 `git diff --check`、翻译 key 测试、lint、单元、集成、全量 Vitest、定向 E2E。
- [ ] 运行完整 `scripts/ci.sh` 和公开历史检查；确认无 `npmmirror`、密钥、真实数据或无关改动。
- [ ] 请求独立代码审查并修复有效问题，重新验证。
- [ ] 提交：`docs: 更新纸质试卷扫码说明`

## 最终验收

- 新卷、旧卷、导入卷和恢复卷都有合法且唯一的短码。
- 打印稿与下载 HTML 均可见二维码、短码、版次。
- 未登录扫码能在登录后回到扫码页；登录用户不能解析其他用户的短码。
- 内容未变直接进入回传；内容变化显示警告且用户可明确继续。
- v11～v13 可导入，v14 完整往返；冲突不会破坏目标库现有试卷。
- 全部自动化门禁通过，且没有物理分页重写、Python OCR 或破坏性迁移。
