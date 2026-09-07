# Plan09 Task12 Deployment Write Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing deployment planner and filesystem operation services to the local application facade so a user can preview, confirm, and recover a deployment from the desktop workflow.

**Architecture:** Keep planning, filesystem mutation, and persistence behind the existing `ApplicationFacade` command/query boundary. The facade resolves only registered logical targets, validates them with `PathPolicy`, prepares an immutable plan, and commits through a filesystem backend that records each successful deployment. Failed targets remain retryable and never delete the central-library source.

**Tech Stack:** Rust workspace (`skillhub-core`, `skillhub-storage`, `skillhub-application`, `skillhub-adapters`), SQLite, Tauri/Specta bindings, React/Vitest.

**Spec:** `docs/需求文档.md` sections 5.22–5.24 and `docs/产品与交互设计.md` sections 10.1–10.4.

## Global Constraints

- 部署前展示目标、版本、冲突、覆盖范围和将发生的变化。
- “添加到指定 Agent”支持单选、多选和选择全部已注册且支持文件部署的 Agent。
- 默认优先使用软链接；目标、Agent 或系统不支持时使用受管复制兜底。
- 部署不等于 Skill 已被 Agent 加载、调用、正确执行或已证明安全。
- 解除部署不删除集中库 Skill；删除链接时不能沿链接删除集中库内容。
- 所有文件系统写入必须限制在已注册并通过 `PathPolicy` 验证的目标内。
- 不提交本机路径、用户 Skill 内容、凭据或依赖缓存。

---

### Task 12.1: Resolve and preview registered deployment targets

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Modify: `crates/skillhub-application/tests/facade.rs`
- Test: `crates/skillhub-core/tests/deployment_planner.rs`

**Interfaces:**
- Consumes: `GetDeploymentPlan`, `DeploymentPlanRequest`, `RegisteredTargetIndex`, `DeploymentPlanner`.
- Produces: `AppQueryResult::DeploymentPlan` containing the selected logical targets, physical grouping, selected mode, conflicts, and warnings.

- [x] **Step 1: Write failing facade tests**

Add tests that create a temporary registered target directory and assert that `GetDeploymentPlan` returns a plan for a valid logical target, groups two logical targets sharing one physical directory, and returns a structured error for an unregistered target.

- [x] **Step 2: Run the focused tests and verify failure**

Run:

```text
cargo test -p skillhub-application --test facade deployment_plan
```

Expected: the valid-plan tests fail because `LocalApplicationFacade` currently reports `query.unsupported` for `GetDeploymentPlan`.

- [x] **Step 3: Implement the minimal target resolver and planner dispatch**

Add a facade-owned registered-target resolver initialized by tests and by the production constructor. Resolve `request.logical_target_ids` through `RegisteredTargetIndex`, obtain the selected central-library version path, call `DeploymentPlanner::plan_request`, and return `AppQueryResult::DeploymentPlan`. Do not accept raw target paths from the frontend.

- [x] **Step 4: Run focused Rust tests and contract checks**

Run:

```text
cargo test -p skillhub-application --test facade deployment_plan
cargo test -p skillhub-core --test deployment_planner
cargo test -p skillhub-core --test api_contract
```

Expected: all tests pass and no API binding drift is reported.

- [x] **Step 5: Commit**

```text
git add crates/skillhub-application crates/skillhub-core/tests/deployment_planner.rs
git commit -m "feat: connect deployment plan query"
```

### Task 12.2: Execute prepared deployments with recovery-safe filesystem writes

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Modify: `crates/skillhub-storage/src/database/deployment_repository.rs`
- Test: `crates/skillhub-application/tests/facade.rs`
- Test: `crates/skillhub-core/tests/deploy_flow.rs`

**Interfaces:**
- Consumes: `PrepareDeployment`, `CommitDeployment`, `DeploymentService`, `DeploymentBackend`, `DeploymentRepository`.
- Produces: `AppCommandResult::PreparedDeployment` and `AppCommandResult::DeploymentSummary` with per-target status and structured error codes.

- [x] **Step 1: Write failing command tests**

Cover a successful managed-copy deployment, a no-op re-run, a target permission failure that leaves the source intact and returns `committed: false`, and reuse of the prepared operation after a partial failure.

- [x] **Step 2: Run the focused tests and verify failure**

Run:

```text
cargo test -p skillhub-application --test facade deployment_command
cargo test -p skillhub-core --test deploy_flow
```

Expected: command tests fail because `LocalApplicationFacade::execute` currently routes deployment commands to `execute.unsupported`.

- [x] **Step 3: Implement the filesystem deployment backend**

Use the existing planner-selected mode: create a symbolic link when supported, use the Windows directory junction fallback when selected, and otherwise copy into a managed destination. Before mutation, reject an occupied unknown target; after success, persist `DeploymentRecord` with expected and observed hashes. On a per-target failure, return a failed result without deleting the central-library source and keep the prepared operation for retry.

- [x] **Step 4: Run focused tests and verify recovery behavior**

Run:

```text
cargo test -p skillhub-application --test facade deployment_command
cargo test -p skillhub-core --test deploy_flow
cargo test -p skillhub-storage --test deployment_repository
```

Expected: all success, no-op, permission, partial-failure, and retry tests pass.

- [x] **Step 5: Regenerate and verify TypeScript bindings**

Run the repository binding-generation test and ensure `apps/desktop/src/api/bindings.ts` changes only through the generated output.

- [x] **Step 6: Commit**

```text
git add crates/skillhub-application crates/skillhub-storage apps/desktop/src/api/bindings.ts
git commit -m "feat: execute prepared deployments safely"
```

### Task 12.3: Connect the deployment dialog to the native facade

**Files:**
- Create: `apps/desktop/src/features/deployment/nativeApi.ts`
- Create: `apps/desktop/src/features/deployment/nativeApi.test.ts`
- Modify: `apps/desktop/src/features/deployment/DeploymentDialog.tsx`
- Modify: `apps/desktop/src/features/deployment/api.ts`
- Test: `apps/desktop/src/features/deployment/DeploymentDialog.test.tsx`

**Interfaces:**
- Consumes: generated `list_deployment_targets`, `get_deployment_plan`, `prepare_deployment`, and `commit_deployment` bindings.
- Produces: the existing `DeploymentFacade` shape with native target selection, preview warnings, per-target results, and recoverable errors.

- [x] **Step 1: Write failing adapter and dialog tests**

Assert that native plans map logical and physical target information without exposing untrusted absolute paths in user messages, that commit results preserve failed target rows, and that the dialog disables confirmation until a preview exists.

- [x] **Step 2: Run focused Vitest tests and verify failure**

Run:

```text
pnpm --dir apps/desktop exec vitest run src/features/deployment/nativeApi.test.ts src/features/deployment/DeploymentDialog.test.tsx
```

Expected: the adapter test fails because no native deployment facade exists.

- [x] **Step 3: Implement the adapter and production wiring**

Map generated result codes to existing localized error states, preserve the dialog’s preview-then-confirm sequence, and refresh deployment results after a successful commit. Keep fixture facades available for isolated UI tests.

- [x] **Step 4: Run frontend checks**

Run:

```text
pnpm --dir apps/desktop exec vitest run src/features/deployment/nativeApi.test.ts src/features/deployment/DeploymentDialog.test.tsx
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop lint
pnpm --dir apps/desktop build
```

Expected: all focused tests, typecheck, lint, and production build pass.

- [x] **Step 5: Commit**

Implementation note: the native adapter carries the generated plan privately through the existing facade shape. It resolves the current version/runtime name when the route uses the `current` placeholder, and maps failed target rows without exposing absolute target paths in error messages. The application facade builds a production `RegisteredTargetIndex` from persisted discovery facts; unavailable or non-directory targets are excluded from planning.

```text
git add apps/desktop/src/features/deployment
git commit -m "feat: connect deployment dialog to native facade"
```

### Task 12.4: Cross-platform validation and documentation

**Files:**
- Create: `docs/development/task-reports/plan-09-task-12-deployment-write-integration.md`
- Modify: `docs/development/当前开发状态.md`
- Test: `tests/integration/deployment_flow.rs` when the existing fixture can exercise the command boundary.

- [x] **Step 1: Run Windows focused tests and the complete local CI**
- [x] **Step 2: Push the verified commit and send macOS validation instructions**
- [x] **Step 3: Record filesystem mode, permission, rollback, and shared-physical-target results for both platforms**
- [x] **Step 4: Run `git diff --check`, update the task report, and commit the documentation**

Expected: Windows and macOS local CI pass; any unavailable filesystem capability is recorded as a platform limitation rather than silently treated as a successful deployment.
