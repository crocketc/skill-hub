# SkillHub Foundation and Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a compiling Rust/React/Tauri workspace with stable identifiers, structured errors, generated IPC types, secure path boundaries, reusable test fixtures, and baseline CI.

**Architecture:** Domain contracts live in `skillhub-core`; desktop and CLI depend on them but the core has no platform imports. Rust is the source of truth for command/query/event types, and `skillhub-testkit` supplies isolated local workspaces for every later plan.

**Tech Stack:** Rust, Cargo Workspace, serde, uuid, thiserror, async-trait, specta, Tauri 2, React, TypeScript, Vite, Vitest, pnpm, GitHub Actions.

**Spec:** `docs/技术架构设计.md` sections 3–5, 8, 15, 17, 18, and 22.

## Global Constraints

- Use the exact cross-plan names defined in `2026-08-22-skillhub-00-master-implementation.md`.
- `skillhub-core` must not import Tauri, SQLite, reqwest, notify, keychain APIs, or platform path constants.
- TypeScript IPC types must be generated from Rust; do not maintain handwritten duplicates.
- All filesystem tests use isolated temporary directories; never write to the developer's real `~/SkillHub` or Agent directories.
- Lock all resolved dependencies in `Cargo.lock` and `pnpm-lock.yaml`.

---

### Task 1: Bootstrap the workspace and stable domain identifiers

**Files:**
- Create: `Cargo.toml`
- Create: `rust-toolchain.toml`
- Create: `.gitignore`
- Create: `crates/skillhub-core/Cargo.toml`
- Create: `crates/skillhub-core/src/lib.rs`
- Create: `crates/skillhub-core/src/ids.rs`
- Test: `crates/skillhub-core/tests/ids.rs`

**Interfaces:**
- Produces: `SkillId`, `VersionId`, `AgentProfileId`, `ClientInstanceId`, `ProjectId`, `LogicalTargetId`, `PhysicalTargetId`, `DeploymentId`, `OperationId`.

- [ ] **Step 1: Write the identifier contract test**

```rust
use skillhub_core::{OperationId, SkillId, VersionId};

#[test]
fn identifiers_round_trip_through_json_without_losing_type() {
    let skill = SkillId::new();
    let operation = OperationId::new();
    let version = VersionId::parse("sha256:abc123").unwrap();

    assert_eq!(serde_json::from_str::<SkillId>(&serde_json::to_string(&skill).unwrap()).unwrap(), skill);
    assert_eq!(serde_json::from_str::<OperationId>(&serde_json::to_string(&operation).unwrap()).unwrap(), operation);
    assert_eq!(version.as_str(), "sha256:abc123");
    assert!(VersionId::parse("abc123").is_err());
}
```

- [ ] **Step 2: Run the test and observe the missing-workspace failure**

Run: `cargo test -p skillhub-core --test ids`

Expected: FAIL because the workspace/package does not exist.

- [ ] **Step 3: Create the workspace and minimal identifier implementation**

Use a Cargo workspace with resolver `2`. Implement UUID newtypes with `new()`, `Display`, `FromStr`, serde and `specta::Type`; implement `VersionId::parse` so only lowercase `sha256:<hex>` values are accepted.

```rust
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(transparent)]
pub struct SkillId(uuid::Uuid);

impl SkillId {
    pub fn new() -> Self { Self(uuid::Uuid::new_v4()) }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(transparent)]
pub struct VersionId(String);
```

- [ ] **Step 4: Run the focused and crate tests**

Run: `cargo test -p skillhub-core --test ids && cargo test -p skillhub-core`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- Cargo.toml rust-toolchain.toml .gitignore crates/skillhub-core
git commit -m "build: bootstrap Rust workspace and domain identifiers"
```

---

### Task 2: Define structured errors and recovery actions

**Files:**
- Create: `crates/skillhub-core/src/error.rs`
- Modify: `crates/skillhub-core/src/lib.rs`
- Test: `crates/skillhub-core/tests/errors.rs`

**Interfaces:**
- Produces: `AppError`, `ErrorCode`, `Severity`, `RecoveryAction`, `AppResult<T>`.
- Consumes: identifier types from Task 1.

- [ ] **Step 1: Write tests for stable error serialization**

```rust
use skillhub_core::{AppError, ErrorCode, RecoveryAction, Severity};

#[test]
fn error_serialization_contains_codes_not_localized_sentences() {
    let error = AppError::new(ErrorCode::TargetExists, Severity::Warning)
        .with_param("runtime_name", "pdf")
        .with_action(RecoveryAction::ChooseAnotherName);
    let json = serde_json::to_value(error).unwrap();
    assert_eq!(json["code"], "deployment.target_exists");
    assert_eq!(json["params"]["runtime_name"], "pdf");
    assert_eq!(json["actions"][0], "choose_another_name");
    assert!(json.to_string().find("目标已存在").is_none());
}
```

- [ ] **Step 2: Run the focused test**

Run: `cargo test -p skillhub-core --test errors`

Expected: FAIL with unresolved imports.

- [ ] **Step 3: Implement codes, severity, parameters and actions**

Define error codes as a closed enum with explicit serde renames. Include at least invalid input, path outside allowed roots, object not found, target exists, ownership unknown, check blocked, operation conflict, credential unavailable, migration required and internal error. `AppError` must never store a pre-localized user-facing sentence.

- [ ] **Step 4: Run tests**

Run: `cargo test -p skillhub-core --test errors && cargo test -p skillhub-core`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/error.rs crates/skillhub-core/src/lib.rs crates/skillhub-core/tests/errors.rs
git commit -m "feat: add structured application errors"
```

---

### Task 3: Freeze command, query, event and operation contracts

**Files:**
- Create: `crates/skillhub-core/src/api/mod.rs`
- Create: `crates/skillhub-core/src/api/command.rs`
- Create: `crates/skillhub-core/src/api/query.rs`
- Create: `crates/skillhub-core/src/api/event.rs`
- Create: `crates/skillhub-core/src/operation.rs`
- Modify: `crates/skillhub-core/src/lib.rs`
- Test: `crates/skillhub-core/tests/api_contract.rs`

**Interfaces:**
- Produces: `ApplicationFacade`, `AppCommand`, `AppCommandResult`, `AppQuery`, `AppQueryResult`, `AppEvent`, `Page<T>`, `OperationPhase`, `OperationProgress`, `OperationSummary`.

- [ ] **Step 1: Write a compile-time and serialization contract test**

```rust
use skillhub_core::{AppCommand, AppEvent, OperationId, OperationPhase, OperationProgress};

#[test]
fn progress_event_has_stable_wire_shape() {
    let event = AppEvent::OperationProgress(OperationProgress {
        operation_id: OperationId::new(),
        phase: OperationPhase::Prepared,
        completed: 2,
        total: 5,
        message_code: "operation.prepared".into(),
    });
    let json = serde_json::to_value(event).unwrap();
    assert_eq!(json["type"], "operation_progress");
    assert_eq!(json["payload"]["phase"], "prepared");
}

fn command_is_send(value: AppCommand) {
    fn assert_send<T: Send>(_: T) {}
    assert_send(value);
}
```

- [ ] **Step 2: Run the test and confirm missing contracts**

Run: `cargo test -p skillhub-core --test api_contract`

Expected: FAIL with unresolved API types.

- [ ] **Step 3: Implement the API envelope and facade trait**

Add only envelope variants needed to prove binding generation: `GetBootstrapSnapshot`, `CancelOperation`, and `AcknowledgeRecovery`. Later plans extend the same enums instead of creating side channels.

```rust
#[async_trait::async_trait]
pub trait ApplicationFacade: Send + Sync {
    async fn execute(&self, command: AppCommand) -> AppResult<AppCommandResult>;
    async fn query(&self, query: AppQuery) -> AppResult<AppQueryResult>;
}
```

- [ ] **Step 4: Run the contract suite**

Run: `cargo test -p skillhub-core --test api_contract && cargo test -p skillhub-core`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/src/api crates/skillhub-core/src/operation.rs crates/skillhub-core/src/lib.rs crates/skillhub-core/tests/api_contract.rs
git commit -m "feat: define typed application API contracts"
```

---

### Task 4: Implement the allowed-root path boundary

**Files:**
- Create: `crates/skillhub-core/src/path_policy.rs`
- Modify: `crates/skillhub-core/Cargo.toml`
- Modify: `crates/skillhub-core/src/lib.rs`
- Test: `crates/skillhub-core/tests/path_policy.rs`

**Interfaces:**
- Produces: `AllowedRootId`, `AllowedRoot`, `SafePath`, `PathPolicy::resolve_existing`, `PathPolicy::resolve_for_create`.

- [ ] **Step 1: Write traversal and symlink-escape tests**

```rust
#[test]
fn rejects_parent_traversal_outside_registered_root() {
    let root = tempfile::tempdir().unwrap();
    let (root_id, policy) = policy_for(root.path());
    let error = policy.resolve_for_create(root_id, "../outside/skill").unwrap_err();
    assert_eq!(error.code.as_str(), "path.outside_allowed_root");
}

#[test]
fn accepts_a_child_path_and_returns_its_root_identity() {
    let root = tempfile::tempdir().unwrap();
    let (root_id, policy) = policy_for(root.path());
    let safe = policy.resolve_for_create(root_id.clone(), "skills/pdf").unwrap();
    assert_eq!(safe.root_id(), root_id);
}
```

- [ ] **Step 2: Run the test**

Run: `cargo test -p skillhub-core --test path_policy`

Expected: FAIL because the path policy and testkit do not exist.

- [ ] **Step 3: Implement lexical validation first**

Reject absolute child paths, `..`, alternate data stream syntax on Windows, empty terminal names, NUL, and platform-invalid components. Require filesystem adapters to canonicalize existing ancestors before mutation; never compare raw path strings for containment.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p skillhub-core --test path_policy`

Expected: PASS on Windows and macOS CI.

- [ ] **Step 5: Commit**

```bash
git add -- crates/skillhub-core/Cargo.toml crates/skillhub-core/src/path_policy.rs crates/skillhub-core/src/lib.rs crates/skillhub-core/tests/path_policy.rs Cargo.lock
git commit -m "feat: enforce secure allowed-root paths"
```

---

### Task 5: Build isolated filesystem testkit and finish path tests

**Files:**
- Create: `crates/skillhub-testkit/Cargo.toml`
- Create: `crates/skillhub-testkit/src/lib.rs`
- Create: `crates/skillhub-testkit/src/workspace.rs`
- Create: `crates/skillhub-testkit/src/faults.rs`
- Modify: `Cargo.toml`
- Modify: `crates/skillhub-core/Cargo.toml`
- Test: `crates/skillhub-testkit/tests/workspace.rs`
- Test: `crates/skillhub-core/tests/path_policy.rs`

**Interfaces:**
- Produces: `TempWorkspace`, named central/agent/project path fixtures, fixture-copy helpers and deterministic fault points; testkit returns paths and does not depend on `skillhub-core`.

- [ ] **Step 1: Write the testkit isolation test**

```rust
#[test]
fn temp_workspace_never_uses_real_user_directories() {
    let workspace = skillhub_testkit::TempWorkspace::new().unwrap();
    assert!(workspace.central_root().starts_with(workspace.root()));
    assert!(workspace.agent_root("codex").starts_with(workspace.root()));
    assert!(workspace.project_root("demo").starts_with(workspace.root()));
}
```

- [ ] **Step 2: Run both failing tests**

Run: `cargo test -p skillhub-testkit --test workspace && cargo test -p skillhub-core --test path_policy`

Expected: FAIL because `TempWorkspace` is not implemented.

- [ ] **Step 3: Implement temporary roots and fault injection**

Use `tempfile::TempDir`. `TempWorkspace` exposes isolated paths and fixture copy helpers; the consuming test constructs its own core `PathPolicy`, avoiding a dependency cycle. `FaultInjector` accepts named one-shot failures such as `after_prepare`, `after_first_target`, and `before_verify` for later operation recovery tests.

- [ ] **Step 4: Run workspace and path tests on the current OS**

Run: `cargo test -p skillhub-testkit && cargo test -p skillhub-core --test path_policy`

Expected: PASS.

- [ ] **Step 5: Commit Tasks 4 and 5**

```bash
git add -- Cargo.toml Cargo.lock crates/skillhub-testkit
git commit -m "test: add isolated filesystem workspaces"
```

---

### Task 6: Bootstrap desktop, generated bindings and frontend tests

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/src/main.tsx`
- Create: `apps/desktop/src/app/App.tsx`
- Create: `apps/desktop/src/api/bindings.ts`
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/src/main.rs`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Test: `apps/desktop/src/app/App.test.tsx`

**Interfaces:**
- Consumes: Rust command/query/event contracts.
- Produces: generated `bindings.ts`, Tauri invoke/event bridge and a renderable desktop shell.

- [ ] **Step 1: Write a frontend smoke test**

```tsx
import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("renders the local bootstrap state without network access", async () => {
  render(<App bootstrap={{ phase: "loading_local", locale: "zh-CN" }} />);
  expect(screen.getByText("正在读取本地数据")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and observe the missing frontend failure**

Run: `pnpm --dir apps/desktop test --run`

Expected: FAIL because the frontend workspace does not exist.

- [ ] **Step 3: Create the Tauri/Vite app and binding generator**

The Tauri command bridge accepts only `AppCommand` and `AppQuery`; it forwards them to an injected `ApplicationFacade`. Generate bindings during `cargo test -p skillhub-desktop generate_bindings` and commit the output so frontend compilation does not require running the desktop binary.

- [ ] **Step 4: Verify Rust and frontend compilation**

Run: `cargo test --workspace && pnpm --dir apps/desktop test --run && pnpm --dir apps/desktop build`

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add -- package.json pnpm-workspace.yaml pnpm-lock.yaml apps/desktop Cargo.toml Cargo.lock
git commit -m "build: bootstrap Tauri desktop and generated IPC bindings"
```

---

### Task 7: Add baseline formatting, linting and CI

**Files:**
- Create: `deny.toml`
- Create: `.github/workflows/validate.yml`
- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Test: `.github/workflows/validate.yml`

**Interfaces:**
- Produces: one validation workflow used by every later plan.

- [ ] **Step 1: Add a deliberately strict local validation script**

Define root scripts `check:frontend` and `test:frontend`; configure ESLint to reject unused variables and TypeScript errors. Confirm `pnpm check:frontend` fails before the script/config exists.

- [ ] **Step 2: Create the CI workflow**

Run on pushes and pull requests for both `windows-latest` and `macos-latest`. Execute:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
pnpm install --frozen-lockfile --ignore-scripts
pnpm check:frontend
pnpm test:frontend
pnpm --dir apps/desktop build
```

- [ ] **Step 3: Add dependency and license checks**

Add `cargo deny check advisories bans licenses sources` and a frontend audit command that emits machine-readable output. Do not auto-upgrade dependencies in CI.

- [ ] **Step 4: Run the complete validation locally**

Run: `cargo fmt --all -- --check && cargo clippy --workspace --all-targets --all-features -- -D warnings && cargo test --workspace && pnpm check:frontend && pnpm test:frontend && pnpm --dir apps/desktop build`

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add -- deny.toml .github/workflows/validate.yml package.json apps/desktop/package.json pnpm-lock.yaml
git commit -m "ci: validate Rust and desktop foundations"
```

---

## Plan Verification

Run fresh:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
pnpm install --frozen-lockfile --ignore-scripts
pnpm check:frontend
pnpm test:frontend
pnpm --dir apps/desktop build
```

Confirm the generated TypeScript file has no uncommitted diff, no test writes outside temporary roots, and the app can render its local-loading shell with network disabled.
