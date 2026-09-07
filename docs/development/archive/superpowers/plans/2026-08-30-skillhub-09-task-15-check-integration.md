# Plan09 Task15：检查运行与发现项处置实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将确定性的基础安全检查、检查结果持久化和发现项处置接入本地 ApplicationFacade 与桌面端。

**Architecture:** ApplicationFacade 使用现有 `CheckService`、`BasicScanner`、`VersionStore` 和 SQLite 检查仓储；基础检查只读取集中库版本快照，不执行 Skill 内容。发现项处置通过既有 `SetFindingDisposition` 契约更新当前基础检查运行，并保留高风险二次确认边界。

**Tech Stack:** Rust、SQLite、Tauri/Specta bindings、React、TypeScript、Vitest。

**Spec:** `docs/需求文档.md`、`docs/技术架构设计.md`、`docs/产品与交互设计.md`。

## Global Constraints

- 基础安全检查必须与 LLM 检查独立展示、独立持久化，LLM 不可用不能使基础检查失败。
- 不执行 Skill 中的脚本、命令、代码块、MCP 或模型输出。
- 只允许检查集中库中指定的 `skill_id/version_id`，不接受任意路径。
- 发现项处置不修改 Skill 内容；高风险发现项从 actionable 改为 acknowledged/dismissed 时必须显式确认。
- 所有新增行为先写失败测试，再实现最小代码；测试通过后更新 Task 报告和开发状态。

---

### Task 15.1：ApplicationFacade 运行基础检查

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes: `CheckService`, `BasicScanner`, `VersionStore`, `RunBasicCheck`, `RecheckBasic`。
- Produces: `AppCommandResult::BasicCheckResult`，并将结果写入 SQLite 当前检查运行。

- [x] 编写失败测试：对集中库版本执行 `RunBasicCheck`，返回基础检查结果并可通过 `GetBasicCheckResult` 读取；重复 `RecheckBasic` 的 generation 递增。
- [x] 运行 `cargo test -p skillhub-application --test facade basic_check`，确认测试先失败。
- [x] 在 facade 中接入版本物化、`BasicScanner` 和 `CheckService`，禁止传入任意文件系统路径。
- [x] 运行定向测试及 `cargo test -p skillhub-application --test facade`。

### Task 15.2：发现项处置 ApplicationFacade 与桌面门面

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Modify: `apps/desktop/src/features/skill-detail/nativeApi.ts`
- Test: `crates/skillhub-application/tests/facade.rs`
- Test: `apps/desktop/src/features/skill-detail/nativeApi.test.ts`

**Interfaces:**
- Consumes: `SetFindingDisposition`、`CheckService::set_finding_disposition`。
- Produces: `AppCommandResult::BasicCheckResult` 及类型化 `setFindingDisposition` 调用。

- [x] 编写失败测试：未知发现项被拒绝；高风险发现项未确认时被拒绝；确认后处置结果更新。
- [x] 运行定向 Rust/前端测试确认失败。
- [x] 接入 facade 命令分发和前端原生门面，严格保留 kind/version 校验。
- [x] 运行 Rust facade、前端定向测试、TypeScript 和 ESLint。

### Task 15.3：文档、双平台 CI 与验收收口

**Files:**
- Create: `docs/development/task-reports/plan-09-task-15-check-integration.md`
- Modify: `docs/development/当前开发状态.md`
- Modify: `docs/superpowers/plans/2026-08-30-skillhub-09-task-15-check-integration.md`

- [x] 记录测试、风险和未接入的 LLM 检查边界。
- [x] Windows 本地 CI 通过后提交并推送，交由 macOS 只读复核同一提交。
- [x] 双平台通过后勾选本计划并更新当前开发状态。
