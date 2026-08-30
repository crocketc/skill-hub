# Backup Restore and Retention Facade Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing storage restore and retention services to `LocalApplicationFacade` for safe prepare/commit restore and rolling backup commands.

**Architecture:** The facade validates user-supplied package paths, constructs `BackupPackage` values, and delegates verification, conflict planning, staged restore, and retention to `RestoreService` and `RetentionService`. Restore commits re-prepare the current package before applying explicit conflict choices; rolling backup creates and verifies through the existing backup service before applying retention.

**Tech Stack:** Rust, Tokio, `skillhub-application`, `skillhub-storage` backup services, Specta-generated TypeScript bindings.

**Spec:** `docs/需求文档.md`, `docs/技术架构设计.md`, `docs/superpowers/plans/2026-08-22-skillhub-08-backup-cli-release.md`, `docs/superpowers/plans/2026-08-30-skillhub-09-task-24-backup-create-verify.md`

## Global Constraints

- Support Windows and macOS path behavior; portable metadata must not reuse device-specific target paths.
- Restore must verify package integrity before planning or committing and must require explicit decisions for every detected conflict.
- Retention may remove only verified SkillHub-owned backup directories and must retain at least one valid package when any valid package exists.
- Do not implement standard export, uninstall, or target deployment as part of this task.
- Apply TDD: add and observe failing facade tests before production changes.
- Regenerate Specta bindings with `cargo test -p skillhub-desktop generate_bindings`; never edit bindings manually.

---

### Task 25.1: Integrate restore commands into the local facade

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes: `PrepareRestore`, `CommitRestore`, `RestoreDecision`, `RestoreService::prepare`, and `RestoreService::commit`.
- Produces: `AppCommandResult::RestorePlan` and `AppCommandResult::RestoreResult`.

- [ ] **Step 1: Write failing facade tests**

Add tests covering a valid package prepared through the facade, a commit that applies `Skip` to an existing skill while preserving the live content, omitted conflict decisions returning `backup.restore_decision_required`, a nonexistent package path returning a structured error, and portable metadata containing an old device target being restored without that path becoming part of the destination.

- [ ] **Step 2: Run focused tests and verify the expected failure**

Run `cargo test -p skillhub-application --test facade restore_` and confirm the new tests fail because restore commands are currently unsupported.

- [ ] **Step 3: Implement the minimal facade delegation**

Add a helper that accepts only an existing directory package, maps missing/invalid paths to the existing structured application errors, and returns `BackupPackage`. In `execute`, construct `RestoreService` with the configured central library root, call `prepare` for `PrepareRestore`, and for `CommitRestore` re-prepare then map decisions and call `commit`. Return typed restore results without writing agent target paths.

- [ ] **Step 4: Run restore tests and related storage tests**

Run `cargo test -p skillhub-application --test facade restore_` and `cargo test -p skillhub-storage --test restore_migration`; expect all tests to pass.

- [ ] **Step 5: Commit the restore integration**

Run `git add crates/skillhub-application/src/lib.rs crates/skillhub-application/tests/facade.rs` and commit with `git commit -m "feat: connect restore commands to local facade"`.

### Task 25.2: Integrate rolling backup and retention

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes: `RunRollingBackup`, `BackupService::prepare/create/verify`, and `RetentionService::apply`.
- Produces: `AppCommandResult::BackupRetentionResult` after creating a verified package and applying the requested retention policy.

- [ ] **Step 1: Write a failing rolling-backup test**

Add a facade test that builds a library-backed fixture, runs `RunRollingBackup` with an explicit sensitive-content decision and `max_backups: 1`, asserts a retention result, and confirms exactly one verified owned backup remains. Add a second assertion that omitted sensitive decisions fail before retention is applied.

- [ ] **Step 2: Run the focused test and verify it fails**

Run `cargo test -p skillhub-application --test facade rolling_backup`; confirm failure because the command is currently unsupported.

- [ ] **Step 3: Implement create-verify-retain delegation**

Reuse `build_backup_input`, create and immediately verify a package using `BackupService` under the library's backups directory, then apply `RetentionService` with the request policy and return `BackupRetentionResult`. Preserve the existing explicit sensitive decision behavior and do not expose a second export or uninstall path.

- [ ] **Step 4: Run focused backup and retention tests**

Run `cargo test -p skillhub-application --test facade rolling_backup` and `cargo test -p skillhub-storage --test backup_retention`; expect all tests to pass.

- [ ] **Step 5: Commit the rolling-backup integration**

Run `git add crates/skillhub-application/src/lib.rs crates/skillhub-application/tests/facade.rs` and commit with `git commit -m "feat: run rolling backups through local facade"`.

### Task 25.3: Regenerate bindings and run acceptance checks

**Files:**
- Modify: `apps/desktop/src/api/bindings.ts` (generated only)

**Interfaces:**
- Produces: bindings synchronized with the frozen restore and rolling-backup Rust contracts.

- [ ] **Step 1: Regenerate and validate Specta bindings**

Run `cargo test -p skillhub-desktop generate_bindings`; if bindings are stale, regenerate them through the repository-supported test workflow and rerun the test.

- [ ] **Step 2: Run formatting and diff checks**

Run `cargo fmt --all -- --check` and `git diff --check`.

- [ ] **Step 3: Run affected tests**

Run `cargo test -p skillhub-application --test facade`, `cargo test -p skillhub-storage --test restore_migration --test backup_retention`, and `cargo test -p skillhub-core --test api_contract`.

- [ ] **Step 4: Commit generated bindings and final verified changes**

Run `git add apps/desktop/src/api/bindings.ts` plus any still-uncommitted task files, then commit with `git commit -m "test: verify backup restore retention facade contracts"`.

## Self-Review Checklist

- Restore preparation and commit both verify the user-selected package and use sibling staging through `RestoreService`.
- All conflict choices are explicit and omitted choices preserve the storage service's structured warning.
- Device paths remain metadata-only and are sanitized by the storage restore implementation.
- Rolling backups verify before retention and never delete the only valid recent package.
- No export, uninstall, dependency, or unrelated documentation changes are included.
