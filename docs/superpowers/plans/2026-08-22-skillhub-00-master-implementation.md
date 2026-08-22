# SkillHub Complete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete confirmed SkillHub Windows/macOS local Agent Skill lifecycle manager without splitting confirmed functions into separate product releases.

**Architecture:** A Tauri 2 desktop application and lightweight CLI share a Rust domain/application core. Skill content and portable metadata live in `~/SkillHub`, while SQLite, device state, queues, and logs live in OS application data; all writes pass through a typed operation service and Agent differences stay behind versioned profiles.

**Tech Stack:** Rust, Cargo Workspace, Tauri 2, React, TypeScript, Vite, SQLite/FTS5/BM25, Tokio, notify, reqwest, gix, TanStack Query/Table, Tailwind CSS, Radix Primitives, Motion, ECharts, CodeMirror 6, remark/rehype, i18next, Vitest, Testing Library, Playwright, GitHub Actions.

**Spec:** `docs/技术架构设计.md` implements `docs/需求文档.md`, `docs/产品与交互设计.md`, and `docs/Agent平台兼容性调研.md`.

## Global Constraints

- Support Windows and macOS; Windows is the primary experience and validation baseline; Linux is out of scope.
- Do not require Git, Node.js, npm, npx, administrator privileges, an external Markdown application, an account, or an LLM at runtime.
- Treat 300 Skills as the design and automated performance-test baseline; do not enforce a hard count limit.
- Target an interactive cached home screen within 2 seconds for about 100 Skills on the recorded reference machine when no database migration is required.
- Keep core local management functional with all network features disabled.
- Do not execute imported code, shell commands, PowerShell, npx commands, package scripts, Markdown code, Mermaid code, or LLM output.
- Keep basic security and LLM security as separate functions and separate results.
- Do not introduce vector models, embeddings, vector indexes, a remote database, telemetry, crash upload, a resident service, or a tray process.
- Use one visible local central library by default at `~/SkillHub/skills`; reserve `~/SkillHub/.skillhub` for portable management data.
- Network storage mode, Runtime Hook implementation, third-party adapter plugins, and Linux support remain outside the current implementation.
- Apply TDD to every behavior task: failing test, observed failure, minimal implementation, passing focused test, passing affected suite, then a focused commit.
- Stage only paths named by the current task; never use `git add .`, `git add -A`, or `git add --all`.

---

## 1. Plan Set and Execution Order

Execute the following plans in order. A later plan may start only when every interface it consumes from earlier plans exists and its producing tests pass.

| Order | Plan | Independently testable deliverable |
|---|---|---|
| 01 | [Foundation and runtime](./2026-08-22-skillhub-01-foundation-runtime.md) | Compiling workspace, typed commands/events/errors, testkit, secure path boundary, CI baseline |
| 02 | [Catalog, storage and versioning](./2026-08-22-skillhub-02-catalog-versioning.md) | Central library, SQLite schema/migrations, metadata/lifecycle, immutable versions, FTS index |
| 03 | [Adapters, discovery and projects](./2026-08-22-skillhub-03-adapters-discovery-projects.md) | Versioned Agent profiles, target discovery/merge, project registry/shared config, incremental scan/watch |
| 04 | [Sources and import](./2026-08-22-skillhub-04-sources-import.md) | Safe local/URL/Git/npx-reference acquisition and unified import/conflict/source flow |
| 05 | [Deployment and recoverable operations](./2026-08-22-skillhub-05-deployment-operations.md) | Link/copy deployment, batch transactions, external-change handling, undeploy/delete/recovery |
| 06 | [Security, search enhancement and LLM](./2026-08-22-skillhub-06-security-search-ai.md) | Basic scanner, independent LLM checks, semantic duplication, translation, experimental evidence analysis |
| 07 | [Desktop experience](./2026-08-22-skillhub-07-desktop-experience.md) | Initialization, cached home, library/detail/editor, Agent/project/deployment, pending/settings UI and i18n |
| 08 | [Backup, CLI and release](./2026-08-22-skillhub-08-backup-cli-release.md) | Backup/restore/migration, CLI, packaging, supply-chain controls, full compatibility and release gates |

This is a dependency-oriented development order, not a reduced product version plan. Every confirmed feature remains in the complete implementation target.

---

## 2. Repository Structure to Create

```text
skill-hub/
├── Cargo.toml                         # Rust workspace members and shared dependency policy
├── Cargo.lock                         # locked Rust dependency graph
├── rust-toolchain.toml                # formatter and clippy components
├── deny.toml                          # Rust license/advisory/source policy
├── pnpm-workspace.yaml                # desktop frontend workspace
├── package.json                       # root frontend scripts and package manager pin
├── pnpm-lock.yaml                     # locked frontend dependency graph
├── crates/
│   ├── skillhub-core/                 # domain values, use-case contracts, errors and events
│   ├── skillhub-storage/              # SQLite, central library, objects, manifests and backups
│   ├── skillhub-adapters/             # Agent, project, source, scanner, LLM and OS adapters
│   ├── skillhub-cli/                  # lightweight CLI using the application facade
│   └── skillhub-testkit/              # fixtures, temporary workspaces and fault injection
├── apps/desktop/
│   ├── src-tauri/                     # Tauri command/event bridge and desktop capabilities
│   └── src/                           # React feature modules and design system
├── fixtures/
│   ├── agents/                        # profile discovery/deployment directory fixtures
│   ├── skills/                        # valid, duplicate, unsafe and malformed Skill fixtures
│   ├── databases/                     # old schema migration fixtures
│   └── imports/                       # archive, npx text, URL and source fixtures
├── tests/
│   ├── integration/                   # Rust cross-crate workflows
│   ├── performance/                   # 100/300 Skill benchmarks
│   └── e2e/                           # desktop user journeys
└── .github/workflows/                 # validation and signed/unsigned release workflows
```

### File responsibility rules

- A file under `domain/` contains no Tauri, SQLite, HTTP, filesystem, or UI imports.
- A file under `application/` coordinates ports and domain rules but contains no platform-specific path constants.
- Adapter profile data owns Agent path differences; React pages never branch on Agent brand.
- Every mutating use case has one request type, one result type, one operation record, and one focused integration test.
- Frontend feature folders own their query keys, views, and components; shared UI contains no product-specific data fetching.

---

## 3. Cross-Plan Interface Contract

Plan 01 must define these names exactly so later plans do not invent incompatible variants.

```rust
pub struct SkillId(pub uuid::Uuid);
pub struct VersionId(pub String);
pub struct AgentProfileId(pub String);
pub struct ClientInstanceId(pub uuid::Uuid);
pub struct ProjectId(pub uuid::Uuid);
pub struct LogicalTargetId(pub uuid::Uuid);
pub struct PhysicalTargetId(pub uuid::Uuid);
pub struct DeploymentId(pub uuid::Uuid);
pub struct OperationId(pub uuid::Uuid);

pub struct AppError {
    pub code: ErrorCode,
    pub severity: Severity,
    pub params: std::collections::BTreeMap<String, serde_json::Value>,
    pub actions: Vec<RecoveryAction>,
}

pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u32,
    pub next_cursor: Option<String>,
}

pub enum AppEvent {
    OperationProgress(OperationProgress),
    OperationFinished(OperationSummary),
    FactsChanged(FactsChanged),
}

#[async_trait::async_trait]
pub trait ApplicationFacade: Send + Sync {
    async fn execute(&self, command: AppCommand) -> Result<AppCommandResult, AppError>;
    async fn query(&self, query: AppQuery) -> Result<AppQueryResult, AppError>;
}
```

All command and query payloads derive `Serialize`, `Deserialize`, and `specta::Type`. TypeScript bindings are generated from Rust; handwritten duplicate IPC interfaces are prohibited.

### Operation contract

```rust
pub enum OperationPhase {
    Planned,
    Prepared,
    Applying,
    Verifying,
    Committed,
    NeedsRecovery,
    RolledBack,
}

pub struct OperationProgress {
    pub operation_id: OperationId,
    pub phase: OperationPhase,
    pub completed: u32,
    pub total: u32,
    pub message_code: String,
}
```

Repeated submission of the same `OperationId` must return the persisted result or current progress; it must not apply the write twice.

---

## 4. Requirement Coverage Matrix

| Requirement section | Implementing plan/task group |
|---|---|
| 5.1 Initialization | 03 discovery baseline; 07 initialization and skip UI |
| 5.2–5.3 Agent management/environment change | 03 profiles, instances, targets and rescans; 07 Agent pages |
| 5.4–5.5 Projects/best-effort assembly | 03 project registry/shared config; 04 acquisition reuse; 05 deployment; 07 project workspace |
| 5.6 Local discovery | 03 scan/watch and recognized roots |
| 5.7 Local/online search | 02 FTS5/BM25; 04 source discovery adapter; 06 optional LLM query helper; 07 search UX |
| 5.8 Sources | 04 source parsers/fetchers/relink/update |
| 5.9 Import/copy/takeover | 04 unified import pipeline |
| 5.10 Create/preview/edit | 02 create/version save; 07 Markdown viewer/editor |
| 5.11 Source relink | 04 source state machine |
| 5.12–5.14 Metadata/lifecycle/license | 02 catalog entities and commands; 07 library/detail UI |
| 5.15 Duplicate/conflict | 04 deterministic conflicts; 06 LLM semantic comparison; 07 resolution UI |
| 5.16–5.21 Version/update/rename | 02 version store/current pointers; 04 upstream acquisition; 05 affected deployment reconcile; 07 history UI |
| 5.22–5.24 Deployment/relations/call policy | 05 deployment engine; 07 deployment and relation UI |
| 5.25 Runtime requirements | 02 declared-requirement parser; 07 deterministic display |
| 5.26 Trial | 02 trial label and due query; 07 pending conversion/delete UI |
| 5.27–5.28 Security checks | 06 separate basic/LLM pipelines; 07 results UI |
| 5.29–5.30 Usage evidence | 06 evidence provider and experimental analysis; 07 experimental labeling |
| 5.31–5.32 External changes/collect | 03 detection; 05 reconcile and collect |
| 5.33 Pending center | 02 derived pending query; 05 operation anomalies; 07 pending center |
| 5.34 Health check | 02/03 deterministic facts; 05 repairs; 07 health UI |
| 5.35–5.38 History/undeploy/delete/ignore | 05 operation engine and ownership-safe actions; 07 confirmations |
| 5.39–5.41 Backup/restore/export | 08 portable package and migration workflows |
| 5.42 LLM configuration | 06 provider profiles and secure credentials; 07 settings UI |
| 5.43 CLI | 08 CLI command/query surface |
| 5.44 Uninstall preparation | 08 deployment audit/export/cleanup flow; 07 settings entry |
| Section 6 UI/interaction | 07 desktop experience, with 05/06 operation details |
| Section 7 confirmed product direction | 07 information architecture and views |
| 8.1 Security scope | 04/05/06 safe acquisition, writes and checks |
| 8.2 Reliability | 02 migrations/versioning; 05 operation journal/recovery; 08 backups |
| 8.3 Performance | 02 indexes; 03 incremental scan; 07 startup; 08 performance gates |
| 8.4 Runtime boundary | 03 in-process scheduler/watch; 07 settings; 08 verification |
| 8.5 Distribution | 08 Windows/macOS packaging and manual update path |

No requirement section is intentionally deferred except items explicitly listed as out of scope in the specs.

---

## 5. Integration Gates

### Gate A — Foundation

- `cargo test --workspace` passes.
- Rust-generated TypeScript bindings compile in the desktop app.
- Path boundary tests reject traversal and unknown roots.
- CI runs formatting, linting, Rust tests and frontend tests.

### Gate B — Headless Core

- A temporary central library can import a fixture, create versions, find it with FTS5, discover a simulated Agent, deploy, detect an external modification, collect it, undeploy and restore from backup without launching the UI.
- Every write produces an operation record and survives injected interruption tests.

### Gate C — Desktop Closed Loop

- A new user can complete or skip initialization, view cached data, import a Skill, inspect both security results, deploy to multiple targets, edit `SKILL.md`, resolve a pending item, and undo or recover a supported operation.
- Keyboard-only navigation and reduced-motion checks pass for dialogs, drawers and tables.

### Gate D — Release Candidate

- Windows and macOS package builds complete from the same commit.
- The 100-Skill startup and 300-Skill full-operation benchmarks meet recorded thresholds.
- Migration fixtures, backup restore, offline mode, no-LLM mode and failure recovery all pass.
- Compatibility smoke results are recorded without claiming runtime support for untested Agents.

---

## 6. Commit and Review Policy

- Each task in a child plan ends in one focused commit after its focused and affected tests pass.
- A plan completion requires a fresh full verification run and a spec-coverage review.
- Do not combine dependency upgrades with unrelated feature behavior.
- Do not commit generated installers, local databases, credentials, logs, fixture secrets, or developer-specific absolute paths.
- Keep the current direct-`main` personal workflow only while the user explicitly retains it; implementation agents must otherwise use isolated worktrees and reviewed integration.

---

## 7. Completion Definition

The implementation is complete only when all eight child plans are complete, Gates A–D pass with fresh evidence, every requirement row above points to passing tests or a reviewed UI acceptance case, both supported OS packages are produced, and the documentation reflects observed behavior rather than intended behavior.
