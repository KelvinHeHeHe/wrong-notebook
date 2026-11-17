# Next.js 安全升级实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 Next.js 官方 security 升级器修复 16.4.3 的已知安全风险，并证明现有家庭考试 MVP 无回归。

**Architecture:** 在独立 Git 工作树中运行官方升级器，先审查依赖和 codemod 差异，再运行仓库完整 CI 与全量 Playwright。业务 Schema、迁移、备份实现和用户数据保持不变。

**Tech Stack:** Next.js 16、React 19、npm lockfile、Vitest、Playwright、Prisma 5、SQLite。

**Spec:** `docs/superpowers/specs/2026-11-17-next-security-upgrade-design.md`

## Global Constraints

- 只接受官方 security 升级器要求的安全依赖与必要 codemod 变化。
- 使用 `https://registry.npmjs.org`，锁文件不得出现 `npmmirror`。
- 不修改 Prisma Schema、正式迁移、备份版本或用户数据。
- 不自动合并、推送、打标签、发布包、镜像或安装包。
- 若升级器要求跨越 Next.js 主版本或产生无法解释的业务改动，停止并报告，不自行扩大范围。

## Review Focus

- 安全升级是否确实改变了受影响的 Next.js 版本，而不是仅让一次性提示消失。
- React / React DOM / Next.js 的版本与 peer dependency 是否一致，无重复或 invalid 依赖。
- 官方升级器是否改动业务源码、配置或脚本；每项非依赖改动是否确有必要。
- 锁文件是否只使用官方 registry，安装后能完全复现。
- 生产构建、SQLite 集成测试、浏览器 PDF/图片流程和纸质回传是否保持正常。

---

### Task 1: 固定升级基线并运行官方升级器

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Conditionally modify: official upgrader-required config or source files only

**Interfaces:**
- Consumes: current `next@~16.4.3`、React 19.3.1、官方 security nudge ID。
- Produces: 可安装的安全修复依赖集合与完整锁文件。

- [ ] **Step 1: 记录基线**

Run:

```bash
git status --short
node --version
npm --version
node -p "require('./package.json').dependencies.next"
npm ls next react react-dom
```

Expected: 工作区仅有本计划文档；Next.js 范围为 `~16.4.3`，依赖树无 invalid。

- [ ] **Step 2: 安装锁定依赖**

Run:

```bash
npm ci --registry=https://registry.npmjs.org --no-audit --no-fund
npx --no-install prisma generate
```

Expected: 安装和 Prisma Client 生成成功，锁文件不改变。

- [ ] **Step 3: 运行官方 security 升级器**

Run:

```bash
npx --no-install next upgrade --agent=security --internal-nudge-id=b89e47d1-931b-4167-a388-635b3c20f5bb
```

Expected: 升级器选择已修复版本并更新依赖/锁文件；若要求跨主版本或交互选择，停止并记录实际提示。

- [ ] **Step 4: 审查升级差异**

Run:

```bash
git status --short
git diff --stat
git diff -- package.json package-lock.json
npm ls next react react-dom
rg -n "npmmirror" package-lock.json
```

Expected: 变更范围可解释；依赖树无 invalid；registry 检查无输出。任何源代码或配置变化逐项核对官方 codemod 需要。

- [ ] **Step 5: 提交依赖升级**

```bash
git add package.json package-lock.json
git add <仅当官方 codemod 确有必要的文件>
git commit -m "fix: 升级 Next.js 安全修复版本"
```

---

### Task 2: 完整验证并更新发布门禁文档

**Files:**
- Modify: `docs/MVP_ACCEPTANCE.md`
- Modify: `docs/MVP_PLAN.md`

**Interfaces:**
- Consumes: Task 1 的安全修复依赖和任务 06 验收报告。
- Produces: 本地安全升级结果、完整 CI/E2E 证据和仍待外部完成的发布清单。

- [ ] **Step 1: 运行完整本地 CI**

Run:

```bash
npm_config_registry=https://registry.npmjs.org RUST_LOG=info TELEMETRY_DISABLED=false bash scripts/ci.sh
```

Expected: 安装、Prisma、lint、全量 Vitest、publication、公开历史、脚本语法、TypeScript 和生产构建全部通过；构建不再被同一安全提示中止。

- [ ] **Step 2: 运行全量 Playwright**

Run:

```bash
npm run test:e2e
```

Expected: 96/96 Chromium 通过，0 unexpected、0 flaky、0 skipped，报告位于系统临时目录。

- [ ] **Step 3: 更新验收文档**

在 `docs/MVP_ACCEPTANCE.md` 记录旧版、升级后版本、完整 CI/E2E 结果和报告路径；把 Next.js 安全升级从“未处理阻断”改为“本地已处理，待远端 CI”。在 `docs/MVP_PLAN.md` 同步发布状态。不得把远端 CI、真实家庭样本或 SignPath 写成已完成。

- [ ] **Step 4: 运行最终静态检查**

Run:

```bash
git diff --check
python3 scripts/check-public-history.py HEAD
rg -n "npmmirror" package-lock.json
git diff main...HEAD -- prisma/schema.prisma prisma/migrations src/lib/backup/format.ts src/app/api/export/route.ts src/app/api/import/route.ts
```

Expected: 公开历史通过；registry、业务 Schema、迁移和备份实现差异检查无输出。

- [ ] **Step 5: 提交验证文档**

```bash
git add docs/MVP_ACCEPTANCE.md docs/MVP_PLAN.md
git commit -m "docs: 记录 Next.js 安全升级验证"
```

- [ ] **Step 6: 最终只读复核**

Run:

```bash
git status --short
git log --oneline main..HEAD
```

Expected: 工作区干净，依赖升级和验证文档分成独立提交。
