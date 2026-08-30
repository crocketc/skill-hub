# SkillHub Plan09 Task24 Backup Create and Verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect real application-facade commands for creating a verified local backup package and verifying a user-selected package path.

**Architecture:** Reuse Task23's read-only `BackupInput` builder and the storage `BackupService` for package creation and manifest verification. Return a non-portable result wrapper containing the local package path plus the portable manifest; never write the local path into `backup.json`.

**Tech Stack:** Rust, Specta-generated TypeScript bindings, `skillhub-storage::BackupService`, Tauri application facade tests.

**Spec:** `docs/需求文档.md`, `docs/技术架构设计.md`, `docs/superpowers/plans/2026-08-22-skillhub-08-backup-cli-release.md`

## Global Constraints

- Windows and macOS only; no Linux-specific behavior.
- Backup creation must require explicit decisions for every detected sensitive Skill.
- Verification must validate every manifest entry before returning success.
- Local package paths are returned only in the command result and never persisted in portable metadata.
- Do not restore, overwrite the live library, apply retention, export, or uninstall in this task.
- Apply TDD before production changes and regenerate Specta bindings rather than editing them manually.

---

### Task 24.1: Add a non-portable created-backup result

**Files:**
- Modify: `crates/skillhub-core/src/backup/model.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Test: `crates/skillhub-core/tests/api_contract.rs`

**Interfaces:**
- Produces: `BackupCreated { path: String, manifest: BackupManifest }` and `AppCommandResult::BackupCreated` serialized as `backup_created`.

- [ ] **Step 1: Write a failing contract test**

Add a JSON contract assertion that serializing `BackupCreated` preserves the local `path` and nested portable `manifest`, while serializing the manifest itself still contains no path field.

- [ ] **Step 2: Run the contract test and verify it fails**

Run `cargo test -p skillhub-core --test api_contract backup_created_result_has_path_and_portable_manifest`.
Expected: compilation failure because `BackupCreated` and the result variant do not exist.

- [ ] **Step 3: Implement the result wrapper**

Add the typed struct and result enum variant. Keep `BackupManifest` unchanged so `backup.json` remains portable.

- [ ] **Step 4: Run the contract test**

Run the same command and expect PASS.

- [ ] **Step 5: Commit**

```text
git add crates/skillhub-core/src/backup/model.rs crates/skillhub-core/src/api/command.rs crates/skillhub-core/tests/api_contract.rs
git commit -m "feat: expose created backup result"
```

### Task 24.2: Connect create and verify commands in the local facade

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes: `build_backup_input`, `BackupService::prepare`, `BackupService::create`, `BackupService::verify`.
- Produces: `CreateBackup -> AppCommandResult::BackupCreated`; `VerifyBackup -> AppCommandResult::BackupManifest`.

- [ ] **Step 1: Write failing create and verify tests**

Add a facade test that creates a sensitive fixture, submits `IncludeAndMark`, asserts the returned path exists, `backup.json` contains no absolute library path, and then verifies the returned path. Add a failure assertion for omitted sensitive decisions.

- [ ] **Step 2: Run focused tests to verify failure**

Run `cargo test -p skillhub-application --test facade backup_create`.
Expected: failure because both commands currently return `execute.unsupported`.

- [ ] **Step 3: Implement minimal command handling**

For `CreateBackup`, rebuild the current full input, prepare the plan, map decisions, create the package in the configured backups directory, immediately verify it, and return `BackupCreated` with the package root and verified manifest. For `VerifyBackup`, construct a `BackupPackage` from the supplied path, run `BackupService::verify`, and return its manifest. Do not accept `SelectedSkills` until command input carries explicit IDs.

- [ ] **Step 4: Regenerate bindings and run focused tests**

Run:

```text
cargo test -p skillhub-desktop generate_bindings
cargo test -p skillhub-application --test facade backup_create
cargo test -p skillhub-storage --test backup
```

Expected: all pass and `apps/desktop/src/api/bindings.ts` has only the generated `backup_created` additions.

- [ ] **Step 5: Commit**

```text
git add crates/skillhub-application/src/lib.rs crates/skillhub-application/tests/facade.rs apps/desktop/src/api/bindings.ts
git commit -m "feat: create and verify backups in facade"
```

### Task 24.3: Dual-platform verification and documentation

**Files:**
- Modify: `docs/development/当前开发状态.md`
- Create: `docs/development/task-reports/plan-09-task-24-backup-create-verify.md`

- [ ] **Step 1: Run Windows full CI**

Run `./scripts/ci-local.ps1`; if the npm mirror audit endpoint is unavailable, use the official registry temporarily and restore the original registry afterward.

- [ ] **Step 2: Request macOS read-only validation**

Sync `main`, run `./scripts/ci-local.sh`, and run the focused backup create/verify facade tests. Do not modify source, dependencies, or Git on macOS.

- [ ] **Step 3: Record and close the Task report**

Document package creation, manifest verification, sensitive decision behavior, generated binding validation, both CI results, and remaining restore/retention/export boundaries.

- [ ] **Step 4: Commit and push docs**

```text
git add docs/development/当前开发状态.md docs/development/task-reports/plan-09-task-24-backup-create-verify.md apps/desktop/dist/.gitkeep
git commit -m "docs: close backup create validation"
git push origin main
```
