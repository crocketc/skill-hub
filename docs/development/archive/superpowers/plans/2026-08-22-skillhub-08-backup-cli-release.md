# SkillHub Backup, CLI, and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete portable backup/restore/migration, rolling backups, standard export, uninstall preparation, lightweight CLI, local logging/privacy controls, dependency/release automation, Windows/macOS packages and final compatibility/performance gates.

**Architecture:** Backup packages are versioned verified exports rather than raw live-database copies. The CLI uses the same `ApplicationFacade` and writer journal as the desktop. Release workflows build both OS artifacts from one commit, publish checksums/SBOM, and retain manual-update behavior until platform trust requirements are met.

**Tech Stack:** Rust, SQLite export, archive streaming, clap, tracing, Tauri 2 bundler, GitHub Actions, SBOM/advisory/license tools, Playwright, Windows/macOS runners.

**Spec:** `docs/需求文档.md` 5.35, 5.39–5.44, 8.2–8.5; `docs/产品与交互设计.md` sections 15–20; `docs/技术架构设计.md` 19–22 and 24–25.

## Global Constraints

- Backup/export never includes Credential Manager/Keychain secrets, debug logs, raw authentication headers or device-only absolute paths in portable metadata.
- Restore never writes into the live library until package integrity, format compatibility and conflicts are checked.
- CLI mutations require the same `OperationId`, ownership, check and recovery rules as desktop mutations.
- Do not create a resident daemon or tray process for scheduling.
- Early Windows release is unsigned NSIS with manual updates; early macOS release is ad-hoc Universal DMG with manual updates.
- Do not claim true Agent runtime compatibility from fixture-only tests.

---

### Task 1: Implement versioned full backup packages

**Files:**
- Create: `crates/skillhub-core/src/backup/mod.rs`
- Create: `crates/skillhub-core/src/backup/model.rs`
- Create: `crates/skillhub-storage/src/backup/mod.rs`
- Create: `crates/skillhub-storage/src/backup/export.rs`
- Create: `crates/skillhub-storage/src/backup/verify.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `crates/skillhub-storage/tests/backup.rs`

**Interfaces:**
- Produces: `BackupManifest`, `BackupScope`, `SensitiveContentDecision`, `BackupService::prepare`, `BackupService::create`, `BackupService::verify`, `PrepareBackup`, `CreateBackup`, `VerifyBackup`.

- [ ] **Step 1: Write package integrity and secret-exclusion tests**

```rust
#[test]
fn full_backup_round_trip_contains_portable_data_and_no_secret_or_device_path() {
    let fixture = backup_fixture_with_secret("sk-do-not-export");
    let package = fixture.create_full_backup().unwrap();
    let verified = fixture.verify_backup(&package).unwrap();
    assert_eq!(verified.manifest.format_version, 1);
    assert!(!package_bytes(&package).contains_subslice(b"sk-do-not-export"));
    assert!(!package_bytes(&package).contains_subslice(fixture.device_absolute_path().as_bytes()));
}

#[test]
fn changed_archive_entry_fails_manifest_verification() {
    let mut package = valid_backup_package();
    tamper_entry(&mut package, "portable/skills.json");
    assert_eq!(verify(package).unwrap_err().code.as_str(), "backup.checksum_mismatch");
}

#[test]
fn possible_plaintext_credential_pauses_backup_until_each_skill_has_a_choice() {
    let fixture = backup_fixture_with_skill_plaintext_key();
    let plan = fixture.prepare_full_backup().unwrap();
    assert_eq!(plan.sensitive_items.len(), 1);
    assert!(fixture.create_without_sensitive_decision(plan.id).is_err());
    let package = fixture.create_with_decision(plan.id, SensitiveContentDecision::IncludeAndMark).unwrap();
    assert!(verify(package).unwrap().manifest.contains_sensitive_skill_content);
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p skillhub-storage --test backup`

Expected: FAIL with missing backup implementation.

- [ ] **Step 3: Implement streaming package creation**

Prepare runs the deterministic credential scanner over selected Skill files. For every finding require `resolve first`, `exclude Skill`, or `include and mark sensitive`; never alter Skill bytes silently. Package `backup.json`, Skill/history/source/security-check/project/combination/settings/operation/custom-Agent/logical-relation exports, current/version manifests and required objects. Snapshot SQLite into a logical portable export inside a read transaction; do not copy the live WAL/database as the only restore source. Hash every entry and the manifest.

- [ ] **Step 4: Run tests**

Run: `cargo test -p skillhub-storage --test backup`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/backup crates/skillhub-core/src/api crates/skillhub-storage/src/backup crates/skillhub-storage/tests/backup.rs
git commit -m "feat: create verified portable SkillHub backups"
```

---

### Task 2: Implement restore, cross-OS migration and rolling retention

**Files:**
- Create: `crates/skillhub-storage/src/backup/restore.rs`
- Create: `crates/skillhub-storage/src/backup/retention.rs`
- Create: `crates/skillhub-core/src/application/backup_service.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Test: `tests/integration/restore_migration.rs`
- Test: `tests/integration/backup_retention.rs`

**Interfaces:**
- Produces: `RestorePlan`, `RestoreConflict`, `RestoreResult`, `BackupRetentionPolicy`, `PrepareRestore`, `CommitRestore`, `RunRollingBackup`.

- [ ] **Step 1: Write cross-platform path and conflict tests**

```rust
#[tokio::test]
async fn windows_backup_restores_portable_skills_on_macos_without_device_targets() {
    let app = restore_fixture(TargetOs::Macos).await;
    let result = app.restore(windows_backup_fixture()).await.unwrap();
    assert_eq!(result.skills_restored, expected_skill_count());
    assert!(result.deployments_requiring_rediscovery > 0);
    assert!(app.restored_absolute_windows_paths().await.is_empty());
}

#[tokio::test]
async fn restore_failure_before_switch_preserves_live_library() {
    let app = restore_fixture_with_fault("before_restore_switch").await;
    let before = app.live_library_hash().await;
    assert!(app.restore(valid_backup_fixture()).await.is_err());
    assert_eq!(app.live_library_hash().await, before);
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test --test restore_migration && cargo test --test backup_retention`

Expected: FAIL with missing restore/retention services.

- [ ] **Step 3: Implement staged restore and retention**

Verify package and format, materialize into a sibling staging root, report same-name/identity/path conflicts with explicit overwrite/keep-both/skip choices, build a fresh SQLite projection, then atomically switch or leave the current library untouched. Restore logical Agent/project version relations without device paths and require rediscovery/user confirmation before any target write. Retention removes only verified owned backup files by count/age policy and never deletes the only valid recent backup. Register automatic recovery-point hooks before upgrade, batch deployment, delete, restore and other high-risk operations; the hooks run only while the application is open.

- [ ] **Step 4: Run tests**

Run: `cargo test --test restore_migration && cargo test --test backup_retention && cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-storage/src/backup crates/skillhub-core/src/application/backup_service.rs crates/skillhub-core/src/api/command.rs tests/integration/restore_migration.rs tests/integration/backup_retention.rs
git commit -m "feat: restore and retain portable backups safely"
```

---

### Task 3: Implement standard export and uninstall preparation

**Files:**
- Create: `crates/skillhub-core/src/export/mod.rs`
- Create: `crates/skillhub-storage/src/export/mod.rs`
- Create: `crates/skillhub-core/src/application/uninstall_service.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/export_uninstall.rs`

**Interfaces:**
- Produces: `ExportPlan`, `ExportSelection`, `StandardExport`, `UninstallImpact`, `PrepareStandardExport`, `CreateStandardExport`, `PrepareUninstall`, `ApplyUninstallDecision`.

- [ ] **Step 1: Write generic export and uninstall impact tests**

```rust
#[tokio::test]
async fn standard_export_is_generic_and_does_not_generate_platform_upload_packages() {
    let app = export_fixture().await;
    let export = app.create_standard_export([skill_id()]).await.unwrap();
    assert!(export.root.join("skills").exists());
    assert!(!export.root.join("chatgpt-upload.zip").exists());
    assert!(!export.root.join("claude-desktop-package").exists());
}

#[tokio::test]
async fn uninstall_preparation_lists_managed_targets_before_local_data_removal() {
    let app = uninstall_fixture().await;
    let impact = app.prepare_uninstall().await.unwrap();
    assert!(!impact.deployments.is_empty());
    assert!(impact.actions.contains(&UninstallAction::UndeployAll));
    assert!(impact.actions.contains(&UninstallAction::LeaveTargetsIndependent));
}

#[tokio::test]
async fn standard_export_pauses_on_possible_credential_and_supports_versions_and_combinations() {
    let app = export_fixture_with_sensitive_skill().await;
    let plan = app.prepare_export(ExportSelection::Combination(combination_id()), VersionSelection::History([version_id()])).await.unwrap();
    assert_eq!(plan.sensitive_items.len(), 1);
    assert!(app.commit_export_without_decision(plan.id).await.is_err());
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --test export_uninstall`

Expected: FAIL with missing export/uninstall services.

- [ ] **Step 3: Implement generic export and explicit uninstall choices**

Export selected single/multiple Skills or combinations, with current or selected historical versions, as a standard folder or archive plus neutral manifest, source/license/local-modification markers, optional requirement/compatibility summary and checksums. Run the same sensitive-content preflight with resolve/exclude/explicit-include choices; exclude SkillHub credentials, evidence, operations, device paths and private settings. Uninstall preparation offers backup, standard export, undeploy owned targets, convert links/copies to verified independent copies, remove only device data, retain central library, optionally clear credentials, or cancel. It never deletes user data merely because the application binary is removed.

- [ ] **Step 4: Run tests**

Run: `cargo test --test export_uninstall`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/export crates/skillhub-core/src/application/uninstall_service.rs crates/skillhub-core/src/api crates/skillhub-storage/src/export tests/integration/export_uninstall.rs
git commit -m "feat: export Skills and prepare safe uninstall choices"
```

---

### Task 4: Implement lightweight CLI with shared facade and JSON output

**Files:**
- Create: `crates/skillhub-cli/Cargo.toml`
- Create: `crates/skillhub-cli/src/main.rs`
- Create: `crates/skillhub-cli/src/args.rs`
- Create: `crates/skillhub-cli/src/output.rs`
- Create: `crates/skillhub-cli/src/commands/mod.rs`
- Modify: `Cargo.toml`
- Test: `crates/skillhub-cli/tests/cli.rs`

**Interfaces:**
- Consumes: `ApplicationFacade`, all shared commands/queries.
- Produces binary: `skillhub`; commands `list`, `search`, `scan`, `import`, `deploy`, `undeploy`, `align`, `update`, `check`, `health`, `pending`, `backup`, `restore`, `project-assemble`, `status`.

- [ ] **Step 1: Write stable JSON and no-second-logic tests**

```rust
#[test]
fn json_output_uses_codes_and_ids_not_localized_sentences() {
    let output = run_cli(["status", "--json"]);
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(json["schema_version"].is_number());
    assert!(json["result_code"].is_string());
    assert!(json.to_string().find("部署成功").is_none());
}

#[test]
fn deploy_subcommand_calls_the_same_prepare_and_commit_commands() {
    let facade = recording_facade();
    run_cli_with(facade.clone(), ["deploy", "--skill", skill_id_text(), "--target", target_id_text()]);
    assert_eq!(facade.command_types(), ["prepare_deployment", "commit_deployment"]);
}

#[test]
fn non_interactive_high_risk_command_requires_explicit_authorization_flag() {
    let output = run_cli(["undeploy", "--all", "--non-interactive"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--authorize-high-risk"));
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p skillhub-cli --test cli`

Expected: FAIL because the CLI crate does not exist.

- [ ] **Step 3: Implement clap argument mapping and localized text output**

Human output localizes stable message codes for zh-CN/en-US; JSON output includes schema version, command, operation ID, stable code and structured payload. Interactive writes display the prepare-plan summary and require confirmation. Non-interactive writes require `--yes`; high-risk writes additionally require `--authorize-high-risk` followed by the exact fingerprint returned by the prepare command. Mutations generate or accept `--operation-id` and use the same single-writer coordinator as desktop.

- [ ] **Step 4: Run tests**

Run: `cargo test -p skillhub-cli && cargo run -p skillhub-cli -- --help`

Expected: PASS; help lists only supported file-management functions and no arbitrary exec command.

- [ ] **Step 5: Commit**

```bash
git add -- Cargo.toml Cargo.lock crates/skillhub-cli
git commit -m "feat: add shared-core SkillHub CLI"
```

---

### Task 5: Implement local logs, redaction and runtime scheduler boundary

**Files:**
- Create: `crates/skillhub-adapters/src/logging/mod.rs`
- Create: `crates/skillhub-adapters/src/logging/redaction.rs`
- Create: `crates/skillhub-core/src/application/scheduler.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `tests/integration/log_privacy.rs`
- Test: `tests/integration/scheduler_lifetime.rs`

**Interfaces:**
- Produces: `LocalLogConfig`, `RedactingWriter`, `RuntimeScheduler::start`, `RuntimeScheduler::stop`.

- [ ] **Step 1: Write redaction and no-upload tests**

```rust
#[test]
fn logs_keep_operation_context_and_remove_secrets_and_skill_body() {
    let text = render_test_log(event_with_secret_and_body());
    assert!(text.contains("operation_id"));
    assert!(!text.contains("sk-secret"));
    assert!(!text.contains("entire SKILL.md body"));
}

#[tokio::test]
async fn scheduler_stops_with_application_and_creates_no_background_service() {
    let fixture = scheduler_fixture().await;
    fixture.close_app().await;
    assert_eq!(fixture.running_jobs().await, 0);
    assert!(!fixture.installed_service_marker().exists());
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test --test log_privacy && cargo test --test scheduler_lifetime`

Expected: FAIL with missing logging/scheduler.

- [ ] **Step 3: Implement rotating local logs and in-process jobs**

Record stable event code, operation ID, phase, duration, counts and redacted error params. Scheduler starts scan/update/backup jobs only after local bootstrap and stops on app exit; the network master switch suppresses online jobs. Do not add telemetry, crash upload, service installation or tray APIs.

- [ ] **Step 4: Run tests**

Run: `cargo test --test log_privacy && cargo test --test scheduler_lifetime`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-adapters/src/logging crates/skillhub-core/src/application/scheduler.rs apps/desktop/src-tauri/src/lib.rs tests/integration/log_privacy.rs tests/integration/scheduler_lifetime.rs
git commit -m "feat: add private local logging and in-process scheduling"
```

---

### Task 6: Add migration fixtures and upgrade/rollback gates

**Files:**
- Create: `fixtures/databases/schema-1.sqlite`
- Create: `fixtures/databases/schema-2.sqlite`
- Create: `tests/integration/database_upgrade.rs`
- Create: `crates/skillhub-storage/src/database/recovery_point.rs`
- Modify: `crates/skillhub-storage/src/database/migrations.rs`

**Interfaces:**
- Produces: migration recovery point and fixture-based upgrade verification.

- [ ] **Step 1: Write upgrade and failed-migration restoration tests**

```rust
#[test]
fn every_supported_old_fixture_upgrades_and_preserves_catalog_counts() {
    for fixture in supported_database_fixtures() {
        let expected = fixture.expected_counts();
        let db = open_and_migrate(fixture.copy()).unwrap();
        assert_eq!(db.catalog_counts().unwrap(), expected);
    }
}

#[test]
fn failed_migration_restores_the_pre_upgrade_database() {
    let fixture = migration_fault_fixture();
    let before = file_hash(fixture.database());
    assert!(fixture.open_and_migrate().is_err());
    assert_eq!(file_hash(fixture.database()), before);
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --test database_upgrade`

Expected: FAIL until recovery-point integration exists.

- [ ] **Step 3: Implement same-volume recovery copy and verification**

Create a recovery point before migration, migrate a working copy, run integrity/foreign-key/application checks, replace only on success and retain the recovery point until the new database opens successfully.

- [ ] **Step 4: Run tests**

Run: `cargo test --test database_upgrade && cargo test -p skillhub-storage --test migrations`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- fixtures/databases tests/integration/database_upgrade.rs crates/skillhub-storage/src/database
git commit -m "test: verify database upgrades and rollback"
```

---

### Task 7: Add performance fixtures and release acceptance suite

**Files:**
- Create: `tests/performance_suite.rs`
- Create: `tests/performance/generate_fixture.rs`
- Create: `tests/performance/startup.rs`
- Create: `tests/performance/full_scan.rs`
- Create: `tests/performance/search.rs`
- Create: `tests/performance/backup_restore.rs`
- Create: `tests/performance/batch_deploy.rs`
- Create: `tests/performance/reference-hardware.md`
- Create: `.github/workflows/performance.yml`

**Interfaces:**
- Produces: reproducible 100/300 Skill fixtures and machine-readable benchmark reports.

- [ ] **Step 1: Define deterministic fixture distribution**

`tests/performance_suite.rs` declares `generate_fixture`, `startup`, `full_scan`, `search`, `backup_restore`, and `batch_deploy` with explicit `#[path = "performance/startup.rs"] mod startup;`-style module declarations for each named file. Generate Skills from a fixed seed with small/medium/large Markdown, code blocks, local images, tags, sources, versions and deployment relations. The 100-Skill set measures interactive startup; the 300-Skill set measures full scan/search/backup/restore/batch deployment.

- [ ] **Step 2: Write measured assertions**

```rust
#[test]
fn cached_bootstrap_for_100_skills_meets_reference_threshold() {
    let report = measure_cached_bootstrap(fixture_100());
    assert!(report.interactive_ms <= reference_threshold_ms("cached_bootstrap", current_reference_profile()));
}
```

Use recorded, reviewed thresholds for the named runner profile; non-reference machines report metrics without flaky failure.

- [ ] **Step 3: Run performance suite and capture baseline**

Run: `cargo test --test performance_suite -- --nocapture`

Expected: a JSON report with fixture seed, OS, CPU, storage type, app commit, interactive time and background task times.

- [ ] **Step 4: Add scheduled/manual workflow**

Run reference benchmarks on controlled Windows and macOS jobs, upload reports, and fail only when a reference metric exceeds its committed threshold. Do not upload Skill content or developer paths.

- [ ] **Step 5: Commit**

```bash
git add -- tests/performance .github/workflows/performance.yml
git commit -m "test: benchmark 100 and 300 Skill workloads"
```

---

### Task 8: Add supply-chain validation and SBOM generation

**Files:**
- Create: `.github/dependabot.yml`
- Create: `.github/workflows/supply-chain.yml`
- Create: `scripts/verify_frontend_lifecycle_scripts.ps1`
- Create: `scripts/verify_frontend_lifecycle_scripts.sh`
- Create: `docs/dependency-policy.md`
- Modify: `deny.toml`
- Modify: `package.json`

**Interfaces:**
- Produces: advisory/license/source checks, lifecycle-script allowlist verification and release SBOM artifacts.

- [ ] **Step 1: Write lifecycle-script policy with an empty-by-default allowlist**

Scripts read `pnpm-lock.yaml`, list packages declaring install lifecycle scripts and fail when a package is not recorded with package/version/reason in `docs/dependency-policy.md`. They do not execute those scripts.

- [ ] **Step 2: Add Rust/frontend advisory and license checks**

Workflow runs Cargo advisory/license/source checks, frontend audit, lockfile integrity, committed generated-binding check and secret scan. Pin GitHub Actions by immutable commit SHA and document each action source.

- [ ] **Step 3: Generate release SBOMs**

Produce CycloneDX JSON for Rust and frontend graphs and combine them into a release artifact with the source commit. Do not include credentials or filesystem paths.

- [ ] **Step 4: Run local policy checks**

Run: `cargo deny check advisories bans licenses sources && pwsh -File scripts/verify_frontend_lifecycle_scripts.ps1 && pnpm audit --prod`

Expected: exit 0, or reviewed advisory exceptions with exact IDs and expiration dates in `docs/dependency-policy.md`.

- [ ] **Step 5: Commit**

```bash
git add -- .github/dependabot.yml .github/workflows/supply-chain.yml scripts docs/dependency-policy.md deny.toml package.json pnpm-lock.yaml
git commit -m "ci: enforce dependency and supply-chain policy"
```

---

### Task 9: Implement manual application update checks and trust policy

**Files:**
- Create: `crates/skillhub-core/src/app_update/mod.rs`
- Create: `crates/skillhub-core/src/app_update/model.rs`
- Create: `crates/skillhub-adapters/src/app_update/github_releases.rs`
- Create: `crates/skillhub-storage/src/database/app_update_repository.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/app_update.rs`

**Interfaces:**
- Produces: `BuildTrust`, `ApplicationUpdate`, `CheckApplicationUpdate`, `OpenOfficialRelease`, `SetApplicationUpdatePolicy`.

- [ ] **Step 1: Write signed-channel and manual-only tests**

```rust
#[tokio::test]
async fn unsigned_windows_and_adhoc_macos_builds_only_offer_official_release_page() {
    for trust in [BuildTrust::WindowsUnsigned, BuildTrust::MacosAdHoc] {
        let app = update_fixture(trust).await;
        let update = app.check_update().await.unwrap();
        assert_eq!(update.install_action, InstallAction::OpenOfficialRelease);
        assert!(app.install_update(update.id).await.is_err());
    }
}

#[tokio::test]
async fn network_off_skips_update_check_without_affecting_local_startup() {
    let app = update_fixture_with_network_disabled().await;
    assert_eq!(app.check_update().await.unwrap_err().code.as_str(), "network.disabled");
    assert!(app.get_bootstrap_snapshot().await.is_ok());
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --test app_update`

Expected: FAIL with missing application-update service.

- [ ] **Step 3: Implement official-release lookup and trust gate**

Query only the configured official GitHub repository releases endpoint after local bootstrap and according to user policy. Validate semantic version, release URL and expected platform asset names. Unsigned/unnotarized channels return a manual release-page action only. Keep application update policy separate from Skill auto-check/auto-upgrade settings.

- [ ] **Step 4: Run tests**

Run: `cargo test --test app_update && cargo test --test scheduler_lifetime`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/app_update crates/skillhub-core/src/api crates/skillhub-adapters/src/app_update crates/skillhub-storage/src/database/app_update_repository.rs tests/integration/app_update.rs
git commit -m "feat: check application updates with platform trust gates"
```

---

### Task 10: Build Windows NSIS and macOS Universal DMG release workflows

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `apps/desktop/src-tauri/tauri.windows.conf.json`
- Create: `apps/desktop/src-tauri/tauri.macos.conf.json`
- Create: `docs/install/windows-unsigned.md`
- Create: `docs/install/macos-unnotarized.md`
- Create: `docs/release-process.md`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Test: `.github/workflows/release.yml`

**Interfaces:**
- Produces: Windows x64/ARM64 NSIS artifacts, macOS Universal DMG, checksums, SBOM and release metadata from one commit.

- [ ] **Step 1: Configure current-user Windows installer**

Set NSIS install mode to current user, product/version metadata and supported architectures. The release note and settings update UI identify the package as unsigned until a trusted publisher configuration is present.

- [ ] **Step 2: Configure ad-hoc Universal macOS build**

Build both architectures and bundle a Universal DMG with ad-hoc signing. Include the exact official “still open” route in documentation; never include a Gatekeeper-disable command.

- [ ] **Step 3: Add artifact provenance and checksums**

Workflow checks out the requested tag commit, validates locks/tests, builds both platforms, generates SHA-256 and SBOM, and attaches artifacts to a draft GitHub Release. It must not enable in-app automatic installation for unsigned/unnotarized channels.

- [ ] **Step 4: Validate workflow and local configs**

Run: `cargo test --workspace && pnpm --dir apps/desktop build && pnpm --dir apps/desktop tauri build --config src-tauri/tauri.windows.conf.json`

Expected on Windows: NSIS artifact produced without requiring an administrator install configuration. Run the corresponding macOS command on macOS CI and verify a Universal DMG.

- [ ] **Step 5: Commit**

```bash
git add -- .github/workflows/release.yml apps/desktop/src-tauri docs/install docs/release-process.md
git commit -m "ci: package early Windows and macOS releases"
```

---

### Task 11: Execute compatibility and release gates

**Files:**
- Create: `tests/compatibility/profile_contract.rs`
- Create: `tests/compatibility/platform_smoke.md`
- Create: `tests/compatibility/results/windows.md`
- Create: `tests/compatibility/results/macos.md`
- Create: `docs/release-checklist.md`
- Modify: `docs/Agent平台兼容性调研.md`

**Interfaces:**
- Produces: auditable fixture and true-machine compatibility evidence without overstated claims.

- [ ] **Step 1: Run every profile fixture contract**

Run: `cargo test --test profile_contract`

Expected: every built-in profile expands expected Windows/macOS candidate paths and upload-only clients expose no writable target.

- [ ] **Step 2: Run full offline/no-LLM scenarios**

Run desktop and CLI with network disabled and no credential profile. Import local fixture, search, basic-check, deploy, edit, version, backup, restore and undeploy must pass.

- [ ] **Step 3: Run available real-client smoke tests**

For each actually installed client, execute the uniform cases from `docs/Agent平台兼容性调研.md`: discover, deploy, file visibility, external change, collect, undeploy and ownership preservation. Record “not installed—not true-machine verified” for unavailable clients instead of inferring success.

- [ ] **Step 4: Run release checklist with fresh evidence**

Run Rust format/lint/tests, frontend lint/tests/build, E2E, migration, backup, performance, supply-chain and package builds. Record exact commands, commit, artifact hashes and failures in `docs/release-checklist.md`.

- [ ] **Step 5: Commit observed compatibility evidence**

```bash
git add -- tests/compatibility docs/release-checklist.md docs/Agent平台兼容性调研.md
git commit -m "test: record SkillHub release compatibility evidence"
```

---

## Plan Verification

Run fresh on the release commit:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
pnpm install --frozen-lockfile --ignore-scripts
pnpm check:frontend
pnpm test:frontend
pnpm test:e2e
cargo deny check advisories bans licenses sources
```

Then verify Windows/macOS packages, checksums, SBOMs, backup restore, database migration, offline mode, no-LLM mode and available real-client smoke tests. Publish only from the verified commit and keep early updates manual until the respective platform trust path is enabled.
