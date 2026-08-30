# SkillHub Plan09 Task23 Backup Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the real local application facade to deterministic backup preflight so the desktop can preview the current full-library backup scope and sensitive-content decisions.

**Architecture:** Build a `BackupInput` from the configured central library manifest, catalog rows, and current immutable `SKILL.md` versions. Delegate sensitivity detection to the existing storage `BackupService::prepare`; do not write files or mutate the database during preflight.

**Tech Stack:** Rust, `skillhub-core` command/result contracts, `skillhub-storage::BackupService`, SQLite catalog, immutable `VersionStore`, facade integration tests.

**Spec:** `docs/需求文档.md`, `docs/技术架构设计.md`, `docs/superpowers/plans/2026-08-22-skillhub-08-backup-cli-release.md`

## Global Constraints

- Windows and macOS only; do not add Linux-specific behavior.
- Preflight is read-only: it must not create a backup directory, alter SQLite, alter portable metadata, or write Skill content.
- Do not execute Skill files or Markdown code while collecting backup content.
- Existing `BackupScope::SelectedSkills` is rejected until the command contract carries selected Skill IDs; `Full` is the only supported scope in this task.
- Keep backup sensitivity results independent from the security-check pipelines.
- Apply TDD: write and observe a failing facade test before production changes.

---

### Task 23.1: Build a read-only backup input

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Modify: `crates/skillhub-storage/src/database/catalog_repository.rs`
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes: `LocalApplicationFacade.library_root`, `VersionStore::current`, `VersionStore::read_file`, `CentralLibrary::load_manifest`.
- Produces: `LocalApplicationFacade::build_backup_input(BackupScope) -> AppResult<BackupInput>` (private helper), with one `(SkillId, String)` entry per catalog Skill's current `SKILL.md`.

- [ ] **Step 1: Write the failing test**

Add a facade integration test that creates a temporary library with one catalog Skill and current version, invokes `AppCommand::PrepareBackup { scope: Full }`, and asserts the returned plan has no sensitive items for ordinary Markdown. Add a second assertion that `SelectedSkills` returns `InvalidInput` because selection IDs are not part of the frozen command.

- [ ] **Step 2: Run the focused test and verify it fails**

Run `cargo test -p skillhub-application --test facade backup_preflight`.
Expected: failure because `PrepareBackup` is currently routed to `execute.unsupported`.

- [ ] **Step 3: Implement the minimal read-only input builder**

Add a helper that:

1. Rejects `SelectedSkills` with `ErrorCode::InvalidInput` and an explanatory `scope` parameter.
2. Loads the central library manifest and serializes it as `portable_metadata`.
3. Reads catalog Skill IDs using a small synchronous catalog repository method.
4. Resolves each current version and reads only `SKILL.md` with the existing size limit.
5. Returns `BackupInput::new(BackupScope::Full, portable_metadata, skills)`.

Do not create output directories or call `BackupService::create` in this step.

- [ ] **Step 4: Run the focused test and verify it passes**

Run `cargo test -p skillhub-application --test facade backup_preflight`.
Expected: PASS for the ordinary content and unsupported selected-scope cases.

- [ ] **Step 5: Commit**

```text
git add crates/skillhub-application/src/lib.rs crates/skillhub-storage/src/database/catalog_repository.rs crates/skillhub-application/tests/facade.rs
git commit -m "feat: prepare backup input in application facade"
```

### Task 23.2: Expose the backup plan through the facade

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes: `build_backup_input`, `skillhub_storage::backup::BackupService::prepare`.
- Produces: `AppCommandResult::BackupPlan(BackupPlan)` for `AppCommand::PrepareBackup`.

- [ ] **Step 1: Add a failing sensitive-content test**

Add a test with current `SKILL.md` containing `api_key=` and assert the returned `BackupPlan.sensitive_items` contains that Skill ID and reason `possible_plaintext_credential`.

- [ ] **Step 2: Run the test to verify the expected failure**

Run `cargo test -p skillhub-application --test facade backup_preflight_sensitive`.
Expected: failure because the command still returns `execute.unsupported`.

- [ ] **Step 3: Delegate to `BackupService::prepare`**

In `ApplicationFacade::execute`, handle `AppCommand::PrepareBackup` by building the input and calling `BackupService::new(LibraryPaths::from_root(library_root).backups_dir).prepare(&input)`, returning `AppCommandResult::BackupPlan`.

- [ ] **Step 4: Run focused and affected tests**

Run:

```text
cargo test -p skillhub-application --test facade backup_preflight
cargo test -p skillhub-storage --test backup
cargo test -p skillhub-core --test api_contract backup_commands_have_stable_wire_shapes
```

Expected: all pass; no backup directory is created by preflight.

- [ ] **Step 5: Commit**

```text
git add crates/skillhub-application/src/lib.rs crates/skillhub-application/tests/facade.rs
git commit -m "feat: expose backup preflight plan"
```

### Task 23.3: Batch verification and documentation

**Files:**
- Modify: `docs/development/当前开发状态.md`
- Create: `docs/development/task-reports/plan-09-task-23-backup-preflight.md`

- [ ] **Step 1: Run the full Windows CI**

Run `./scripts/ci-local.ps1` from the repository root and record all ten checks, frontend test count, audit result, and build result.

- [ ] **Step 2: Request the macOS read-only validation**

On macOS, sync `main`, run `./scripts/ci-local.sh`, and run the focused facade backup-preflight tests. Do not modify source, dependencies, or Git on macOS.

- [ ] **Step 3: Update the status and Task report**

Record the two-platform results, the read-only boundary, the unsupported selected scope, and the fact that backup creation, restore, export, and uninstall remain future integration tasks.

- [ ] **Step 4: Commit and push the documentation**

```text
git add docs/development/当前开发状态.md docs/development/task-reports/plan-09-task-23-backup-preflight.md
git commit -m "docs: close backup preflight validation"
git push origin main
```

## Scope boundary

This task intentionally does not create backup packages, verify user-selected paths, restore packages, apply retention, export data, or implement uninstall. Those flows need their own command/result integration and UI tasks.
