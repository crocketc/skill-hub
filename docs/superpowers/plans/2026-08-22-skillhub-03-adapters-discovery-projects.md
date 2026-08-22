# SkillHub Agent Adapters, Discovery, and Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement versioned Agent profiles, client/target discovery, shared physical-target merging, project registration and shared Skill configuration, bounded initialization scanning, incremental rescanning, and in-process file watching.

**Architecture:** Declarative profiles describe known paths and capabilities; discovery expands them against injected OS/user roots and produces facts, never runtime-compatibility claims. Projects use the same logical/physical target model, while scan and watch services publish fact-change events into the shared application facade.

**Tech Stack:** Rust, serde, JSON Schema, notify, Tokio, globset, temporary filesystem fixtures.

**Spec:** `docs/需求文档.md` 5.1–5.6, 5.22–5.25, 5.31, 5.33–5.34; `docs/Agent平台兼容性调研.md`; `docs/技术架构设计.md` 6.2, 10, 11, 16.

## Global Constraints

- Do not detect Agent versions, login, authorization, trust, loading, invocation or Skill runtime usability.
- A brand's CLI, desktop app, IDE extension and work product remain separate clients.
- Shared physical directories are merged by filesystem identity, not raw path spelling.
- No initialization scan may search an entire drive or unrestricted home directory.
- `~/.agents/skills` is a recognized source directory, not a universal deployment standard.
- File-watch events are hints; persisted state changes only after a confirming scan.

---

### Task 1: Define and validate the Agent profile schema

**Files:**
- Create: `crates/skillhub-core/src/agent/mod.rs`
- Create: `crates/skillhub-core/src/agent/profile.rs`
- Create: `crates/skillhub-core/src/agent/target.rs`
- Create: `crates/skillhub-adapters/Cargo.toml`
- Create: `crates/skillhub-adapters/src/lib.rs`
- Create: `crates/skillhub-adapters/src/agent/mod.rs`
- Create: `crates/skillhub-adapters/src/agent/profile_loader.rs`
- Create: `crates/skillhub-adapters/profiles/schema.json`
- Modify: `Cargo.toml`
- Test: `crates/skillhub-adapters/tests/profile_schema.rs`

**Interfaces:**
- Produces: `AgentProfile`, `ClientKind`, `TargetScope`, `PathCandidate`, `DeploymentCapability`, `ProfileCatalog`.

- [ ] **Step 1: Write valid and dangerous profile tests**

```rust
#[test]
fn profile_declares_paths_and_capabilities_but_no_commands() {
    let profile = load_fixture_profile("codex").unwrap();
    assert!(!profile.clients.is_empty());
    assert!(profile.clients.iter().all(|c| !c.path_candidates.is_empty()));
    assert!(!serde_json::to_string(&profile).unwrap().contains("shell"));
}

#[test]
fn rejects_custom_profile_with_command_or_unbounded_scan_root() {
    let error = parse_custom_profile(include_str!("fixtures/unsafe-command.json")).unwrap_err();
    assert_eq!(error.code.as_str(), "agent_profile.invalid_capability");
}
```

- [ ] **Step 2: Run profile tests**

Run: `cargo test -p skillhub-adapters --test profile_schema`

Expected: FAIL because profile types and validation do not exist.

- [ ] **Step 3: Implement closed-schema validation**

The schema includes profile version, research date, official reference URLs, brand, client ID/type, supported OS, path candidates, target scope, Skill marker name, documented directory precedence (`preferred`, `lower_priority_copy`, `may_coexist`, or `unknown`), call-policy capability, default deployment capabilities and limitations. Reject unknown fields in security-sensitive sections and all command/script fields.

- [ ] **Step 4: Run tests**

Run: `cargo test -p skillhub-adapters --test profile_schema && cargo test -p skillhub-core agent`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- Cargo.toml Cargo.lock crates/skillhub-core/src/agent crates/skillhub-adapters
git commit -m "feat: define versioned Agent profile schema"
```

---

### Task 2: Encode researched built-in profiles and fixtures

**Files:**
- Create: `crates/skillhub-adapters/profiles/openai.json`
- Create: `crates/skillhub-adapters/profiles/anthropic.json`
- Create: `crates/skillhub-adapters/profiles/google.json`
- Create: `crates/skillhub-adapters/profiles/cursor.json`
- Create: `crates/skillhub-adapters/profiles/github-copilot.json`
- Create: `crates/skillhub-adapters/profiles/windsurf.json`
- Create: `crates/skillhub-adapters/profiles/cline.json`
- Create: `crates/skillhub-adapters/profiles/opencode.json`
- Create: `crates/skillhub-adapters/profiles/trae.json`
- Create: `crates/skillhub-adapters/profiles/qoder.json`
- Create: `crates/skillhub-adapters/profiles/codebuddy.json`
- Create: `crates/skillhub-adapters/profiles/comate.json`
- Create: `crates/skillhub-adapters/profiles/kimi.json`
- Create: `crates/skillhub-adapters/profiles/zcode.json`
- Create: `crates/skillhub-adapters/profiles/openclaw.json`
- Create: `crates/skillhub-adapters/profiles/hermes.json`
- Create: `crates/skillhub-adapters/profiles/grok.json`
- Create: `fixtures/agents/builtin-profile-expectations.json`
- Test: `crates/skillhub-adapters/tests/builtin_profiles.rs`

**Interfaces:**
- Consumes: `ProfileCatalog`.
- Produces: embedded built-in profile catalog and fixture expectations.

- [ ] **Step 1: Write catalog completeness test**

```rust
#[test]
fn builtin_catalog_contains_every_researched_brand_and_no_roo_code() {
    let ids = ProfileCatalog::builtin().profile_ids();
    for expected in ["openai", "anthropic", "google", "cursor", "github-copilot", "windsurf", "cline", "opencode", "trae", "qoder", "codebuddy", "comate", "kimi", "zcode", "openclaw", "hermes", "grok"] {
        assert!(ids.contains(expected), "missing {expected}");
    }
    assert!(!ids.contains("roo-code"));
}
```

- [ ] **Step 2: Run test and observe missing profiles**

Run: `cargo test -p skillhub-adapters --test builtin_profiles`

Expected: FAIL listing missing profiles.

- [ ] **Step 3: Transcribe only evidence-backed profile facts**

For each profile, copy client boundaries, path candidates and limitations from `docs/Agent平台兼容性调研.md`. Model ChatGPT desktop separately from Codex CLI/IDE, Claude Desktop separately from Claude Code, and Grok Build separately from Grok chat/bot clients. Upload-only clients declare no writable local target.

- [ ] **Step 4: Validate all profiles and fixture snapshots**

Run: `cargo test -p skillhub-adapters --test profile_schema && cargo test -p skillhub-adapters --test builtin_profiles`

Expected: PASS; every official reference URL is non-empty and every writable path claim has a fixture expectation.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-adapters/profiles fixtures/agents crates/skillhub-adapters/tests/builtin_profiles.rs
git commit -m "feat: add researched Agent compatibility profiles"
```

---

### Task 3: Discover clients and merge logical targets by physical identity

**Files:**
- Create: `crates/skillhub-core/src/agent/discovery.rs`
- Create: `crates/skillhub-adapters/src/agent/discovery.rs`
- Create: `crates/skillhub-storage/src/database/agent_repository.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `crates/skillhub-adapters/tests/discovery.rs`
- Test: `tests/integration/physical_target_merge.rs`

**Interfaces:**
- Produces: `ClientInstance`, `LogicalTarget`, `PhysicalTarget`, `DiscoverySnapshot`, `AgentRepository`, `DiscoverAgents`.

- [ ] **Step 1: Write discovery boundary tests**

```rust
#[test]
fn discovery_reports_client_and_writable_directory_without_runtime_claims() {
    let snapshot = discover_fixture("codex-windows");
    assert!(snapshot.instances.iter().any(|i| i.profile_id == "openai.codex-cli"));
    assert!(snapshot.logical_targets.iter().any(|t| t.scope == TargetScope::Global));
    assert!(snapshot.runtime_version.is_none());
    assert!(snapshot.login_state.is_none());
}

#[test]
fn two_clients_pointing_to_same_directory_share_one_physical_target() {
    let snapshot = discover_fixture("shared-agents-directory");
    assert_eq!(snapshot.logical_targets.len(), 2);
    assert_eq!(snapshot.physical_targets.len(), 1);
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p skillhub-adapters --test discovery && cargo test --test physical_target_merge`

Expected: FAIL with missing discovery adapters.

- [ ] **Step 3: Implement platform expansion and filesystem identity**

Expand only registered home/app-data/project tokens. Canonicalize existing ancestors; on Windows include volume/file identity when available and case-insensitive normalized fallback, while macOS preserves observed case and records volume case behavior. Record client presence and target read/write facts separately.

- [ ] **Step 4: Persist and query snapshots**

Replace one discovery generation transactionally and retain disappeared instances as unavailable facts so existing deployment history remains explainable. Run both tests and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/agent crates/skillhub-core/src/api/query.rs crates/skillhub-adapters/src/agent crates/skillhub-storage/src/database/agent_repository.rs crates/skillhub-adapters/tests/discovery.rs tests/integration/physical_target_merge.rs
git commit -m "feat: discover Agent clients and physical targets"
```

---

### Task 4: Add custom Agent and directory overrides

**Files:**
- Create: `crates/skillhub-core/src/agent/custom.rs`
- Create: `crates/skillhub-storage/src/database/custom_agent_repository.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/custom_agent.rs`

**Interfaces:**
- Produces commands: `CreateCustomAgent`, `UpdateCustomAgent`, `RemoveCustomAgent`, `ResetProfileOverride`.
- Produces query: `ListCustomAgents`.

- [ ] **Step 1: Write custom-directory validation tests**

```rust
#[tokio::test]
async fn custom_agent_accepts_user_selected_directory_but_rejects_commands() {
    let app = headless_app_fixture().await;
    let directory = app.workspace().create_agent_root("my-agent");
    assert!(app.create_custom_agent("My Agent", directory).await.is_ok());
    let error = app.create_custom_agent_from_json(r#"{"command":"curl bad"}"#).await.unwrap_err();
    assert_eq!(error.code.as_str(), "agent_profile.invalid_capability");
}
```

- [ ] **Step 2: Run and observe failure**

Run: `cargo test --test custom_agent`

Expected: FAIL with missing custom Agent use cases.

- [ ] **Step 3: Implement local override persistence**

Store custom and override profiles in the device database, not inside built-in JSON files. Require a file-picker-issued path grant for raw directory input; reset deletes only the override, never the target directory.

- [ ] **Step 4: Run tests**

Run: `cargo test --test custom_agent && cargo test -p skillhub-adapters`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/agent/custom.rs crates/skillhub-core/src/api crates/skillhub-storage/src/database/custom_agent_repository.rs tests/integration/custom_agent.rs
git commit -m "feat: add safe custom Agent directory profiles"
```

---

### Task 5: Implement project registry, tags, saved views and shared configuration

**Files:**
- Create: `crates/skillhub-core/src/project/mod.rs`
- Create: `crates/skillhub-core/src/project/model.rs`
- Create: `crates/skillhub-core/src/project/shared_config.rs`
- Create: `crates/skillhub-storage/src/database/project_repository.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/projects.rs`

**Interfaces:**
- Produces: `Project`, `ProjectTag`, `SavedProjectView`, `SharedSkillRequirement`, `ProjectRepository`.
- Produces commands: `RegisterProject`, `UpdateProject`, `SetProjectTags`, `SaveProjectView`, `WriteSharedProjectConfig`, `ReadSharedProjectConfig`.

- [ ] **Step 1: Write multi-tag and portable-config tests**

```rust
#[tokio::test]
async fn project_can_belong_to_multiple_saved_filter_categories() {
    let app = headless_app_fixture().await;
    let project = app.register_project("demo").await.unwrap();
    app.set_project_tags(project.id, ["client", "rust"]).await.unwrap();
    assert_eq!(app.projects_matching_all(["client", "rust"]).await.unwrap(), vec![project.id]);
}

#[test]
fn shared_config_contains_requirements_not_absolute_paths_or_skill_content() {
    let text = serialize_shared_config(shared_config_fixture()).unwrap();
    assert!(text.contains("skill_id"));
    assert!(!text.contains("C:\\Users"));
    assert!(!text.contains("full_skill_markdown"));
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test --test projects`

Expected: FAIL with missing project types.

- [ ] **Step 3: Implement registry and `.skillhub/project.json` config**

Project records store a device path and portable logical metadata separately. Shared config contains schema version, project identity hint, required Skill identity/source/name, version constraint and optional note. It never bundles Skill content or device deployment state.

- [ ] **Step 4: Run tests**

Run: `cargo test --test projects && cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/project crates/skillhub-core/src/api crates/skillhub-storage/src/database/project_repository.rs tests/integration/projects.rs
git commit -m "feat: register projects and shared Skill requirements"
```

---

### Task 6: Implement bounded initialization and incremental scan

**Files:**
- Create: `crates/skillhub-core/src/scan/mod.rs`
- Create: `crates/skillhub-core/src/scan/model.rs`
- Create: `crates/skillhub-adapters/src/scanner/mod.rs`
- Create: `crates/skillhub-adapters/src/scanner/skill_detector.rs`
- Create: `crates/skillhub-storage/src/database/scan_repository.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Test: `crates/skillhub-adapters/tests/scanner.rs`
- Test: `tests/integration/initialization_scan.rs`

**Interfaces:**
- Produces: `ScanScope`, `ScanGeneration`, `DiscoveredSkill`, `ScanService::scan`, commands `RunInitializationScan`, `ScanTargets`, `RescanSkill`.

- [ ] **Step 1: Write bounded-scope tests**

```rust
#[tokio::test]
async fn initialization_scans_only_registered_roots_and_recognizes_agents_skills() {
    let app = discovery_fixture_with_unrelated_home_content().await;
    let result = app.run_initialization_scan().await.unwrap();
    assert!(result.roots.iter().all(|r| app.allowed_roots().contains(r)));
    assert!(result.discovered.iter().any(|s| s.path.ends_with(".agents/skills/example")));
    assert!(!result.visited_paths.iter().any(|p| p.ends_with("Documents/private")));
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p skillhub-adapters --test scanner && cargo test --test initialization_scan`

Expected: FAIL with missing scanner.

- [ ] **Step 3: Implement marker-based discovery and fingerprints**

A directory is a Skill candidate only when it contains a case-aware `SKILL.md` marker according to the profile. Record root, relative path, marker metadata, size, latest modification and stable fingerprint; do not parse or hash unchanged trees again.

- [ ] **Step 4: Run scan tests and 300-Skill fixture**

Run: `cargo test -p skillhub-adapters --test scanner && cargo test --test initialization_scan`

Expected: PASS; the second scan reports zero reparsed unchanged Skills.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/scan crates/skillhub-core/src/api/command.rs crates/skillhub-adapters/src/scanner crates/skillhub-storage/src/database/scan_repository.rs crates/skillhub-adapters/tests/scanner.rs tests/integration/initialization_scan.rs
git commit -m "feat: add bounded incremental Skill scanning"
```

---

### Task 7: Add in-process watcher, event coalescing and compensation scan

**Files:**
- Create: `crates/skillhub-adapters/src/watcher/mod.rs`
- Create: `crates/skillhub-adapters/src/watcher/coalescer.rs`
- Create: `crates/skillhub-core/src/application/watch_service.rs`
- Modify: `crates/skillhub-core/src/api/event.rs`
- Test: `crates/skillhub-adapters/tests/watcher.rs`
- Test: `tests/integration/external_change_hint.rs`

**Interfaces:**
- Produces: `WatchHint`, `WatchCoalescer`, `WatchService::start`, `WatchService::stop`, `FactsChanged` event.

- [ ] **Step 1: Write coalescing and confirmation tests**

```rust
#[test]
fn repeated_editor_events_collapse_to_one_skill_hint() {
    let mut coalescer = WatchCoalescer::new(Duration::from_millis(400));
    coalescer.push(event("skills/pdf/SKILL.md"));
    coalescer.push(event("skills/pdf/SKILL.md"));
    assert_eq!(coalescer.flush_after_stable().len(), 1);
}

#[tokio::test]
async fn watcher_hint_does_not_change_facts_until_rescan_confirms_it() {
    let app = watcher_fixture().await;
    app.emit_watch_hint("skills/pdf/SKILL.md").await;
    assert_eq!(app.skill_revision("pdf").await, 1);
    app.run_scheduled_confirmation().await.unwrap();
    assert_eq!(app.skill_revision("pdf").await, 2);
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p skillhub-adapters --test watcher && cargo test --test external_change_hint`

Expected: FAIL with missing watcher.

- [ ] **Step 3: Implement in-process watcher lifecycle**

Watch only active allowed roots while the application runs. Coalesce changes by nearest recognized Skill/target, schedule confirming rescans, and trigger compensation scans after watcher overflow, app resume or directory reconnection.

- [ ] **Step 4: Run tests**

Run: `cargo test -p skillhub-adapters --test watcher && cargo test --test external_change_hint && cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-adapters/src/watcher crates/skillhub-core/src/application/watch_service.rs crates/skillhub-core/src/api/event.rs crates/skillhub-adapters/tests/watcher.rs tests/integration/external_change_hint.rs
git commit -m "feat: confirm filesystem changes through coalesced rescans"
```

---

### Task 8: Coordinate project best-effort assembly

**Files:**
- Create: `crates/skillhub-core/src/project/assembly.rs`
- Create: `crates/skillhub-core/src/application/project_assembly_service.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/project_assembly.rs`

**Interfaces:**
- Produces: `AssemblyPlan`, `AssemblyItemPlan`, `AssemblyItemStatus`, `SkillResolutionPort`, `SourcePreparationPort`, `CheckPreparationPort`, `DeploymentPreparationPort`, commands `PrepareProjectAssembly`, `CommitProjectAssembly`.
- Consumes: shared project requirements, source/import service, version resolution, checks and deployment service.

- [ ] **Step 1: Write mixed-outcome assembly test**

```rust
#[tokio::test]
async fn best_effort_assembly_keeps_each_requirement_result() {
    let app = assembly_fixture_with_satisfied_missing_and_conflicting_items().await;
    let plan = app.prepare_assembly(project_id()).await.unwrap();
    assert_eq!(plan.items[0].status, AssemblyItemStatus::AlreadySatisfied);
    assert_eq!(plan.items[1].status, AssemblyItemStatus::ReadyToAcquire);
    assert_eq!(plan.items[2].status, AssemblyItemStatus::ConflictNeedsChoice);
    let result = app.commit_assembly(plan.with_choice_for_item(2, AssemblyChoice::Skip)).await.unwrap();
    assert_eq!(result.items.len(), 3);
    assert!(result.items.iter().any(|i| i.status == AssemblyItemStatus::Skipped));
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --test project_assembly`

Expected: FAIL with missing assembly coordinator.

- [ ] **Step 3: Implement per-item orchestration**

Resolve local/current/pinned versions first, then prepare source acquisition, checks and project deployment only for missing requirements. Preserve satisfied, skipped, conflict, failed and succeeded states independently; one failed item does not roll back unrelated successful items. Require explicit choices for source ambiguity, same-name conflict and high-risk findings.

- [ ] **Step 4: Run tests**

Run: `cargo test --test project_assembly && cargo test --test projects`

Expected: PASS using recording source/check/deployment ports that implement the Plan 01 application contracts. Plan 05 replaces the recording deployment port in the headless composition root and adds the real-filesystem integration assertion.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/project/assembly.rs crates/skillhub-core/src/application/project_assembly_service.rs crates/skillhub-core/src/api tests/integration/project_assembly.rs
git commit -m "feat: assemble project Skills with per-item outcomes"
```

---

## Plan Verification

Run fresh on Windows and macOS:

```text
cargo test -p skillhub-adapters
cargo test --test physical_target_merge
cargo test --test projects
cargo test --test initialization_scan
cargo test --test external_change_hint
cargo test --test project_assembly
```

Review the built-in profile catalog against `docs/Agent平台兼容性调研.md`: every local target claim must have a source URL and fixture; upload-only clients must expose no writable local target; Roo Code must not appear.
