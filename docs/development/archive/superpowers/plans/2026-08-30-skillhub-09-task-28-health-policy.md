# Health, Recovery, Call Policy and Ignore Rules Integration Plan

> **For agentic workers:** This plan is executed in the isolated `codex/plan09-task28` worktree and follows the repository TDD gate.

**Goal:** Connect the existing health, recovery, call-policy and ignore-rule core services to the real `LocalApplicationFacade` command and query boundary.

**Architecture:** The facade owns one service instance per workflow and supplies local backends backed by the existing SQLite database plus narrowly scoped session state where no storage contract exists yet. All command validation and capability checks remain in core services; the facade only maps command/query variants and translates local facts into service inputs.

**Tech Stack:** Rust, Tokio, `skillhub-core` application services, SQLite through `skillhub-storage::Database`, Specta-generated API bindings.

**Spec:** `docs/需求文档.md`, `docs/技术架构设计.md`, `docs/superpowers/plans/2026-08-22-skillhub-05-deployment-operations.md`, `docs/superpowers/plans/2026-08-22-skillhub-09-task-28-health-policy.md`.

## Global Constraints

- Keep health checks deterministic and never call an LLM or invent runtime availability.
- Preserve ownership and structured error semantics; unknown or unavailable facts remain errors or read-only results.
- Mutating commands must use prepare/commit or explicit service validation already defined by the frozen API.
- Do not modify storage migrations, dependencies, generated bindings by hand, or unrelated Agent/project/search behavior.

### Task 1: Add facade red tests

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`

- [ ] Add one async test proving the health, recovery, call-policy and ignore command/query variants no longer return `execute.unsupported` or `query.unsupported`.
- [ ] Run `cargo test -p skillhub-application facade_runs_health -- --nocapture`; confirm the test fails at the first unimplemented facade variant.

### Task 2: Wire local services and command/query dispatch

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`

- [ ] Add local health/recovery/call-policy/ignore backends and service fields initialized by every facade constructor.
- [ ] Back health findings by deterministic operation/deployment/library facts, recovery candidates by unfinished journal rows, call policy by catalog metadata with original-policy restoration preconditions, and ignore rules by exact-subject session state.
- [ ] Map all requested `AppCommand` and `AppQuery` variants to the corresponding service calls and result enums.
- [ ] Add focused failure, cancellation/repeated-commit, unsupported-capability and explicit-invalid-input tests.
- [ ] Run focused application tests and then `cargo fmt --check`, Clippy, bindings generation, and `git diff --check`.

### Task 3: Commit and report

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Create: `docs/superpowers/plans/2026-08-30-skillhub-09-task-28-health-policy.md`

- [ ] Review diff for scope and path safety.
- [ ] Commit with `feat: connect health recovery and policy facade flows`.
- [ ] Report files, tests, commit hash, and any limitation to the parent agent.
