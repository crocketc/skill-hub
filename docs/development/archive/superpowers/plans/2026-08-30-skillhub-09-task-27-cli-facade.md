# Task27 CLI Facade Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the lightweight CLI to a locally opened `LocalApplicationFacade` for safe catalog, status, pending, basic-check and backup-verification operations without executing Skill code, npx, network or LLM work.

**Architecture:** Keep all runtime construction inside `skillhub-cli`. Resolve an explicit `--database`/`--library` pair or platform-local defaults, open the existing application facade, and route each supported operation through the frozen `ApplicationFacade` query/command contract. Convert `AppResult` success/error values into one stable JSON envelope and actionable human-readable stderr without changing `skillhub-application`.

**Tech Stack:** Rust 2021, `skillhub-core` API contracts, `skillhub-application::LocalApplicationFacade`, `skillhub-storage` path conventions, serde/serde_json, Tokio current-thread runtime.

**Spec:** `docs/superpowers/plans/2026-08-22-skillhub-08-backup-cli-release.md`, `docs/需求文档.md`, `docs/技术架构设计.md`

## Global Constraints

- CLI is an automation surface and must not execute `npx`, Skill scripts, arbitrary commands, network operations or LLM output.
- Preserve `--json`, `--non-interactive` and `--yes`; write commands remain gated and are not expanded by this task.
- Use the shared `ApplicationFacade` contract and do not modify `crates/skillhub-application/src/lib.rs`.
- Missing/unreadable configuration or database must return a stable, actionable error and never panic.
- Windows and macOS default paths must be derived through platform-aware user data locations; explicit paths are accepted for tests and automation.

---

### Task 1: Define CLI runtime inputs and red-path behavior

**Files:**
- Modify: `crates/skillhub-cli/src/args.rs`
- Modify: `crates/skillhub-cli/src/output.rs`
- Test: `crates/skillhub-cli/tests/cli.rs`

**Interfaces:**
- Produces parsed `CliArgs` fields for `--database`, `--library`, `--query`, `--skill`, `--version`, and `--path`.
- Produces stable `cli.not_configured`/`cli.invalid_input` envelopes and actionable error text.

- [x] **Step 1: Write failing tests** for explicit paths, list/search/status/pending/check/backup verify inputs, and missing runtime configuration.
- [x] **Step 2: Run** `cargo test -p skillhub-cli --test cli`; confirm the new parser/runtime expectations fail.
- [x] **Step 3: Implement** only the argument fields and output error helpers required by those tests; keep existing high-risk authorization checks intact.
- [x] **Step 4: Run** the focused tests and confirm they pass.
- [x] **Step 5: Commit** with `feat: define safe CLI facade inputs`.

### Task 2: Construct and invoke the local facade for safe operations

**Files:**
- Create: `crates/skillhub-cli/src/runtime.rs`
- Modify: `crates/skillhub-cli/src/commands/mod.rs`
- Modify: `crates/skillhub-cli/src/main.rs`
- Modify: `crates/skillhub-cli/Cargo.toml`
- Test: `crates/skillhub-cli/tests/cli.rs`

**Interfaces:**
- `runtime::LocalRuntime::open(&CliArgs) -> AppResult<LocalApplicationFacade>` (or an equivalent CLI-local constructor).
- `commands::run(&CliArgs, &dyn ApplicationFacade) -> Future<Output = AppResult<serde_json::Value>>` for safe query/verify commands.

- [x] **Step 1: Write failing integration tests** using temporary SQLite/library fixtures to prove list, search, status, pending, basic check and backup verify reach the real facade and return structured payloads.
- [x] **Step 2: Run** `cargo test -p skillhub-cli --test cli`; confirm the tests fail because the CLI still uses `UnconfiguredFacade`.
- [x] **Step 3: Implement** a Tokio current-thread runtime, platform-aware defaults plus explicit path overrides, and command mapping to `AppQuery`/`AppCommand::VerifyBackup`; never map to LLM, source-online or arbitrary execution APIs.
- [x] **Step 4: Run** focused tests and verify missing paths return nonzero/actionable errors without panic.
- [x] **Step 5: Commit** with `feat: connect CLI to local application facade`.

### Task 3: Verify complete CLI crate quality gates

**Files:**
- Modify: `crates/skillhub-cli/src/output.rs` or tests only if verification exposes a scoped defect.

- [x] **Step 1:** Run `cargo fmt --all -- --check`.
- [x] **Step 2:** Run `cargo check -p skillhub-cli` and `cargo test -p skillhub-cli --test cli`.
- [x] **Step 3:** Run `cargo test -p skillhub-cli`.
- [x] **Step 4:** Run `git diff --check` and inspect `git status` for only Task27 files.
- [x] **Step 5:** Commit any final scoped fix and report commands, results, risks and commit hash.
