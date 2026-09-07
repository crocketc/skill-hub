# SkillHub Catalog, Storage, and Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the central library, portable metadata, SQLite migrations, Skill catalog, immutable content-addressed versions, FTS5/BM25 search, lifecycle/trial/combination rules, and cached bootstrap snapshot.

**Architecture:** Portable Skill facts and immutable content live under the visible central library; SQLite projects those facts into fast local queries and stores device-only state. Repository ports live in `skillhub-core`, while concrete filesystem and SQLite code lives in `skillhub-storage`.

**Tech Stack:** Rust, rusqlite with bundled SQLite/FTS5, serde, serde_json, SHA-256, tempfile, proptest.

**Spec:** `docs/需求文档.md` 4.1–4.3, 5.10, 5.12–5.21, 5.25–5.26, 5.33–5.35; `docs/技术架构设计.md` 6–8, 11.3, 16, 19.

## Global Constraints

- Use `~/SkillHub/skills` and `~/SkillHub/.skillhub` only through an injected `LibraryPaths`; tests use `TempWorkspace`.
- Same-name Skills coexist through `name--shortid`; directory names are not identities.
- Version manifests and blobs are immutable; rollback never edits history.
- SQLite is rebuildable local state and not the only recovery source.
- Persist stable codes and facts, never localized UI status strings.
- Basic and LLM check rows exist separately even before Plan 06 implements scanners.

---

### Task 1: Create the storage crate and migration runner

**Files:**
- Create: `crates/skillhub-storage/Cargo.toml`
- Create: `crates/skillhub-storage/src/lib.rs`
- Create: `crates/skillhub-storage/src/database/mod.rs`
- Create: `crates/skillhub-storage/src/database/migrations.rs`
- Create: `crates/skillhub-storage/migrations/0001_initial.sql`
- Create: `crates/skillhub-storage/migrations/0002_fts.sql`
- Modify: `Cargo.toml`
- Test: `crates/skillhub-storage/tests/migrations.rs`

**Interfaces:**
- Produces: `Database::open`, `Database::schema_version`, `MigrationReport`.
- Consumes: structured `AppError`.

- [ ] **Step 1: Write migration tests**

```rust
#[test]
fn empty_database_migrates_to_current_schema_and_enables_fts5() {
    let db = skillhub_storage::Database::open_in_memory().unwrap();
    assert_eq!(db.schema_version().unwrap(), 2);
    assert!(db.has_table("skills_fts").unwrap());
}

#[test]
fn database_newer_than_application_is_opened_read_only() {
    let db = fixture_database_with_schema_version(999);
    let error = skillhub_storage::Database::open(&db).unwrap_err();
    assert_eq!(error.code.as_str(), "database.newer_schema");
    assert!(error.actions.iter().any(|a| a.as_str() == "open_read_only"));
}
```

- [ ] **Step 2: Verify tests fail**

Run: `cargo test -p skillhub-storage --test migrations`

Expected: FAIL because the crate and migration runner do not exist.

- [ ] **Step 3: Implement transactional migrations**

Create tables for skills, versions, current pointers, sources, tags, combinations, projects, targets, deployments, check runs/findings, operations, pending dismissals, settings and FTS5. Store the schema version in `PRAGMA user_version`; apply each SQL file in one transaction and roll back on error.

- [ ] **Step 4: Run migration tests**

Run: `cargo test -p skillhub-storage --test migrations && cargo test -p skillhub-storage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- Cargo.toml Cargo.lock crates/skillhub-storage
git commit -m "feat: add SQLite schema and transactional migrations"
```

---

### Task 2: Establish central-library layout and atomic portable metadata

**Files:**
- Create: `crates/skillhub-core/src/catalog/library.rs`
- Create: `crates/skillhub-storage/src/library/mod.rs`
- Create: `crates/skillhub-storage/src/library/layout.rs`
- Create: `crates/skillhub-storage/src/library/portable.rs`
- Modify: `crates/skillhub-core/src/lib.rs`
- Test: `crates/skillhub-storage/tests/library_layout.rs`

**Interfaces:**
- Produces: `LibraryPaths`, `LibraryManifest`, `PortableSkillRecord`, `CentralLibrary::initialize`, `CentralLibrary::load_manifest`, `CentralLibrary::write_manifest_atomic`.

- [ ] **Step 1: Write layout and atomic-write tests**

```rust
#[test]
fn initialization_creates_visible_skills_and_internal_management_dirs() {
    let ws = skillhub_testkit::TempWorkspace::new().unwrap();
    let library = CentralLibrary::initialize(ws.central_root()).unwrap();
    assert!(library.paths().skills_dir.ends_with("skills"));
    assert!(library.paths().management_dir.ends_with(".skillhub"));
    assert_eq!(library.load_manifest().unwrap().format_version, 1);
}

#[test]
fn interrupted_manifest_write_keeps_previous_valid_manifest() {
    let mut fixture = library_fixture();
    fixture.faults().fail_once("before_manifest_replace");
    assert!(fixture.library().write_manifest_atomic(&changed_manifest()).is_err());
    assert_eq!(fixture.library().load_manifest().unwrap(), fixture.original_manifest());
}
```

- [ ] **Step 2: Run focused tests**

Run: `cargo test -p skillhub-storage --test library_layout`

Expected: FAIL with unresolved library types.

- [ ] **Step 3: Implement layout and atomic replacement**

Use `skills/`, `.skillhub/library.json`, `.skillhub/skills/`, `.skillhub/versions/`, `.skillhub/objects/`, `.skillhub/backups/`, and `.skillhub/tmp/`. Write a temporary file in the same directory, flush it, verify it parses, then replace the destination. Never write a partially serialized manifest in place.

- [ ] **Step 4: Run tests**

Run: `cargo test -p skillhub-storage --test library_layout && cargo test -p skillhub-storage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/catalog crates/skillhub-core/src/lib.rs crates/skillhub-storage/src/library crates/skillhub-storage/tests/library_layout.rs
git commit -m "feat: initialize portable central library layout"
```

---

### Task 3: Implement Skill metadata, lifecycle, tags, notes, requirements and combinations

**Files:**
- Create: `crates/skillhub-core/src/catalog/mod.rs`
- Create: `crates/skillhub-core/src/catalog/skill.rs`
- Create: `crates/skillhub-core/src/catalog/metadata.rs`
- Create: `crates/skillhub-core/src/catalog/combination.rs`
- Create: `crates/skillhub-core/src/catalog/repository.rs`
- Create: `crates/skillhub-storage/src/database/catalog_repository.rs`
- Modify: `crates/skillhub-storage/src/database/mod.rs`
- Test: `crates/skillhub-core/tests/catalog_rules.rs`
- Test: `crates/skillhub-storage/tests/catalog_repository.rs`

**Interfaces:**
- Produces: `Skill`, `SkillLifecycle`, `SkillMetadata`, `DeclaredRequirement`, `TrialState`, `SkillCombination`, `CatalogRepository`.

- [ ] **Step 1: Write domain-rule tests**

```rust
#[test]
fn trial_is_a_label_with_due_date_not_a_lifecycle_state() {
    let skill = Skill::new(SkillId::new(), "pdf").with_trial_due(date(2026, 9, 1));
    assert_eq!(skill.lifecycle(), SkillLifecycle::Normal);
    assert!(skill.tags().contains("temporary_trial"));
    assert_eq!(skill.trial_state(date(2026, 9, 2)), TrialState::Due);
}

#[test]
fn combinations_cannot_contain_other_combinations() {
    let result = SkillCombination::create("writing", vec![CombinationMember::Combination(combination_id())]);
    assert_eq!(result.unwrap_err().code.as_str(), "combination.nesting_not_allowed");
}
```

- [ ] **Step 2: Run domain tests**

Run: `cargo test -p skillhub-core --test catalog_rules`

Expected: FAIL with missing catalog domain.

- [ ] **Step 3: Implement domain types and repository port**

`SkillLifecycle` contains only `Normal`, `Deprecated`, and `Archived`. Metadata includes display name, runtime name, original description, translated description state, user note, tags, author, license, call policy and deterministically parsed declared requirements for Python, ffmpeg, MCP, plugins, environment variables and other tools.

- [ ] **Step 4: Write repository round-trip test and implementation**

```rust
#[tokio::test]
async fn catalog_round_trip_preserves_original_and_user_metadata() {
    let repo = repository_fixture();
    let skill = fixture_skill().with_note("用于提取 PDF 表格").with_tag("document");
    repo.insert(&skill).await.unwrap();
    assert_eq!(repo.get(skill.id()).await.unwrap().unwrap(), skill);
}
```

Run before implementation: `cargo test -p skillhub-storage --test catalog_repository`

Expected: FAIL. Implement parameterized SQL and transactions, then rerun both catalog suites and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/catalog crates/skillhub-core/tests/catalog_rules.rs crates/skillhub-storage/src/database crates/skillhub-storage/tests/catalog_repository.rs
git commit -m "feat: add Skill catalog metadata and lifecycle rules"
```

---

### Task 4: Implement immutable version manifests and content-addressed objects

**Files:**
- Create: `crates/skillhub-core/src/versioning/mod.rs`
- Create: `crates/skillhub-core/src/versioning/model.rs`
- Create: `crates/skillhub-core/src/versioning/repository.rs`
- Create: `crates/skillhub-storage/src/version_store/mod.rs`
- Create: `crates/skillhub-storage/src/version_store/manifest.rs`
- Create: `crates/skillhub-storage/src/version_store/object_store.rs`
- Modify: `crates/skillhub-storage/src/lib.rs`
- Test: `crates/skillhub-storage/tests/version_store.rs`

**Interfaces:**
- Produces: `FileEntry`, `VersionManifest`, `VersionStore::capture`, `VersionStore::materialize`, `VersionStore::diff`, `VersionStore::set_current`.

- [ ] **Step 1: Write deduplication and immutability tests**

```rust
#[test]
fn equal_file_content_is_stored_once_across_versions() {
    let fixture = version_store_fixture();
    let v1 = fixture.capture_skill("skill-a", [("SKILL.md", "same")]).unwrap();
    let v2 = fixture.capture_skill("skill-a", [("SKILL.md", "same"), ("note.md", "new")]).unwrap();
    assert_ne!(v1.id, v2.id);
    assert_eq!(fixture.object_count_for_bytes(b"same"), 1);
}

#[test]
fn materialized_version_matches_manifest_hashes() {
    let fixture = version_store_fixture();
    let version = fixture.capture_default_skill().unwrap();
    let output = fixture.materialize(version.id).unwrap();
    assert_eq!(hash_tree(&output), version.manifest.tree_hash);
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p skillhub-storage --test version_store`

Expected: FAIL with missing version store.

- [ ] **Step 3: Implement canonical manifests and object writes**

Normalize relative paths to `/`, sort entries, reject traversal/symlink escape, hash bytes with SHA-256, and write new objects through temporary same-directory files. Version ID is the SHA-256 of canonical manifest JSON prefixed with `sha256:`.

- [ ] **Step 4: Implement current pointer and rollback semantics**

`set_current` validates that the version belongs to the Skill. A rollback creates an operation/event and changes only the current pointer; it never deletes newer history. Run the full version-store suite and property tests for manifest ordering.

Run: `cargo test -p skillhub-storage --test version_store && cargo test -p skillhub-core versioning`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/versioning crates/skillhub-storage/src/version_store crates/skillhub-storage/src/lib.rs crates/skillhub-storage/tests/version_store.rs
git commit -m "feat: add immutable content-addressed Skill versions"
```

---

### Task 5: Implement create, save, rename, current version and project pin use cases

**Files:**
- Create: `crates/skillhub-core/src/application/catalog_service.rs`
- Create: `crates/skillhub-core/src/application/version_service.rs`
- Create: `crates/skillhub-core/src/application/mod.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/catalog_version_flow.rs`

**Interfaces:**
- Produces commands: `CreateSkill`, `SaveSkillContent`, `RenameSkill`, `SetLifecycle`, `SetMetadata`, `SetTrial`, `CreateCombination`, `SetCurrentVersion`, `PinProjectSkillVersion`.
- Produces queries: `GetSkill`, `ListVersions`, `DiffVersions`, `ListCombinations`.

- [ ] **Step 1: Write the end-to-end catalog/version test**

```rust
#[tokio::test]
async fn saving_content_creates_a_version_and_rename_does_not_change_identity() {
    let app = headless_app_fixture().await;
    let skill = app.create_skill("pdf", minimal_skill_md()).await.unwrap();
    let first = app.current_version(skill.id).await.unwrap();
    app.save_skill(skill.id, "# PDF\nUpdated").await.unwrap();
    let second = app.current_version(skill.id).await.unwrap();
    app.rename_skill(skill.id, "pdf-tools").await.unwrap();
    assert_ne!(first, second);
    assert_eq!(app.get_skill(skill.id).await.unwrap().id, skill.id);
    assert_eq!(app.list_versions(skill.id).await.unwrap().len(), 2);
}
```

- [ ] **Step 2: Run test and observe missing use cases**

Run: `cargo test --test catalog_version_flow`

Expected: FAIL with missing application fixture/commands.

- [ ] **Step 3: Implement services through repository ports**

Create and save must validate `SKILL.md`, capture the complete directory, update portable metadata and SQLite in one coordinated operation, and return `OperationSummary`. Rename changes display/runtime names and reports affected deployments; Plan 05 performs actual target reconciliation.

- [ ] **Step 4: Run focused and workspace tests**

Run: `cargo test --test catalog_version_flow && cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/application crates/skillhub-core/src/api tests/integration/catalog_version_flow.rs
git commit -m "feat: add catalog and version application flows"
```

---

### Task 6: Add FTS5 indexing, BM25 search and deterministic duplicate candidates

**Files:**
- Create: `crates/skillhub-core/src/search/mod.rs`
- Create: `crates/skillhub-core/src/search/model.rs`
- Create: `crates/skillhub-storage/src/database/search_repository.rs`
- Modify: `crates/skillhub-storage/src/database/mod.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `crates/skillhub-storage/tests/search.rs`

**Interfaces:**
- Produces: `SearchQuery`, `SearchHit`, `SearchRepository::reindex_skill`, `SearchRepository::search`, `SearchRepository::duplicate_candidates`.

- [ ] **Step 1: Write Chinese/English search tests**

```rust
#[test]
fn bm25_searches_name_note_translation_tags_and_markdown() {
    let repo = indexed_catalog_fixture();
    assert_eq!(repo.search("PDF 表格").unwrap()[0].skill_name, "pdf-extractor");
    assert_eq!(repo.search("meeting transcript").unwrap()[0].skill_name, "audio-notes");
}

#[test]
fn updating_one_skill_does_not_rebuild_unrelated_rows() {
    let mut repo = indexed_catalog_fixture();
    let before = repo.index_revision("audio-notes");
    repo.reindex_skill(pdf_skill_changed()).unwrap();
    assert_eq!(repo.index_revision("audio-notes"), before);
}
```

- [ ] **Step 2: Run focused tests**

Run: `cargo test -p skillhub-storage --test search`

Expected: FAIL with missing search repository.

- [ ] **Step 3: Implement normalized FTS documents and BM25 ranking**

Index display/runtime names, original/translated descriptions, notes, tags, author, license, declared requirements and Markdown. Keep the tokenizer configuration in one migration and normalize Unicode width/case before insert. Return highlighted field codes, not pre-rendered HTML.

- [ ] **Step 4: Run search and migration tests**

Run: `cargo test -p skillhub-storage --test search && cargo test -p skillhub-storage --test migrations`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/search crates/skillhub-core/src/api/query.rs crates/skillhub-storage/src/database crates/skillhub-storage/tests/search.rs
git commit -m "feat: add FTS5 and BM25 Skill search"
```

---

### Task 7: Derive pending items and cached bootstrap snapshot

**Files:**
- Create: `crates/skillhub-core/src/pending/mod.rs`
- Create: `crates/skillhub-core/src/pending/derive.rs`
- Create: `crates/skillhub-core/src/bootstrap.rs`
- Create: `crates/skillhub-storage/src/database/bootstrap_repository.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Test: `tests/integration/bootstrap_pending.rs`

**Interfaces:**
- Produces: `PendingItem`, `PendingKind`, `BootstrapSnapshot`, `GetBootstrapSnapshot`, `ListPendingItems`.

- [ ] **Step 1: Write derived-state tests**

```rust
#[tokio::test]
async fn due_trial_and_unresolved_finding_appear_without_stored_status_text() {
    let app = headless_app_fixture().await;
    let trial = app.insert_due_trial().await;
    let unsafe_skill = app.insert_unresolved_basic_finding().await;
    let pending = app.list_pending().await.unwrap();
    assert!(pending.iter().any(|p| p.subject == trial && p.kind == PendingKind::TrialDue));
    assert!(pending.iter().any(|p| p.subject == unsafe_skill && p.kind == PendingKind::SecurityFinding));
}
```

- [ ] **Step 2: Run the integration test**

Run: `cargo test --test bootstrap_pending`

Expected: FAIL with missing pending/bootstrap queries.

- [ ] **Step 3: Implement query projections**

`BootstrapSnapshot` contains cached counts, deployment chart categories, recent operation summary, pending summary, last scan time and startup recovery state. It must be readable before filesystem scanning starts and contain no localized display sentences.

- [ ] **Step 4: Run tests and measure fixture query time**

Run: `cargo test --test bootstrap_pending && cargo test --workspace`

Expected: PASS; the 300-Skill in-memory fixture query completes within the benchmark threshold recorded by the test harness.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/pending crates/skillhub-core/src/bootstrap.rs crates/skillhub-core/src/api/query.rs crates/skillhub-storage/src/database/bootstrap_repository.rs tests/integration/bootstrap_pending.rs
git commit -m "feat: derive pending items and cached bootstrap state"
```

---

### Task 8: Parse declared requirements and compatibility statements deterministically

**Files:**
- Create: `crates/skillhub-adapters/src/requirements/mod.rs`
- Create: `crates/skillhub-adapters/src/requirements/parser.rs`
- Create: `crates/skillhub-adapters/src/requirements/rules.rs`
- Create: `fixtures/skills/requirements/python-ffmpeg-env/SKILL.md`
- Create: `fixtures/skills/requirements/no-declarations/SKILL.md`
- Create: `fixtures/skills/requirements/source-compatibility/SKILL.md`
- Test: `crates/skillhub-adapters/tests/declared_requirements.rs`

**Interfaces:**
- Produces: `RequirementEvidence`, `CompatibilityStatement`, `DeclaredRequirementParser::parse`.
- Consumes: `DeclaredRequirement` and catalog metadata types.

- [ ] **Step 1: Write explicit-declaration and reference-clue tests**

```rust
#[test]
fn separates_explicit_requirements_from_reference_clues() {
    let parsed = parse_fixture("python-ffmpeg-env");
    assert!(parsed.explicit.iter().any(|r| r.kind == RequirementKind::Python));
    assert!(parsed.clues.iter().any(|r| r.kind == RequirementKind::Ffmpeg && r.location.line == 18));
    assert!(parsed.environment_variables.iter().any(|v| v.name == "OPENAI_API_KEY" && v.value.is_none()));
}

#[test]
fn absence_is_reported_as_no_explicit_declaration_not_no_dependencies() {
    let parsed = parse_fixture("no-declarations");
    assert_eq!(parsed.summary_code, "requirements.no_explicit_declaration_found");
    assert_ne!(parsed.summary_code, "requirements.none");
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p skillhub-adapters --test declared_requirements`

Expected: FAIL with missing parser.

- [ ] **Step 3: Implement fixed parsers without environment probing**

Read explicit frontmatter/Markdown lists, known dependency filenames and literal references to Python, ffmpeg, MCP, plugins, environment-variable names and other tools. Record file/line evidence and source-declared Agent/OS compatibility separately from user notes. Never inspect installed programs, save environment-variable values, call LLM or create compatible/incompatible status.

- [ ] **Step 4: Run tests**

Run: `cargo test -p skillhub-adapters --test declared_requirements && cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-adapters/src/requirements fixtures/skills/requirements crates/skillhub-adapters/tests/declared_requirements.rs
git commit -m "feat: parse declared Skill runtime requirements"
```

---

## Plan Verification

Run fresh:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test -p skillhub-core
cargo test -p skillhub-storage
cargo test --test catalog_version_flow
cargo test --test bootstrap_pending
cargo test -p skillhub-adapters --test declared_requirements
```

Inspect a temporary central library and confirm it contains readable Skill directories, version manifests and deduplicated objects but no device-specific absolute paths, UI translations or credentials.
