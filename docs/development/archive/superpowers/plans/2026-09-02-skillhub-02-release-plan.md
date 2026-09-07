# SkillHub v0.2.0 首个可用版本实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已完成的核心服务和桌面页面接成普通用户可完成“首次初始化 → 发现/导入 → 管理 → 部署 → 检查/恢复”的完整本地工作流，并在 Windows/macOS 真实环境验收后发布 v0.2.0。

**Architecture:** 保持 Rust 核心、ApplicationFacade、Tauri 桥接和 React 页面现有分层。优先补齐已存在页面与真实 facade 的接线，不重写领域服务，不把预览数据伪装成生产数据；跨平台差异继续留在 Rust/适配器层，前端只消费生成的契约。

**Tech Stack:** Rust workspace、SQLite、Tauri 2、React、TypeScript、Vite、Vitest、Specta bindings、Node 24、Windows 11、macOS。

**Spec:** `docs/需求文档.md`、`docs/产品与交互设计.md`、`docs/技术架构设计.md`（均为本地需求基线）以及 `docs/development/发布版本需求差异审查-2026-09-02.md`。

## Global Constraints

- 首次启动必须展示集中库位置并允许确认或更改；不自动导入、移动或部署 Skill。
- 核心功能在未配置 LLM、未安装 Git 或普通用户权限下仍可使用；LLM 只作为独立可选增强。
- 不提交 API Key、私钥、用户 Skill 内容、个人路径、`node_modules`、`target` 或 worktree。
- Windows 和 macOS 的路径、权限、链接、大小写和换行差异必须通过适配器和测试覆盖。
- Rust→TypeScript 契约只由 Specta 生成；任何契约变更必须更新 bindings 和漂移测试。
- 每个 Task 采用 TDD、独立提交；完成前运行相关测试、`git diff --check` 和必要的前端质量门禁。
- v0.2.0 发布前，需求矩阵中所有 P0 项必须具备真实页面、真实本地数据、可操作流程和验收证据。
- 网络存储/云盘、运行时 Hook、使用证据分析仍是后续或实验范围，不纳入 v0.2.0 发布门槛。

---

## 发布范围与门槛

### v0.2.0 必须可用的用户路径

1. 新用户首次启动看到初始化向导，确认集中库后可完成或跳过。
2. 用户可扫描本机 Skill，预览候选，处理重复/同名冲突并导入集中库。
3. 用户可在 Skill 库查看详情、版本和 Markdown，并把 Skill 部署到已识别 Agent 或项目。
4. 用户可查看部署关系、处理外部变化、解除部署或删除，并看到影响和结果。
5. 用户可执行基础安全检查，查看待处理事项，并完成可确定的处置/重试。
6. 用户可创建备份、验证/恢复、导出，并在设置中管理集中库和更新策略。
7. 应用更新在签名资产存在时可检查、下载、校验、安装、自动重启；失败时保留回滚路径。

### 明确不作为 v0.2.0 门槛

- 所有第三方 Agent 的运行时调用成功；只验证已安装客户端的文件级接入和能获得的应用级事实。
- NAS/SMB/百度云盘/夸克云盘/iCloud 等网络存储实际连接。
- Agent runtime Hook 和调用次数完整统计。
- CLI 高风险写操作全面开放。
- 未签名版本绕过 SmartScreen 或 Gatekeeper。

---

### Task 1: 接通首次启动初始化闭环

**目标：** 让新安装用户必定进入可完成的初始化流程，同时保留跳过和设置页重新进入。

**Files:**
- Modify: `crates/skillhub-core/src/bootstrap.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-application/src/lib.rs`
- Modify: `apps/desktop/src/api/bindings.ts`（由 Specta 生成）
- Modify: `apps/desktop/src/features/bootstrap/api.ts`
- Modify: `apps/desktop/src/features/bootstrap/BootstrapGate.tsx`
- Modify: `apps/desktop/src/features/onboarding/OnboardingWizard.tsx`
- Modify: `apps/desktop/src/features/onboarding/OnboardingWizard.test.tsx`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Produces a bootstrap initialization state and the exact configured library path.
- Produces typed native operations for completing/skipping onboarding and discovering Agent targets.
- Keeps `RunInitializationScan` read-only and does not add implicit import/deploy behavior.

- [x] **Step 1: Write failing contract tests**
  - Add facade tests for a fresh database returning `not_initialized`, a completed database returning `initialized`, and completion persisting the chosen path/skip state.
  - Add frontend tests asserting `BootstrapGate` routes a fresh snapshot to `/initialize` and an initialized snapshot to `AppShell`.
- [x] **Step 2: Run the focused tests and confirm failure**
  - Run `cargo test -p skillhub-application --test facade bootstrap`.
  - Run `pnpm --dir apps/desktop exec vitest run src/features/bootstrap/BootstrapGate.test.tsx src/features/onboarding/OnboardingWizard.test.tsx`.
  - Expected: missing initialization state/operation failures.
- [x] **Step 3: Implement the smallest native contract and persistence**
  - Add an explicit persisted initialization marker; do not infer “initialized” solely from zero Skill count.
  - Expose the platform default library path and complete/skip command through the existing facade bridge.
  - Inject real operations into `OnboardingWizard`; keep unavailable behavior only in isolated preview tests.
- [x] **Step 4: Verify the complete initialization flow**
  - Repeat focused Rust/frontend tests.
  - Run `pnpm --dir apps/desktop check`, `pnpm --dir apps/desktop test --run`, and `pnpm --dir apps/desktop build`.
- [x] **Step 5: Commit**
  - Commit message: `feat: connect first-run initialization`

### Task 2: 接通 Agent、项目、设置和待处理生产页面

**目标：** 移除用户进入主导航后最明显的 unavailable 占位。

**Files:**
- Create/Modify: `apps/desktop/src/features/agents/nativeApi.ts`, `apps/desktop/src/features/agents/api.ts`
- Create/Modify: `apps/desktop/src/features/projects/nativeApi.ts`, `apps/desktop/src/features/projects/api.ts`
- Modify: `apps/desktop/src/features/settings/api.ts`, `apps/desktop/src/features/settings/SettingsPage.tsx`
- Create/Modify: `apps/desktop/src/features/pending/nativeApi.ts`, `apps/desktop/src/features/pending/api.ts`
- Modify: `apps/desktop/src/app/router.tsx`
- Test: corresponding `nativeApi.test.ts` and page tests
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes existing `ListCustomAgents`, `ListProjects`, `ListPendingItems` and settings-related typed commands/queries.
- Produces native facades with the same page-level interfaces currently used by preview components.

- [x] **Step 1: Write failing native facade and route tests**
  - Mock `queryApplication`/`executeCommand` and assert each facade maps typed envelopes to page models.
  - Assert production routes no longer pass `unavailableAgentFacade`, `unavailableProjectFacade`, `unavailablePendingFacade` or `unavailableSettingsFacade`.
- [x] **Step 2: Run focused tests and confirm failure**
  - Run `pnpm --dir apps/desktop exec vitest run src/features/agents src/features/projects src/features/pending src/features/settings src/app/router.test.tsx`.
- [x] **Step 3: Implement native facades and error mapping**
  - Preserve unavailable/error/empty distinctions; never substitute fixture data in production routes.
  - Keep settings writes explicit and reversible; do not change network storage scope.
- [x] **Step 4: Verify page-level behavior**
  - Run focused tests, `pnpm --dir apps/desktop check`, full Vitest and production build.
- [x] **Step 5: Commit**
  - Commit message: `feat: connect production management pages`

### Task 3: 完成发现、导入、部署和解除部署桌面联调

**目标：** 从真实页面完成“发现 → 冲突选择 → 导入 → 部署/解除部署”的闭环。

**Files:**
- Modify: `apps/desktop/src/features/discovery/DiscoveryPage.tsx`
- Modify: `apps/desktop/src/features/import/nativeApi.ts`, `apps/desktop/src/features/import/ImportWizard.tsx`
- Modify: `apps/desktop/src/features/deployment/nativeApi.ts`, `apps/desktop/src/features/deployment/DeploymentDialog.tsx`
- Modify: `apps/desktop/src/features/removal/nativeApi.ts`, `apps/desktop/src/features/removal/RemovalImpactDialog.tsx`
- Modify: `apps/desktop/src/features/skills/SkillLibraryPage.tsx`, `apps/desktop/src/features/skill-detail/SkillDetailPage.tsx`
- Test: existing import/deployment/removal native and page tests
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes frozen `DiscoverImportCandidates`, `AnalyzeImport`, `PrepareImport`, `CommitImport`, `PrepareDeployment`, `CommitDeployment`, `PrepareUndeploy`, `CommitUndeploy` and removal-impact contracts.
- Produces visible per-item results, retry paths and refresh of library/relations after successful writes.

- [x] **Step 1: Write failing end-to-end facade tests**
  - Cover one successful import, one required duplicate decision, partial batch deployment failure, shared-target undeploy, and delete cancellation.
- [x] **Step 2: Run focused tests and confirm failure**
  - Run the relevant feature test files and `cargo test -p skillhub-application --test facade import deployment undeploy` as separate filters.
- [x] **Step 3: Implement page-to-facade wiring**
  - Keep preparation snapshots immutable; refresh queries only after committed results.
  - Display copy/link fallback mode and preserve user originals according to the existing contracts.
- [ ] **Step 4: Verify production routes**
  - Run full frontend checks and targeted Rust facade tests; manually exercise one local Skill on Windows.
  - Automated frontend/Rust verification is complete at `7b54cdf`; the write-capable Windows desktop smoke test against an explicitly selected disposable Skill remains for release acceptance.
- [x] **Step 5: Commit**
  - Commit message: `feat: complete import deployment workflows`

### Task 4: 接通安全、待处理、操作和恢复反馈

**目标：** 让检查结果、发现项处置、操作进度和恢复入口形成可操作闭环。

**Files:**
- Create/Modify: `apps/desktop/src/features/security/nativeApi.ts`, `apps/desktop/src/features/security/SecurityResults.tsx`
- Modify: `apps/desktop/src/features/pending/nativeApi.ts`, `apps/desktop/src/features/pending/PendingPage.tsx`
- Create/Modify: `apps/desktop/src/features/operations/nativeApi.ts`, `apps/desktop/src/features/operations/OperationProgress.tsx`
- Modify: `apps/desktop/src/features/recovery/RecoveryPage.tsx`
- Modify: `apps/desktop/src/app/router.tsx`
- Test: security/pending/operations/recovery native and page tests
- Test: `crates/skillhub-application/tests/facade.rs`, `facade_ai.rs`

**Interfaces:**
- Consumes `RunBasicCheck`, `RecheckBasic`, `SetFindingDisposition`, `RunLlmSafetyCheck`, `GetBasicCheckResult`, `ListFindings`, `ListPendingItems`, `ListRecoveryCandidates` and operation queries.
- Produces independent basic/LLM results, explicit finding actions, retry and recovery feedback.

- [x] **Step 1: Write failing mapping and action tests**
  - Assert basic and LLM results render separately, pending actions invoke the matching command, and recovery never acknowledges an unknown operation.
- [x] **Step 2: Run focused tests and confirm failure**
  - Run `pnpm --dir apps/desktop exec vitest run src/features/security src/features/pending src/features/operations src/features/recovery`.
- [x] **Step 3: Implement native facades and route wiring**
  - Preserve the four-state result model; unavailable LLM remains a capability state, not a failed check.
  - Map structured errors to actionable localized messages.
- [x] **Step 4: Verify**
  - Run focused tests, full frontend checks, and Rust facade/AI tests.
- [x] **Step 5: Commit**
  - Commit message: `feat: connect safety and recovery workflows`

### Task 5: 接通备份、恢复、导出和设置中的真实操作

**目标：** 让用户可以在桌面端完成数据保护和集中库管理，而不是只看到页面骨架。

**Files:**
- Modify: `apps/desktop/src/features/settings/api.ts`, `apps/desktop/src/features/settings/LibrarySettings.tsx`, `apps/desktop/src/features/settings/BackupSettings.tsx`
- Create/Modify: `apps/desktop/src/features/backup/nativeApi.ts` and related backup/export UI files
- Modify: `apps/desktop/src/app/router.tsx`
- Test: backup/export/settings native and page tests
- Test: `crates/skillhub-application/tests/facade.rs`

**Interfaces:**
- Consumes existing backup, restore, standard export and uninstall-preflight contracts.
- Produces explicit path selection, sensitive-content decisions, progress/result feedback and refresh of local snapshot.

- [x] **Step 1: Write failing desktop operation tests**
  - Cover backup preflight with sensitive content, user cancellation, successful creation, restore conflict and export completion.
- [x] **Step 2: Run focused tests and confirm failure**
  - Run backup/settings test files and the matching Rust facade filters.
- [x] **Step 3: Implement native adapters and UI actions**
  - Never write secrets into logs or backups silently; preserve original Skill files and show exact destination/impact.
- [x] **Step 4: Verify**
  - Desktop backup/restore/export page tests, frontend checks/build, and Rust facade tests pass. A real packaged-app smoke run remains part of Task 6 acceptance evidence.
  - Run frontend checks, Rust facade tests, and one local backup/restore smoke test on Windows.
- [x] **Step 5: Commit**
  - Commit message: `feat: connect backup and export workflows`

### Task 6: 发布候选质量门禁与双平台真实验收

**目标：** 建立 v0.2.0 的需求完成度证据，避免再次把“测试通过”误判为“产品完成”。

**Files:**
- Create: `docs/development/v0.2.0-acceptance-matrix.md`（本地）
- Modify: `docs/release-checklist.md`
- Modify: `scripts/verify_release_readiness.mjs` only if a deterministic release gate is missing
- Test: `scripts/verify_release_readiness.test.mjs`

**Interfaces:**
- Consumes completed Task 1–5 behavior and release scripts.
- Produces a matrix with requirement ID, page/command, evidence, platform, and remaining limitation.

- [x] **Step 1: Write the acceptance matrix before running it**
  - Each P0 requirement must list a real user action, expected result, test command or manual evidence, and Windows/macOS status.
- [x] **Step 2: Run automated gates on Windows**
  - Current commit passes release readiness, release Node tests, Rust workspace tests, frontend checks/tests/build, and official npm audit (0 vulnerabilities). `ci-local.mjs` reaches the same result except the configured mirror has no audit endpoint; the equivalent official-registry audit passes.
  - Run `node ./scripts/ci-local.mjs`, `node scripts/verify_release_readiness.mjs --json`, and `node --test scripts/verify_release_readiness.test.mjs`.
- [ ] **Step 3: Run the same commit on macOS**
  - On macOS: `git fetch origin; git switch main; git pull --ff-only; ./scripts/ci-local.sh`.
  - Record registry limitations, missing targets, unsigned status and any uninstalled Agent without marking them passed.
- [ ] **Step 4: Run the manual smoke matrix**
  - Fresh profile initialization; local Skill discovery/import; real Agent/project deployment; undeploy/delete impact; basic security check; backup/restore; settings/update screen.
- [ ] **Step 5: Commit acceptance evidence**
  - Commit message: `docs: record v0.2.0 acceptance evidence`

### Task 7: 生成并发布 v0.2.0

**目标：** 只从通过验收矩阵的 tag 生成干净的首次安装包和应用内更新资产。

**Files:**
- Modify: `docs/release-checklist.md`
- Modify: `docs/release-process.md` only when the actual workflow behavior changes
- Modify: `README.md` version/download notes
- Test: release readiness and manifest generator tests

**Interfaces:**
- Consumes the accepted commit, production updater public key, CI signing secret and platform build runners.
- Produces one tag, Windows installers/updater archives, macOS DMG/updater archives, signatures and `latest.json`.

- [ ] **Step 1: Freeze the release commit and tag**
  - Confirm all P0 matrix rows are passed; create the tag only after the commit is immutable.
- [ ] **Step 2: Run the tag-bound release workflow**
  - Confirm Windows and macOS build the same tag, updater assets use `.nsis.zip`/`.app.tar.gz`, and public Release assets exclude SBOM/internal evidence.
- [ ] **Step 3: Verify update behavior**
  - Check manifest platform mapping, forged signature rejection, package cleanup, install launch and rollback marker behavior.
- [ ] **Step 4: Publish and update documentation**
  - Publish only after asset names, hashes, trust level, install instructions and known limitations are reviewed.
- [ ] **Step 5: Commit final release notes**
  - Commit message: `docs: publish v0.2.0 release notes`

## Release decision rule

If any P0 row is still `页面未接入`, `unavailable facade`, `预览数据`, `未验证`, or `真实安装未完成`, do not publish v0.2.0. Keep the work on `main`, record the blocking row, and create the next focused task instead of weakening the gate.
