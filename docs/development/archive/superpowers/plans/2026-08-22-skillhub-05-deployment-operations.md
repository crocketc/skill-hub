# SkillHub Deployment and Recoverable Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement idempotent operation journaling, deployment planning and execution, cross-platform link/copy modes, batch outcomes, external-change collection, safe undeploy/delete, health repair and crash recovery.

**Architecture:** Every mutation is an `OperationId`-keyed state machine serialized through one library writer. Deployment planners make no changes; executors prepare, apply, verify and commit each target while preserving per-target results and ownership evidence.

**Tech Stack:** Rust, Tokio, filesystem APIs, Windows junction/symlink APIs, macOS symlink APIs, rusqlite transactions, SHA-256, fault-injection testkit.

**Spec:** `docs/需求文档.md` 4.3–4.5, 5.21–5.24, 5.31–5.38; `docs/产品与交互设计.md` sections 10, 11, 14, 15; `docs/技术架构设计.md` 8–9.

## Global Constraints

- Deployment means managed file placement only; never report Agent loading, trust, invocation or usability.
- Prefer symlink, use Windows directory junction only when capability checks permit, and use managed copy as the universal fallback.
- Do not require administrator privileges or Windows Developer Mode.
- Never overwrite unknown, built-in, plugin or externally modified content silently.
- Batch results preserve success, skipped, conflict, failure and pending-recovery outcomes per target.
- Removing one deployment preserves the central library and unrelated deployments.

---

### Task 1: Implement the single-writer operation journal

**Files:**
- Create: `crates/skillhub-core/src/application/operation_service.rs`
- Create: `crates/skillhub-core/src/operation/journal.rs`
- Create: `crates/skillhub-storage/src/database/operation_repository.rs`
- Modify: `crates/skillhub-core/src/operation.rs`
- Test: `tests/integration/operation_journal.rs`

**Interfaces:**
- Produces: `OperationJournal`, `OperationRepository`, `OperationService::run`, `OperationService::cancel`, `OperationService::prepare_undo`, `OperationService::commit_undo`, `OperationContext`, query `ListOperations`.

- [ ] **Step 1: Write idempotency and serialization tests**

```rust
#[tokio::test]
async fn repeated_operation_id_returns_the_same_result_without_second_write() {
    let app = operation_fixture().await;
    let id = OperationId::new();
    let first = app.run_counted_write(id).await.unwrap();
    let second = app.run_counted_write(id).await.unwrap();
    assert_eq!(first, second);
    assert_eq!(app.write_count(), 1);
}

#[tokio::test]
async fn two_mutations_do_not_enter_applying_phase_together() {
    let app = operation_fixture().await;
    let (a, b) = tokio::join!(app.run_blocking_write(), app.run_blocking_write());
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(app.maximum_simultaneous_applying(), 1);
}

#[tokio::test]
async fn reversible_operation_exposes_one_whole_operation_undo_not_global_time_travel() {
    let app = operation_fixture().await;
    let completed = app.run_reversible_rename().await.unwrap();
    let plan = app.prepare_undo(completed.operation_id).await.unwrap();
    assert_eq!(plan.inverse_kind, "rename_skill");
    app.commit_undo(plan.id).await.unwrap();
    assert_eq!(app.current_name().await, "before");
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test --test operation_journal`

Expected: FAIL with missing operation service.

- [ ] **Step 3: Implement phase persistence and writer lock**

Persist request fingerprint, phase, progress, per-object results, inverse-operation facts and recovery data. Acquire one async writer permit before `Applying`; release it after `Committed`, `NeedsRecovery` or `RolledBack`. A repeated ID with a different request fingerprint returns `operation.id_reused_with_different_request`. Undo is allowed only when the recorded inverse preconditions still match current facts; no API exposes arbitrary whole-library time travel.

- [ ] **Step 4: Run tests**

Run: `cargo test --test operation_journal && cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/application/operation_service.rs crates/skillhub-core/src/operation crates/skillhub-storage/src/database/operation_repository.rs tests/integration/operation_journal.rs
git commit -m "feat: serialize idempotent library write operations"
```

---

### Task 2: Build deployment planning and runtime-name conflict rules

**Files:**
- Create: `crates/skillhub-core/src/deployment/mod.rs`
- Create: `crates/skillhub-core/src/deployment/model.rs`
- Create: `crates/skillhub-core/src/deployment/planner.rs`
- Create: `crates/skillhub-storage/src/database/deployment_repository.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `crates/skillhub-core/tests/deployment_planner.rs`

**Interfaces:**
- Produces: `DeploymentMode`, `DeploymentPlan`, `TargetPlan`, `TargetConflict`, `DeploymentPlanner::plan`, `DeploymentRepository`.

- [ ] **Step 1: Write mode and conflict tests**

```rust
#[test]
fn planner_prefers_link_then_junction_then_managed_copy() {
    assert_eq!(plan_with(capabilities(true, true, true)).mode, DeploymentMode::SymbolicLink);
    assert_eq!(plan_with(capabilities(false, true, true)).mode, DeploymentMode::DirectoryJunction);
    assert_eq!(plan_with(capabilities(false, false, true)).mode, DeploymentMode::ManagedCopy);
}

#[test]
fn same_runtime_name_in_one_physical_target_requires_resolution() {
    let error = plan_second_skill_named("pdf").unwrap_err();
    assert_eq!(error.code.as_str(), "deployment.target_exists");
    assert!(!error.actions.contains(&RecoveryAction::OverwriteUnknown));
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p skillhub-core --test deployment_planner`

Expected: FAIL with missing deployment model.

- [ ] **Step 3: Implement a pure planner**

Planner input includes Skill/version, selected logical targets, merged physical targets, target capabilities, existing ownership facts and optional user mode override. It returns exact paths, mode, changes, warnings and conflicts without touching disk.

- [ ] **Step 4: Run tests**

Run: `cargo test -p skillhub-core --test deployment_planner`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/deployment crates/skillhub-core/src/api/query.rs crates/skillhub-storage/src/database/deployment_repository.rs crates/skillhub-core/tests/deployment_planner.rs
git commit -m "feat: plan deployment modes and target conflicts"
```

---

### Task 3: Implement cross-platform link and managed-copy executors

**Files:**
- Create: `crates/skillhub-adapters/src/deployment/mod.rs`
- Create: `crates/skillhub-adapters/src/deployment/filesystem.rs`
- Create: `crates/skillhub-adapters/src/deployment/symlink.rs`
- Create: `crates/skillhub-adapters/src/deployment/junction_windows.rs`
- Create: `crates/skillhub-adapters/src/deployment/managed_copy.rs`
- Test: `crates/skillhub-adapters/tests/deployment_filesystem.rs`

**Interfaces:**
- Produces: `DeploymentFilesystem`, `PreparedTarget`, `AppliedTarget`, `OwnershipProof`.

- [ ] **Step 1: Write mode-specific round-trip tests**

```rust
#[test]
fn managed_copy_is_verified_against_selected_version_manifest() {
    let fixture = deployment_fixture();
    let applied = fixture.deploy(DeploymentMode::ManagedCopy).unwrap();
    assert_eq!(fixture.hash_target(&applied), fixture.selected_version_tree_hash());
    assert_eq!(applied.ownership.mode, DeploymentMode::ManagedCopy);
}

#[cfg(windows)]
#[test]
fn junction_fallback_does_not_require_elevated_test_process() {
    let fixture = deployment_fixture();
    let outcome = fixture.deploy(DeploymentMode::DirectoryJunction);
    assert!(outcome.is_ok() || outcome.unwrap_err().code.as_str() == "deployment.junction_not_supported");
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p skillhub-adapters --test deployment_filesystem`

Expected: FAIL with missing filesystem executor.

- [ ] **Step 3: Implement prepare/apply/verify/remove primitives**

Prepare in the target parent, verify no unknown owner, use atomic rename where the platform permits, and record filesystem identity plus expected tree hash. `remove_owned` accepts an `OwnershipProof` and refuses if target identity or managed-copy hash no longer matches.

- [ ] **Step 4: Run platform tests**

Run: `cargo test -p skillhub-adapters --test deployment_filesystem`

Expected: PASS on Windows and macOS; unsupported link modes return a typed capability result rather than failing the whole test suite.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-adapters/src/deployment crates/skillhub-adapters/tests/deployment_filesystem.rs
git commit -m "feat: apply verified link and copy deployments"
```

---

### Task 4: Implement single and multi-target deployment operations

**Files:**
- Create: `crates/skillhub-core/src/application/deployment_service.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/deploy_flow.rs`
- Test: `tests/integration/batch_deploy.rs`

**Interfaces:**
- Produces commands: `PrepareDeployment`, `CommitDeployment`, `CancelOperation`.
- Produces queries: `GetDeploymentPlan`, `ListDeployments`, `GetDeploymentRelations`.

- [ ] **Step 1: Write the single-target flow test**

```rust
#[tokio::test]
async fn committed_deployment_links_selected_version_and_records_relation() {
    let app = deployment_app_fixture().await;
    let plan = app.prepare_deployment(skill_id(), [codex_target()]).await.unwrap();
    let result = app.commit_deployment(plan.id).await.unwrap();
    assert_eq!(result.targets[0].status, TargetOperationStatus::Succeeded);
    assert_eq!(app.deployment(result.targets[0].deployment_id).await.version_id, selected_version());
}
```

- [ ] **Step 2: Write partial batch-failure test**

```rust
#[tokio::test]
async fn batch_keeps_success_and_reports_failed_target_separately() {
    let app = deployment_app_fixture_with_fault("second_target_apply").await;
    let result = app.deploy_to([codex_target(), claude_target()]).await.unwrap();
    assert_eq!(result.targets[0].status, TargetOperationStatus::Succeeded);
    assert_eq!(result.targets[1].status, TargetOperationStatus::Failed);
    assert!(app.target_contains_deployment(codex_target()).await);
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test --test deploy_flow && cargo test --test batch_deploy`

Expected: FAIL with missing deployment service.

- [ ] **Step 4: Implement operation orchestration**

Revalidate plans immediately before apply, emit per-target progress, verify each target, persist successes and preserve failed target recovery data. One physical target is applied once even if selected through multiple logical clients.

Run: `cargo test --test deploy_flow && cargo test --test batch_deploy`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/application/deployment_service.rs crates/skillhub-core/src/api tests/integration/deploy_flow.rs tests/integration/batch_deploy.rs
git commit -m "feat: deploy Skills to one or many targets"
```

---

### Task 5: Detect, compare and collect external deployment changes

**Files:**
- Create: `crates/skillhub-core/src/deployment/reconcile.rs`
- Create: `crates/skillhub-core/src/application/reconcile_service.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/external_changes.rs`

**Interfaces:**
- Produces: `ExternalChangeState`, `ReconcilePlan`, commands `CollectDeploymentChanges`, `RestoreDeployment`, `KeepIndependentCopy`, `IgnoreExternalChange`.

- [ ] **Step 1: Write managed-copy and link change tests**

```rust
#[tokio::test]
async fn changed_managed_copy_becomes_pending_and_collect_creates_new_version() {
    let app = deployed_copy_fixture().await;
    app.modify_target("SKILL.md", "changed externally").await;
    app.confirm_target_scan().await.unwrap();
    assert_eq!(app.external_state().await, ExternalChangeState::Modified);
    let version = app.collect_changes().await.unwrap();
    assert_eq!(app.current_version().await, version);
}

#[tokio::test]
async fn broken_link_is_reported_not_silently_recreated() {
    let app = deployed_link_fixture().await;
    app.remove_link_only().await;
    app.confirm_target_scan().await.unwrap();
    assert_eq!(app.external_state().await, ExternalChangeState::Missing);
    assert!(!app.target_exists().await);
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --test external_changes`

Expected: FAIL with missing reconcile service.

- [ ] **Step 3: Implement deterministic compare and explicit actions**

Compare filesystem identity and current selected-version manifest. Collect imports target content as a new version after basic preflight; restore reapplies the selected version; keep-independent removes the management relation but leaves files; ignore stores a scoped evidence dismissal without changing content.

- [ ] **Step 4: Run tests**

Run: `cargo test --test external_changes && cargo test --test deploy_flow`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/deployment/reconcile.rs crates/skillhub-core/src/application/reconcile_service.rs crates/skillhub-core/src/api tests/integration/external_changes.rs
git commit -m "feat: reconcile external deployment changes"
```

---

### Task 6: Implement safe undeploy, detach and delete choices

**Files:**
- Create: `crates/skillhub-core/src/application/removal_service.rs`
- Create: `crates/skillhub-core/src/deployment/removal.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/undeploy_delete.rs`

**Interfaces:**
- Produces: `RemovalImpact`, `RemovalDecision`, `PrepareUndeploy`, `CommitUndeploy`, `PrepareDeleteSkill`, `CommitDeleteSkill`, `DetachManagement`.

- [ ] **Step 1: Write dependency-choice tests**

```rust
#[tokio::test]
async fn delete_with_deployments_requires_explicit_relationship_decisions() {
    let app = deletion_fixture_with_agent_and_project_deployments().await;
    let impact = app.prepare_delete().await.unwrap();
    assert_eq!(impact.deployments.len(), 2);
    assert!(app.commit_delete_without_decisions(impact.id).await.is_err());
}

#[tokio::test]
async fn undeploy_removes_owned_target_and_preserves_central_skill() {
    let app = deployed_copy_fixture().await;
    app.undeploy(RemovalDecision::RemoveOwnedTarget).await.unwrap();
    assert!(!app.target_exists().await);
    assert!(app.central_skill_exists().await);
}

#[tokio::test]
async fn removing_one_logical_relation_from_a_shared_physical_target_does_not_delete_shared_files() {
    let app = shared_physical_target_fixture().await;
    let impact = app.prepare_undeploy(codex_logical_target()).await.unwrap();
    assert!(impact.requires_shared_target_choice);
    app.commit_undeploy(impact.keep_shared_deployment()).await.unwrap();
    assert!(app.physical_target_exists().await);
    assert!(app.logical_relation_exists(claude_logical_target()).await);
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --test undeploy_delete`

Expected: FAIL with missing removal service.

- [ ] **Step 3: Implement prepare/commit removal**

Impact includes Agent/project deployments, project configuration/pins, combinations, declared dependencies, reverse related-Skill references, source links, pending findings and unknown external references. Offer replace/remove-reference/leave/cancel choices without cascade deletion. For externally changed/unknown ownership targets, offer collect, leave independent, cancel or remove only after an explicit high-risk confirmation; never infer permission from database relation alone. When logical targets share one physical directory, offer keep shared deployment, remove all affected relations, migrate remaining relations to an exclusive directory, or detach management while explaining continued discovery; removing one logical relation never silently deletes shared files.

- [ ] **Step 4: Run tests**

Run: `cargo test --test undeploy_delete && cargo test --test external_changes`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/application/removal_service.rs crates/skillhub-core/src/deployment/removal.rs crates/skillhub-core/src/api tests/integration/undeploy_delete.rs
git commit -m "feat: undeploy and delete Skills with dependency choices"
```

---

### Task 7: Add health checks, repair plans and crash recovery

**Files:**
- Create: `crates/skillhub-core/src/health/mod.rs`
- Create: `crates/skillhub-core/src/health/checks.rs`
- Create: `crates/skillhub-core/src/application/recovery_service.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/recovery.rs`
- Test: `tests/integration/health_repair.rs`

**Interfaces:**
- Produces: `HealthFinding`, `RepairPlan`, `RecoveryCandidate`, `RunHealthCheck`, `PrepareRepair`, `CommitRepair`, `ListRecoveryCandidates`, `ResolveRecovery`.

- [ ] **Step 1: Write interrupted-operation recovery test**

```rust
#[tokio::test]
async fn restart_detects_prepared_target_and_offers_verified_completion_or_rollback() {
    let fixture = interrupted_deployment_fixture("after_target_apply_before_db_commit").await;
    let restarted = fixture.restart().await;
    let candidates = restarted.list_recovery_candidates().await.unwrap();
    assert_eq!(candidates.len(), 1);
    assert!(candidates[0].actions.contains(&RecoveryAction::CompleteOperation));
    assert!(candidates[0].actions.contains(&RecoveryAction::RollbackOperation));
}
```

- [ ] **Step 2: Write deterministic health-repair test**

```rust
#[tokio::test]
async fn health_check_reports_orphan_manifest_and_repair_never_guesses_content() {
    let app = health_fixture_with_orphan_manifest().await;
    let finding = app.run_health_check().await.unwrap().single();
    assert_eq!(finding.code, "health.orphan_manifest");
    assert_eq!(finding.repair, RepairAction::RemoveOrphanMetadata);
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test --test recovery && cargo test --test health_repair`

Expected: FAIL with missing recovery/health services.

- [ ] **Step 4: Implement evidence-based repair**

Health checks cover manifest/object integrity, missing current versions, stale temp files, broken owned links, missing managed copies, orphan database rows and unfinished operations. Repairs are deterministic and individually previewed; do not call LLM or generate a diagnostic report.

Run: `cargo test --test recovery && cargo test --test health_repair && cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/health crates/skillhub-core/src/application/recovery_service.rs crates/skillhub-core/src/api tests/integration/recovery.rs tests/integration/health_repair.rs
git commit -m "feat: recover interrupted operations and repair deterministic faults"
```

---

### Task 8: Implement supported Agent call-policy preview, apply and restore

**Files:**
- Create: `crates/skillhub-core/src/call_policy/mod.rs`
- Create: `crates/skillhub-core/src/call_policy/model.rs`
- Create: `crates/skillhub-core/src/application/call_policy_service.rs`
- Create: `crates/skillhub-adapters/src/agent/call_policy.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/call_policy.rs`

**Interfaces:**
- Produces: `CallPolicy`, `CallPolicyCapability`, `CallPolicyPlan`, `PrepareCallPolicyChange`, `CommitCallPolicyChange`, `RestoreOriginalCallPolicy`.

- [ ] **Step 1: Write supported/unsupported and restore tests**

```rust
#[tokio::test]
async fn supported_target_previews_exact_change_and_can_restore_original() {
    let app = call_policy_fixture(CallPolicyCapability::Editable).await;
    let plan = app.prepare_call_policy(CallPolicy::ManualOnly).await.unwrap();
    assert_eq!(plan.before, CallPolicy::AutomaticAndManual);
    assert_eq!(plan.after, CallPolicy::ManualOnly);
    app.commit_call_policy(plan.id).await.unwrap();
    app.restore_original_call_policy(skill_id()).await.unwrap();
    assert_eq!(app.current_call_policy().await, CallPolicy::AutomaticAndManual);
}

#[tokio::test]
async fn unsupported_target_is_displayable_but_not_mutated() {
    let app = call_policy_fixture(CallPolicyCapability::ReadOnlyRecognized).await;
    assert_eq!(app.current_call_policy().await, CallPolicy::AutomaticOnlyOrHidden);
    assert_eq!(app.prepare_call_policy(CallPolicy::ManualOnly).await.unwrap_err().code.as_str(), "call_policy.not_supported");
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --test call_policy`

Expected: FAIL with missing call-policy service.

- [ ] **Step 3: Implement profile-declared call-policy adapters**

Support `AutomaticAndManual` and `ManualOnly` changes only for profiles with an evidence-backed writable mapping. Recognize `AutomaticOnlyOrHidden` without promising mutation. Preview exact managed fields/files, save the original value with the deployment relation, apply through the operation journal and restore only when ownership/preconditions still match.

- [ ] **Step 4: Run tests**

Run: `cargo test --test call_policy && cargo test --test deploy_flow`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/call_policy crates/skillhub-core/src/application/call_policy_service.rs crates/skillhub-core/src/api crates/skillhub-adapters/src/agent/call_policy.rs tests/integration/call_policy.rs
git commit -m "feat: manage supported Agent call policies"
```

---

### Task 9: Implement exact ignore rules and reversible pending deferrals

**Files:**
- Create: `crates/skillhub-core/src/ignore/mod.rs`
- Create: `crates/skillhub-core/src/ignore/model.rs`
- Create: `crates/skillhub-storage/src/database/ignore_repository.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/ignore_rules.rs`

**Interfaces:**
- Produces: `IgnoreRule`, `IgnoreSubject`, `IgnoreRepository`, commands `CreateIgnoreRule`, `RemoveIgnoreRule`, query `ListIgnoreRules`.

- [ ] **Step 1: Write exact-scope and forbidden-pattern tests**

```rust
#[tokio::test]
async fn exact_path_and_exact_skill_ignore_do_not_match_neighbors() {
    let app = ignore_fixture().await;
    app.ignore_exact_path(path("skills/pdf")).await.unwrap();
    assert!(app.is_ignored(path("skills/pdf")).await);
    assert!(!app.is_ignored(path("skills/pdf-tools")).await);
}

#[tokio::test]
async fn wildcard_regex_script_and_nested_rules_are_rejected() {
    let app = ignore_fixture().await;
    for value in ["skills/*", "regex:^pdf", "if unsafe then ignore"] {
        assert_eq!(app.create_raw_ignore(value).await.unwrap_err().code.as_str(), "ignore.only_exact_subjects_supported");
    }
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --test ignore_rules`

Expected: FAIL with missing ignore rules.

- [ ] **Step 3: Implement closed subject types**

Allow only a safe-path identity, exact `SkillId`, or exact pending-item identity with optional `defer_until`. Store reason/time and expose list/remove. Apply ignore only at the matching scan/pending projection boundary; it never authorizes deletion, suppresses unrelated security findings or changes file content.

- [ ] **Step 4: Run tests**

Run: `cargo test --test ignore_rules && cargo test --test bootstrap_pending`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/ignore crates/skillhub-core/src/api crates/skillhub-storage/src/database/ignore_repository.rs tests/integration/ignore_rules.rs
git commit -m "feat: add exact reversible ignore rules"
```

---

## Plan Verification

Run fresh with all fault points enabled:

```text
cargo test --test operation_journal
cargo test -p skillhub-adapters --test deployment_filesystem
cargo test --test batch_deploy
cargo test --test external_changes
cargo test --test undeploy_delete
cargo test --test recovery
cargo test --test health_repair
cargo test --test call_policy
cargo test --test ignore_rules
```

Inspect every removal test: the central Skill survives undeploy, unknown ownership is never deleted, repeated operation IDs do not duplicate effects, and partial batch success remains queryable.
