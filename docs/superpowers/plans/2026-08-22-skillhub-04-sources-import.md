# SkillHub Sources and Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement safe source parsing/acquisition and one unified import pipeline for local directories, recognized Skill pages, Git repositories, archives, and parsed `npx skills add ...` references.

**Architecture:** Every external input becomes a validated `SourceDescriptor`, is acquired into an isolated temporary workspace without executing content, and enters the same detection, basic preflight, duplicate/conflict, user-decision, central-library and optional deployment pipeline.

**Tech Stack:** Rust, reqwest, gix, url, zip/tar readers, SHA-256, serde, temporary files, mock HTTP server.

**Spec:** `docs/需求文档.md` 5.7–5.11, 5.15, 5.19–5.20; `docs/产品与交互设计.md` section 7; `docs/技术架构设计.md` 11–13.

## Global Constraints

- Never execute npx, Git, shell, package scripts, hooks or imported files.
- Do not require system Git, Node.js, npm or npx.
- Enforce time, size, redirect, archive-entry and expanded-size limits before committing content.
- Reject path traversal, absolute archive paths, link escape and unknown command syntax.
- Importing from a recognized Agent/project directory defaults to relationship/takeover choices; do not silently duplicate local data.
- A forced import permits an independent central object; it never authorizes overwriting an existing deployment target.

---

### Task 1: Define source descriptors and strict input parsers

**Files:**
- Create: `crates/skillhub-core/src/source/mod.rs`
- Create: `crates/skillhub-core/src/source/model.rs`
- Create: `crates/skillhub-adapters/src/source/mod.rs`
- Create: `crates/skillhub-adapters/src/source/parser.rs`
- Test: `crates/skillhub-adapters/tests/source_parser.rs`
- Create: `fixtures/imports/source-inputs.json`

**Interfaces:**
- Produces: `SourceDescriptor`, `SourceKind`, `SourceLocator`, `ParsedSourceInput`, `SourceInputParser::parse`.

- [ ] **Step 1: Write accepted and rejected input tests**

```rust
#[test]
fn parses_supported_npx_text_without_preserving_an_executable_command() {
    let parsed = SourceInputParser::parse("npx skills add github:owner/repo --skill pdf").unwrap();
    assert_eq!(parsed.descriptor.kind, SourceKind::Git);
    assert_eq!(parsed.skill_selector.as_deref(), Some("pdf"));
    assert!(parsed.executable.is_none());
}

#[test]
fn rejects_pipes_redirects_chaining_and_unknown_commands() {
    for input in ["npx skills add x | sh", "npx skills add x > out", "npx skills add x && calc", "curl x"] {
        assert_eq!(SourceInputParser::parse(input).unwrap_err().code.as_str(), "source.command_not_parseable");
    }
}
```

- [ ] **Step 2: Run parser tests**

Run: `cargo test -p skillhub-adapters --test source_parser`

Expected: FAIL with missing source parser.

- [ ] **Step 3: Implement closed parsers**

Support explicit local paths, `https` URLs, GitHub/GitLab repository URLs, and exactly the documented `npx skills add` grammar. Parse tokens without invoking a shell. Store normalized source facts and original user text separately; never carry an executable callback.

- [ ] **Step 4: Run table-driven tests**

Run: `cargo test -p skillhub-adapters --test source_parser`

Expected: PASS for every row in `source-inputs.json`.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/source crates/skillhub-adapters/src/source crates/skillhub-adapters/tests/source_parser.rs fixtures/imports/source-inputs.json
git commit -m "feat: parse safe Skill source references"
```

---

### Task 2: Build isolated acquisition workspace and archive safety

**Files:**
- Create: `crates/skillhub-adapters/src/source/acquisition.rs`
- Create: `crates/skillhub-adapters/src/source/archive.rs`
- Create: `crates/skillhub-core/src/source/acquisition.rs`
- Test: `crates/skillhub-adapters/tests/archive_safety.rs`
- Create: `fixtures/imports/valid-skill.zip`
- Create: `fixtures/imports/path-traversal.zip`
- Create: `fixtures/imports/link-escape.tar`

**Interfaces:**
- Produces: `AcquisitionLimits`, `AcquiredSource`, `AcquisitionWorkspace`, `ArchiveExtractor`.

- [ ] **Step 1: Write archive escape tests**

```rust
#[test]
fn rejects_parent_absolute_and_link_escape_entries() {
    for fixture in ["path-traversal.zip", "link-escape.tar"] {
        let error = extract_fixture(fixture).unwrap_err();
        assert_eq!(error.code.as_str(), "source.archive_path_escape");
    }
}

#[test]
fn expanded_size_limit_is_enforced_before_disk_exhaustion() {
    let error = extract_with_limits("valid-skill.zip", AcquisitionLimits { max_expanded_bytes: 8, ..test_limits() }).unwrap_err();
    assert_eq!(error.code.as_str(), "source.expanded_size_limit");
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p skillhub-adapters --test archive_safety`

Expected: FAIL with missing acquisition code.

- [ ] **Step 3: Implement bounded streaming extraction**

Count entries and expanded bytes as data is streamed. Reject absolute paths, `..`, Windows drive/UNC prefixes, devices, hard links and symbolic links whose resolved destination is outside the acquisition root. The workspace is deleted on error and never reused across imports.

- [ ] **Step 4: Run tests**

Run: `cargo test -p skillhub-adapters --test archive_safety`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/source/acquisition.rs crates/skillhub-adapters/src/source/acquisition.rs crates/skillhub-adapters/src/source/archive.rs crates/skillhub-adapters/tests/archive_safety.rs fixtures/imports
git commit -m "feat: isolate and bound Skill source extraction"
```

---

### Task 3: Implement safe HTTP and Git acquisition

**Files:**
- Create: `crates/skillhub-adapters/src/source/http.rs`
- Create: `crates/skillhub-adapters/src/source/git.rs`
- Create: `crates/skillhub-adapters/src/source/redirect_policy.rs`
- Test: `crates/skillhub-adapters/tests/http_source.rs`
- Test: `crates/skillhub-adapters/tests/git_source.rs`

**Interfaces:**
- Produces implementations of `SourceFetcher` for `HttpsSourceFetcher` and `GixSourceFetcher`.

- [ ] **Step 1: Write HTTP boundary tests**

```rust
#[tokio::test]
async fn http_fetch_rejects_non_https_private_redirect_and_oversize_body() {
    let server = source_test_server().await;
    assert_error_code(fetch(server.http_url()).await, "source.https_required");
    assert_error_code(fetch(server.redirect_to("http://127.0.0.1/private")).await, "source.redirect_blocked");
    assert_error_code(fetch(server.oversize_url()).await, "source.download_size_limit");
}
```

- [ ] **Step 2: Write Git no-system-process test**

```rust
#[tokio::test]
async fn git_fetch_uses_gix_and_disables_hooks() {
    let fixture = local_git_fixture_with_hook();
    let acquired = GixSourceFetcher::default().fetch(fixture.url()).await.unwrap();
    assert!(acquired.root.join("SKILL.md").exists());
    assert!(!fixture.hook_marker().exists());
}
```

- [ ] **Step 3: Run tests and observe failures**

Run: `cargo test -p skillhub-adapters --test http_source && cargo test -p skillhub-adapters --test git_source`

Expected: FAIL with missing fetchers.

- [ ] **Step 4: Implement bounded fetchers**

Allow HTTPS and explicitly user-selected local test repositories. Resolve every redirect through one policy, block loopback/private/link-local destinations unless the user configured an explicit private source, stream to a size-limited file, and enforce timeouts. Use gix APIs only; never spawn `git`, and never execute hooks or filters.

Run: `cargo test -p skillhub-adapters --test http_source && cargo test -p skillhub-adapters --test git_source`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-adapters/src/source crates/skillhub-adapters/tests/http_source.rs crates/skillhub-adapters/tests/git_source.rs Cargo.lock
git commit -m "feat: fetch HTTPS and Git Skill sources safely"
```

---

### Task 4: Detect one or more Skills and classify local ownership

**Files:**
- Create: `crates/skillhub-core/src/import/mod.rs`
- Create: `crates/skillhub-core/src/import/model.rs`
- Create: `crates/skillhub-adapters/src/import/detector.rs`
- Create: `crates/skillhub-adapters/src/import/ownership.rs`
- Test: `crates/skillhub-adapters/tests/import_detection.rs`

**Interfaces:**
- Produces: `ImportCandidate`, `CandidateOwnership`, `SkillDetector::detect`, `OwnershipClassifier::classify`.

- [ ] **Step 1: Write multi-Skill and ownership tests**

```rust
#[test]
fn repository_with_two_markers_yields_two_selectable_candidates() {
    let candidates = detect_fixture("multi-skill-repo").unwrap();
    assert_eq!(candidates.iter().map(|c| c.relative_root.as_str()).collect::<Vec<_>>(), ["skills/a", "skills/b"]);
}

#[test]
fn candidate_in_known_agent_directory_is_not_defaulted_to_copy() {
    let candidate = classify_fixture("agent-owned-skill").unwrap();
    assert_eq!(candidate.ownership, CandidateOwnership::KnownAgentTarget);
    assert_eq!(candidate.default_action, ImportAction::EstablishManagedRelation);
}
```

- [ ] **Step 2: Run test**

Run: `cargo test -p skillhub-adapters --test import_detection`

Expected: FAIL with missing detector.

- [ ] **Step 3: Implement bounded marker traversal and classification**

Stop descending inside a detected Skill except when the profile explicitly permits nested candidate roots. Classify central library, known Agent target, registered project, read-only built-in/plugin, arbitrary local directory and downloaded source. Detection returns facts only; it does not copy data.

- [ ] **Step 4: Run tests**

Run: `cargo test -p skillhub-adapters --test import_detection`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/import crates/skillhub-adapters/src/import crates/skillhub-adapters/tests/import_detection.rs
git commit -m "feat: detect import candidates and local ownership"
```

---

### Task 5: Implement deterministic duplicate and same-name conflict analysis

**Files:**
- Create: `crates/skillhub-core/src/import/conflict.rs`
- Create: `crates/skillhub-core/src/import/decision.rs`
- Create: `crates/skillhub-storage/src/database/import_repository.rs`
- Test: `tests/integration/import_conflicts.rs`

**Interfaces:**
- Produces: `DuplicateKind`, `ImportConflict`, `ImportDecision`, `ImportAnalysis`, `AnalyzeImport` query.

- [ ] **Step 1: Write exact and same-name conflict tests**

```rust
#[tokio::test]
async fn exact_content_and_same_name_different_content_are_distinct_results() {
    let app = import_fixture().await;
    let exact = app.analyze_import(app.fixture("pdf-identical")).await.unwrap();
    assert_eq!(exact.duplicate_kind, Some(DuplicateKind::ExactContent));
    assert!(exact.actions.contains(&ImportDecision::ReuseExisting));

    let changed = app.analyze_import(app.fixture("pdf-changed")).await.unwrap();
    assert_eq!(changed.duplicate_kind, Some(DuplicateKind::SameRuntimeNameDifferentContent));
    assert!(changed.actions.contains(&ImportDecision::KeepIndependent));
    assert!(!changed.actions.contains(&ImportDecision::OverwriteTarget));
}

#[tokio::test]
async fn duplicate_analysis_includes_read_only_builtin_and_plugin_skills() {
    let app = import_fixture_with_builtin_duplicate().await;
    let analysis = app.analyze_import(app.fixture("builtin-equivalent")).await.unwrap();
    assert_eq!(analysis.matches[0].ownership, CandidateOwnership::ReadOnlyBuiltinOrPlugin);
    assert!(analysis.actions.contains(&ImportDecision::CopyAsIndependentManagedSkill));
    assert!(!analysis.actions.contains(&ImportDecision::OverwriteExisting));
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --test import_conflicts`

Expected: FAIL with missing conflict analysis.

- [ ] **Step 3: Implement deterministic analysis order**

Compare canonical tree hash, SkillHub identity/source link, normalized runtime name, source locator and FTS/BM25 candidates in that order. Define the closed decision enum as `ReuseExisting`, `EstablishManagedRelation`, `CopyIntoLibrary`, `TakeOverAfterVerify`, `KeepIndependent`, `CopyAsIndependentManagedSkill`, and `Skip`; no overwrite-target variant exists. Exact matches offer reuse/relation/independent copy/skip. Same-name differences require explicit runtime-name resolution before deployment.

- [ ] **Step 4: Run tests**

Run: `cargo test --test import_conflicts && cargo test -p skillhub-storage search`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/import crates/skillhub-storage/src/database/import_repository.rs tests/integration/import_conflicts.rs
git commit -m "feat: classify deterministic import conflicts"
```

---

### Task 6: Implement the unified import operation

**Files:**
- Create: `crates/skillhub-core/src/application/import_service.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Create: `tests/integration/import_flow.rs`

**Interfaces:**
- Produces commands: `PrepareImport`, `CommitImport`, `CancelImport`.
- Produces results: `PreparedImport`, `ImportItemResult`, `ImportSummary`.
- Consumes: catalog/version services, source acquisition, detector and conflict analysis.

- [ ] **Step 1: Write local-copy and takeover flow tests**

```rust
#[tokio::test]
async fn local_copy_keeps_original_and_creates_one_managed_version() {
    let app = import_fixture().await;
    let source = app.arbitrary_local_skill("notes");
    let prepared = app.prepare_import(source.clone()).await.unwrap();
    let result = app.commit_import(prepared.id, ImportDecision::CopyIntoLibrary).await.unwrap();
    assert!(source.exists());
    assert_eq!(app.version_count(result.skill_id).await, 1);
}

#[tokio::test]
async fn takeover_does_not_delete_original_until_managed_content_is_verified() {
    let app = import_fixture_with_fault("before_import_verify").await;
    let source = app.known_agent_skill("notes");
    assert!(app.take_over(source.clone()).await.is_err());
    assert!(source.exists());
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --test import_flow`

Expected: FAIL with missing import service.

- [ ] **Step 3: Implement prepare/commit separation**

Preparation performs acquisition, detection, format/basic preflight and conflict analysis without changing the central library. Commit revalidates the prepared snapshot, creates the Skill/version/source facts, verifies the managed copy, and only then completes takeover or establishes the original relation.

- [ ] **Step 4: Run focused and interruption tests**

Run: `cargo test --test import_flow && cargo test --test import_conflicts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/application/import_service.rs crates/skillhub-core/src/api tests/integration/import_flow.rs
git commit -m "feat: add unified safe Skill import operation"
```

---

### Task 7: Implement source relink, upstream check and selected update

**Files:**
- Create: `crates/skillhub-core/src/source/update.rs`
- Create: `crates/skillhub-core/src/application/source_service.rs`
- Create: `crates/skillhub-storage/src/database/source_repository.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/source_update.rs`

**Interfaces:**
- Produces: `SourceState`, `UpstreamCheckResult`, `RelinkSource`, `CheckSourceUpdate`, `ApplySourceUpdate`.

- [ ] **Step 1: Write relink and local-modification tests**

```rust
#[tokio::test]
async fn update_never_overwrites_local_modification_without_choice() {
    let app = source_update_fixture().await;
    let skill = app.skill_with_local_change_and_new_upstream().await;
    let check = app.check_update(skill).await.unwrap();
    assert_eq!(check.state, SourceState::UpdateAvailableWithLocalChanges);
    assert!(app.apply_update(skill, None).await.is_err());
}

#[tokio::test]
async fn relink_records_new_source_without_rewriting_existing_history() {
    let app = source_update_fixture().await;
    let before = app.versions().await;
    app.relink_source(new_source_descriptor()).await.unwrap();
    assert_eq!(app.versions().await, before);
}

#[tokio::test]
async fn project_pin_overrides_skill_and_global_auto_upgrade_policy() {
    let app = source_update_fixture().await;
    app.set_global_auto_upgrade(true).await;
    app.set_skill_auto_upgrade(skill_id(), true).await;
    app.pin_project_version(project_id(), skill_id(), version_id()).await;
    let decision = app.evaluate_auto_upgrade(project_id(), skill_id()).await.unwrap();
    assert_eq!(decision, AutoUpgradeDecision::BlockedByProjectPin);
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --test source_update`

Expected: FAIL with missing source service.

- [ ] **Step 3: Implement explicit update decisions**

Support keep local, take upstream, create independent branch, or cancel. An applied update creates a new immutable version and marks affected deployment relations for Plan 05 reconciliation. Auto-check and auto-upgrade are separate settings; precedence is project pin/lock, then per-Skill override, then global default, with batch commands updating explicit per-Skill overrides. Auto-upgrade creates a recovery point and is blocked by source identity change, high-risk pending findings, merge conflict, missing version/source, authentication failure, deprecated/archived lifecycle or project pin. Network work runs only while the app is open.

- [ ] **Step 4: Run tests**

Run: `cargo test --test source_update && cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/source/update.rs crates/skillhub-core/src/application/source_service.rs crates/skillhub-core/src/api crates/skillhub-storage/src/database/source_repository.rs tests/integration/source_update.rs
git commit -m "feat: relink and update Skill sources safely"
```

---

### Task 8: Implement direct skills.sh online discovery

**Files:**
- Create: `crates/skillhub-core/src/source/discovery.rs`
- Create: `crates/skillhub-adapters/src/source/skills_sh.rs`
- Create: `crates/skillhub-storage/src/database/source_search_cache.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `crates/skillhub-adapters/tests/skills_sh.rs`

**Interfaces:**
- Produces: `SourceSearchQuery`, `SourceSearchHit`, `SourceSearchPage`, `SearchOnlineSources`.
- Consumes: network master policy and optional LLM-generated query text from Plan 06.

- [ ] **Step 1: Write API mapping, cache and rate-limit tests**

```rust
#[tokio::test]
async fn maps_skills_sh_search_results_to_importable_source_hits() {
    let server = skills_sh_fixture_server(search_response_fixture());
    let page = SkillsShProvider::new(server.base_url()).search(query("pdf")).await.unwrap();
    assert_eq!(page.items[0].source_id, "anthropics/skills/pdf");
    assert_eq!(page.items[0].source.kind, SourceKind::Git);
    assert!(page.items[0].page_url.as_str().starts_with("https://skills.sh/"));
}

#[tokio::test]
async fn respects_retry_after_and_never_falls_back_to_scraping() {
    let server = skills_sh_fixture_server(rate_limited_response(30));
    let error = SkillsShProvider::new(server.base_url()).search(query("pdf")).await.unwrap_err();
    assert_eq!(error.code.as_str(), "source.search_rate_limited");
    assert_eq!(error.params["retry_after_seconds"], 30);
    assert_eq!(server.request_count(), 1);
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p skillhub-adapters --test skills_sh`

Expected: FAIL with missing provider.

- [ ] **Step 3: Implement the documented public API adapter**

Call `GET https://skills.sh/api/v1/skills/search` over HTTPS and construct the documented `q` and `limit` query parameters with the URL library. Map stable `id`, `name`, `source`, `installUrl`, `url`, install count and duplicate flag, and respect `Cache-Control`, `429 Retry-After`, timeouts and the global network switch. A `401` is reported as provider authentication unavailable; the app does not require or install Vercel CLI. Do not scrape HTML and do not treat third-party skills.sh audit data as SkillHub's own basic or LLM check result.

- [ ] **Step 4: Run provider and source-parser tests**

Run: `cargo test -p skillhub-adapters --test skills_sh && cargo test -p skillhub-adapters --test source_parser`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/source/discovery.rs crates/skillhub-core/src/api/query.rs crates/skillhub-adapters/src/source/skills_sh.rs crates/skillhub-storage/src/database/source_search_cache.rs crates/skillhub-adapters/tests/skills_sh.rs
git commit -m "feat: search the skills.sh catalog directly"
```

---

## Plan Verification

Run fresh with process-spawn auditing enabled in tests:

```text
cargo test -p skillhub-adapters source
cargo test --test import_conflicts
cargo test --test import_flow
cargo test --test source_update
cargo test -p skillhub-adapters --test skills_sh
```

Confirm no test or production source invokes `Command`, shell, `git`, `npm`, or `npx`; inspect import fixtures to confirm path-escape and oversized inputs are rejected before central-library writes.
