# SkillHub Plan09 Task26 Export and Uninstall Facade Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing standard export and safe uninstall-preparation contracts and services to `LocalApplicationFacade` without leaking device-private paths or deleting user-owned files.

**Architecture:** Build export inputs from the configured immutable central library and catalog, delegate sensitivity preflight and neutral package creation to `skillhub-storage::ExportService`, and return only the export result path in the transient command result. Build uninstall impact from explicitly selected active deployment records using `skillhub_core::UninstallService`; applying decisions is a confirmation gate that performs only already-owned reversible relation actions and never removes the central library or arbitrary user data.

**Tech Stack:** Rust, `skillhub-core` command/query contracts, `skillhub-storage::ExportService`, `LocalApplicationFacade`, SQLite repositories, immutable `VersionStore`, Specta-generated TypeScript bindings, Tokio integration tests.

**Spec:** `docs/需求文档.md`, `docs/技术架构设计.md`, `docs/superpowers/plans/2026-08-22-skillhub-08-backup-cli-release.md`

## Global Constraints

- Windows and macOS are the supported platforms; do not add Linux-specific behavior.
- Apply TDD: each new facade behavior starts with a failing integration test observed before production changes.
- Standard export remains neutral: export only selected input Skills, content, version IDs, and a portable manifest; never include SkillHub credentials, evidence, operations, private settings, or local absolute paths in the package metadata.
- Sensitive-content findings require explicit `ExcludeSkill` or `IncludeAndMark` decisions; omitted decisions fail with the existing structured error.
- Uninstall always returns impact before a decision; `Cancel` performs no mutation; `RetainCentralLibrary` is mandatory for the current safe implementation; no user original or non-owned file is deleted.
- Reuse existing ownership/path-safety checks and removal service; do not duplicate filesystem deletion logic or add dependencies.
- Regenerate `apps/desktop/src/api/bindings.ts` from Specta; never hand-edit generated bindings.
- Do not modify `docs/development/当前开发状态.md`, dependency manifests, or other agents' task documents.

---

### Task 26.1: Build and test real export input through the facade

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes: `LocalApplicationFacade.library`, `library_root`, catalog `list_ids_sync`, `VersionStore::current`, `VersionStore::read_file`, `ExportInput` supplied by the command.
- Produces: private helper that validates and normalizes an `ExportInput` against the configured library and returns `ExportPlan` through `AppCommandResult::ExportPlan`.

- [ ] **Step 1: Write the failing export-preparation test**

Create a temporary library, capture one catalog Skill with an ordinary `SKILL.md`, and invoke `AppCommand::PrepareStandardExport` with that Skill and current version. Assert the result is `AppCommandResult::ExportPlan` with one summary and no sensitive items. Add a sensitive-content case asserting the plan identifies the Skill and does not create an export directory.

- [ ] **Step 2: Run the test and verify it fails for the missing facade route**

Run: `cargo test -p skillhub-application --test facade standard_export_prepare`

Expected: FAIL because `PrepareStandardExport` currently returns the structured `execute.unsupported` error.

- [ ] **Step 3: Implement the minimal read-only preparation path**

For a library-backed facade, validate each input Skill against the catalog/current or requested version, load only the immutable `SKILL.md` content when the supplied `skills` list is empty, reject unavailable library access with the existing unsupported error, and call `ExportService::new(LibraryPaths::from_root(root).management_dir.join("exports")).prepare(&input)`. Preserve the caller’s selection/version fields and return `AppCommandResult::ExportPlan`; do not create directories or persist command state.

- [ ] **Step 4: Run focused and storage tests**

Run:

```text
cargo test -p skillhub-application --test facade standard_export_prepare
cargo test -p skillhub-storage --test export_uninstall
```

Expected: all focused tests pass and preparation remains filesystem/database read-only.

### Task 26.2: Connect export creation with explicit sensitivity decisions

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes: `ExportService::prepare`, `ExportService::create`, `ExportDecision`.
- Produces: `AppCommand::CreateStandardExport -> AppCommandResult::ExportResult` with a transient local result path and exported count.

- [ ] **Step 1: Write failing creation and privacy tests**

Add a facade test that creates a sensitive Skill, confirms omitted decisions fail with `BackupExportDecisionRequired`, then supplies `IncludeAndMark` and asserts the result path exists, `manifest.json` contains no library absolute path or credential value, and the exported count is correct. Add an `ExcludeSkill` assertion that no `SKILL.md` is written for that Skill.

- [ ] **Step 2: Run tests to verify the expected failure**

Run: `cargo test -p skillhub-application --test facade standard_export_create`

Expected: FAIL because `CreateStandardExport` currently returns `execute.unsupported`.

- [ ] **Step 3: Implement minimal creation handling**

Reuse the preparation input builder, call `ExportService::prepare` and map command decisions to `(SkillId, SensitiveContentDecision)`, create the package below the configured library export destination, then return `ExportResult { path, skills_exported }`. Keep device paths only in the result envelope; never add them to `manifest.json` or Skill content and never emit platform-specific upload packages.

- [ ] **Step 4: Run focused export tests**

Run: `cargo test -p skillhub-application --test facade standard_export_create && cargo test -p skillhub-storage --test export_uninstall`

Expected: PASS with explicit sensitive decisions and no path/secret leakage.

### Task 26.3: Prepare uninstall impact and expose read-only impact query

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes: `PrepareUninstall.deployment_ids`, active deployment repository records, `UninstallService::prepare`, existing `GetRemovalImpact` query.
- Produces: `AppCommandResult::UninstallImpact` for `PrepareUninstall`; `AppQuery::GetRemovalImpact` continues to return the same impact for a Skill without mutation.

- [ ] **Step 1: Write failing impact tests**

Insert a managed deployment record and invoke `PrepareUninstall` with its ID. Assert the result includes that deployment, lists `RetainCentralLibrary`, and does not alter the deployment state or central library files. Also invoke `GetRemovalImpact` for the Skill and assert it reports the active deployment.

- [ ] **Step 2: Run tests and verify the missing route**

Run: `cargo test -p skillhub-application --test facade uninstall_prepare`

Expected: FAIL because `PrepareUninstall` is unsupported while the query only handles skill-level removal.

- [ ] **Step 3: Implement read-only uninstall preparation**

Load all active records whose IDs are explicitly requested, return `ObjectNotFound` for an unknown or non-active ID, pass the records to `UninstallService::prepare`, and return the resulting impact. Refactor the existing skill-level impact helper only if needed to avoid duplicated active-record loading; keep all preparation operations side-effect free.

- [ ] **Step 4: Run impact tests**

Run: `cargo test -p skillhub-application --test facade uninstall_prepare`

Expected: PASS; no deployment relation or filesystem content changes occur during either impact path.

### Task 26.4: Apply only explicit safe uninstall decisions

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes: `ApplyUninstallDecision.actions`, `RemovalService`, ownership proofs, prepared impact contract.
- Produces: `AppCommandResult::OperationSummary` with stable phase/message code for cancel, safe undeploy, or retained-library completion.

- [ ] **Step 1: Write failing decision-gate tests**

Add tests showing `Cancel` leaves deployment and target files unchanged; `RemoveDeviceData` without an explicit owned undeploy action is rejected; `UndeployAll` removes only SkillHub-owned target content and marks the relation removed while preserving the central library; and `LeaveTargetsIndependent` detaches management without deleting target content. Include a modified-target case asserting the ownership error and preserved files.

- [ ] **Step 2: Run tests to verify missing decision handling**

Run: `cargo test -p skillhub-application --test facade uninstall_decision`

Expected: FAIL because `ApplyUninstallDecision` currently returns `execute.unsupported`.

- [ ] **Step 3: Implement the minimal explicit-decision gate**

Reject an empty action list and destructive actions that are not paired with a selected safe policy; treat `Cancel` as an immediate no-op summary; for `UndeployAll`, call the existing removal service with `RemoveOwnedTarget` for each selected active deployment; for `LeaveTargetsIndependent`, call `DetachManagement`; always preserve the central library and return a summary. Do not implement credential deletion or arbitrary device-data cleanup in this task; return a structured unsupported/invalid error for those actions.

- [ ] **Step 4: Run focused and affected tests**

Run:

```text
cargo test -p skillhub-application --test facade uninstall_decision
cargo test -p skillhub-storage --test export_uninstall
cargo test -p skillhub-core --test api_contract export_and_uninstall_commands_have_stable_wire_shapes
```

Expected: PASS with ownership protection and cancellation behavior preserved.

### Task 26.5: Regenerate bindings and complete verification

**Files:**
- Modify: `apps/desktop/src/api/bindings.ts` (generated only)
- Test: generated-binding drift test in `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Regenerate and validate bindings**

Run: `cargo test -p skillhub-desktop generate_bindings`

Expected: PASS with no hand-maintained contract drift.

- [ ] **Step 2: Run formatting, checks, and diff validation**

Run:

```text
cargo fmt --all -- --check
cargo check --workspace --all-targets --all-features --locked
git diff --check
```

Expected: exit 0 with only this plan, facade implementation/tests, and generated binding changes.

- [ ] **Step 3: Commit the isolated task**

```text
git add crates/skillhub-application/src/lib.rs crates/skillhub-application/tests/facade.rs apps/desktop/src/api/bindings.ts docs/superpowers/plans/2026-08-30-skillhub-09-task-26-export-uninstall.md
git commit -m "feat: connect export and uninstall facade flows"
```

---

## Self-review checklist

- Standard export prepare/create are read-only until create, use existing sensitivity decisions, and do not write portable local paths or secrets.
- Uninstall preparation exposes impact before action, supports cancellation, preserves central library and user originals, and delegates ownership checks to existing removal logic.
- All new behavior has facade integration tests observed red before implementation and green after implementation.
- The generated binding drift test and required workspace checks run before completion.
