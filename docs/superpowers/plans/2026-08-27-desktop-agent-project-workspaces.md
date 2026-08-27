# Desktop Agent and Project Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement truthful Agent and project workspaces with shared-target relations, multi-tag filtering and itemized best-effort assembly previews.

**Architecture:** Keep the feature UI behind typed, injectable view Facades. Production routes use unavailable Facades until native query/command contracts are connected; tests inject deterministic fixtures. Agent and project components consume view models rather than calling bindings or touching files, network or processes.

**Tech Stack:** React 18, TypeScript, React Router, i18next, existing SkillHub Button/DataState/StatusBadge/Drawer primitives, Vitest and Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-27-desktop-agent-project-workspaces-design.md`

## Global Constraints

- Do not modify Rust, Specta-generated bindings or native command/query/event contracts.
- Do not access files, network, processes or execute Skills from React.
- Production routes use unavailable Facades; fixtures are injected only by tests.
- “已发现”只表示观察到目录事实，不表示授权、可用或验证通过。
- Usage evidence is labeled “实验功能，仅供参考”; Runtime Hook is labeled “研发中”.
- Project tag filtering uses set intersection and never renders a folder tree.
- Best-effort assembly preserves satisfied, skipped, conflict and failed rows; no all-or-nothing claim.
- Reuse existing semantic tokens and primitives; all user-visible copy exists in `zh-CN` and `en-US`.
- Every behavior change follows TDD: failing test, observed failure, minimal implementation, focused verification, then commit.

---

### Task 1: Define Agent and project view Facades and fixtures

**Files:**
- Create: `apps/desktop/src/features/agents/api.ts`
- Create: `apps/desktop/src/features/projects/api.ts`
- Test: `apps/desktop/src/features/agents/api.test.ts`
- Test: `apps/desktop/src/features/projects/api.test.ts`

**Interfaces:**
- `AgentView = { id, brand, client, instance, discoveredPaths, relations }`.
- `AgentRelation = { logicalTargetId, logicalLabel, physicalTargetId, physicalPath }`.
- `ProjectView = { id, name, description, tags, sharedConfig, assembly }`.
- `ProjectAssemblyItem = { skillId, skillName, status: "satisfied" | "skipped" | "conflict" | "failed", message }`.
- `AgentFacade.list(): Promise<AgentView[]>` and `AgentFacade.get(id): Promise<AgentView>`.
- `ProjectFacade.list(): Promise<ProjectView[]>` and `ProjectFacade.get(id): Promise<ProjectView>`.
- Export `unavailableAgentFacade`, `unavailableProjectFacade`, `agentFixture()`, `projectFixture()` and `sharedTargetFixture()` for tests only.

- [ ] **Step 1: Write failing unavailable and fixture tests**

```ts
it("keeps production Agent queries unavailable", async () => {
  await expect(unavailableAgentFacade.list()).rejects.toThrow("unavailable");
});

it("represents two logical clients on one physical target", () => {
  const view = sharedTargetFixture();
  expect(view.relations.map((relation) => relation.logicalTargetId)).toHaveLength(2);
  expect(new Set(view.relations.map((relation) => relation.physicalTargetId))).toHaveSize(1);
});
```

- [ ] **Step 2: Run focused tests and observe missing API failure**

Run: `pnpm --dir apps/desktop test --run src/features/agents/api.test.ts src/features/projects/api.test.ts`

Expected: FAIL because the Facade modules do not exist.

- [ ] **Step 3: Implement typed Facades and deterministic fixtures**

Keep unavailable Facades as rejected Promises. Fixtures must contain facts only: observed paths, logical labels, project tags, shared-config requirements and assembly statuses. No fixture may include an authorization or runtime-success field.

- [ ] **Step 4: Run focused tests and commit**

Run: `pnpm --dir apps/desktop test --run src/features/agents/api.test.ts src/features/projects/api.test.ts && pnpm --dir apps/desktop check`

```powershell
git add -- apps/desktop/src/features/agents/api.ts apps/desktop/src/features/agents/api.test.ts apps/desktop/src/features/projects/api.ts apps/desktop/src/features/projects/api.test.ts
git commit -m "feat: define Agent and project workspace facades"
```

### Task 2: Build Agent list, detail and relations views

**Files:**
- Create: `apps/desktop/src/features/agents/AgentListPage.tsx`
- Create: `apps/desktop/src/features/agents/AgentDetailPage.tsx`
- Create: `apps/desktop/src/features/agents/RelationsView.tsx`
- Create: `apps/desktop/src/features/agents/UsageEvidencePanel.tsx`
- Test: `apps/desktop/src/features/agents/AgentDetailPage.test.tsx`
- Modify: `apps/desktop/src/styles/base.css`

**Interfaces:**
- `AgentListPage({ facade?: AgentFacade })` renders observed clients and paths.
- `AgentDetailPage({ agentId?: string; facade?: AgentFacade })` renders brand/client/instance facts, relations and capability labels.
- `RelationsView({ relations: AgentRelation[] })` uses `data-testid="logical-target"` and `data-testid="physical-target"`.
- `UsageEvidencePanel({ evidence?: string[] })` labels itself experimental and never claims runtime proof.

- [ ] **Step 1: Write no-runtime-claim and shared-target tests**

```tsx
it("shows discovered directory facts without trust or usability status", async () => {
  render(<AgentDetailPage facade={{ get: async () => agentFixture(), list: async () => [agentFixture()] }} />);
  expect(await screen.findByText("已发现客户端和 Skill 目录")).toBeVisible();
  expect(screen.queryByText(/已授权|可用|验证通过/)).not.toBeInTheDocument();
});

it("renders two logical clients connected to one physical directory", () => {
  render(<RelationsView relations={sharedTargetFixture().relations} />);
  expect(screen.getAllByTestId("logical-target")).toHaveLength(2);
  expect(screen.getAllByTestId("physical-target")).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests and observe missing view failure**

Run: `pnpm --dir apps/desktop test --run src/features/agents/AgentDetailPage.test.tsx`

Expected: FAIL because the Agent view components do not exist.

- [ ] **Step 3: Implement facts-first Agent views**

Use `DataState` for loading/error/unavailable. Render observed directory paths with `overflow-wrap: anywhere`. Include exact labels for “实验功能，仅供参考” and “研发中”; do not add controls that imply authorization or runtime execution.

- [ ] **Step 4: Run tests, check and commit**

Run: `pnpm --dir apps/desktop test --run src/features/agents && pnpm --dir apps/desktop check`

```powershell
git add -- apps/desktop/src/features/agents apps/desktop/src/styles/base.css
git commit -m "feat: add Agent workspace views"
```

### Task 3: Build project list, tag intersection and quick drawer

**Files:**
- Create: `apps/desktop/src/features/projects/ProjectListPage.tsx`
- Create: `apps/desktop/src/features/projects/ProjectQuickDrawer.tsx`
- Test: `apps/desktop/src/features/projects/ProjectListPage.test.tsx`
- Modify: `apps/desktop/src/styles/base.css`

**Interfaces:**
- `ProjectListPage({ facade?: ProjectFacade })` supports controlled text and tag filters.
- `ProjectQuickDrawer({ project?: ProjectView; open: boolean; onClose(): void })` uses existing `Drawer` and exposes summary facts only.
- `matchesProjectFilters(project, text, selectedTags): boolean` requires every selected tag and case-insensitive text match.

- [ ] **Step 1: Write failing multi-tag and no-tree tests**

```tsx
it("filters one project through multiple tags without creating a folder tree", async () => {
  const user = userEvent.setup();
  render(<ProjectListPage facade={{ list: async () => [projectFixture()], get: async () => projectFixture() }} />);
  await user.click(screen.getByRole("checkbox", { name: "客户项目" }));
  await user.click(screen.getByRole("checkbox", { name: "Rust" }));
  expect(screen.getByText("Demo Project")).toBeVisible();
  expect(screen.queryByRole("tree")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run focused test and observe missing page failure**

Run: `pnpm --dir apps/desktop test --run src/features/projects/ProjectListPage.test.tsx`

Expected: FAIL because project views do not exist.

- [ ] **Step 3: Implement filter and drawer**

Use a checkbox per tag and derive visible projects with `every((tag) => project.tags.includes(tag))`. Keep project cards/table rows flat. Drawer close returns focus to its trigger through the existing primitive.

- [ ] **Step 4: Run tests, check and commit**

Run: `pnpm --dir apps/desktop test --run src/features/projects/ProjectListPage.test.tsx && pnpm --dir apps/desktop check`

```powershell
git add -- apps/desktop/src/features/projects/ProjectListPage.tsx apps/desktop/src/features/projects/ProjectQuickDrawer.tsx apps/desktop/src/features/projects/ProjectListPage.test.tsx apps/desktop/src/styles/base.css
git commit -m "feat: add project list and tag filtering"
```

### Task 4: Build project detail, shared config and best-effort assembly

**Files:**
- Create: `apps/desktop/src/features/projects/ProjectDetailPage.tsx`
- Create: `apps/desktop/src/features/projects/SharedConfigPanel.tsx`
- Create: `apps/desktop/src/features/projects/BestEffortAssembly.tsx`
- Test: `apps/desktop/src/features/projects/ProjectDetailPage.test.tsx`
- Modify: `apps/desktop/src/styles/base.css`

**Interfaces:**
- `ProjectDetailPage({ projectId?: string; facade?: ProjectFacade })` renders project metadata, shared config and assembly.
- `SharedConfigPanel({ config: ProjectView["sharedConfig"] })` renders identity hint and Skill requirements without writing them.
- `BestEffortAssembly({ items: ProjectAssemblyItem[] })` renders one row per item and each status.

- [ ] **Step 1: Write failing itemized assembly test**

```tsx
it("keeps satisfied, skipped, conflict and failed assembly entries visible", () => {
  render(<BestEffortAssembly items={projectFixture().assembly} />);
  expect(screen.getByText("满足")).toBeVisible();
  expect(screen.getByText("已跳过")).toBeVisible();
  expect(screen.getByText("冲突")).toBeVisible();
  expect(screen.getByText("失败")).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
});
```

- [ ] **Step 2: Run focused tests and observe missing detail failure**

Run: `pnpm --dir apps/desktop test --run src/features/projects/ProjectDetailPage.test.tsx`

Expected: FAIL because detail and assembly components do not exist.

- [ ] **Step 3: Implement detail and assembly views**

Render explicit status text and semantic tones. Never render “全部成功” unless every item is satisfied; mixed items must show a neutral best-effort explanation. Shared config remains read-only in this task.

- [ ] **Step 4: Run tests, check and commit**

Run: `pnpm --dir apps/desktop test --run src/features/projects && pnpm --dir apps/desktop check`

```powershell
git add -- apps/desktop/src/features/projects apps/desktop/src/styles/base.css
git commit -m "feat: add project detail and assembly views"
```

### Task 5: Wire routes, bilingual copy and production unavailable boundaries

**Files:**
- Modify: `apps/desktop/src/app/router.tsx`
- Modify: `apps/desktop/src/i18n/en-US/common.json`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`
- Modify: `apps/desktop/src/styles/base.css`
- Test: `apps/desktop/src/app/router.test.tsx` only if route behavior changes need coverage

**Interfaces:**
- `/agents` renders `AgentListPage` with `unavailableAgentFacade`.
- `/agents/:agentKey` renders `AgentDetailPage` with `unavailableAgentFacade`.
- `/projects` renders `ProjectListPage` with `unavailableProjectFacade`.
- `/projects/:projectKey` renders `ProjectDetailPage` with `unavailableProjectFacade`.

- [ ] **Step 1: Write failing production-route boundary tests**

```tsx
it("does not show fixture Agents or projects through production routes", async () => {
  renderRouter("/agents");
  expect(await screen.findByText(/Agent 数据尚未连接|Agent data is not connected/)).toBeVisible();
  expect(screen.queryByText("Demo Project")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run route test and observe placeholder behavior**

Run: `pnpm --dir apps/desktop test --run src/app/router.test.tsx`

Expected: FAIL because Agents and projects still render placeholders.

- [ ] **Step 3: Replace placeholders and add all i18n keys**

Keep AppShell route title mappings unchanged unless tests show a missing title. Add matching English and Chinese labels for facts, unavailable states, experimental features, Runtime Hook, tags and assembly statuses. Run the locale key-set test immediately after JSON changes.

- [ ] **Step 4: Run discovery, agents, projects, route and locale tests; commit**

Run: `pnpm --dir apps/desktop test --run src/features/discovery src/features/import src/features/agents src/features/projects src/app/router.test.tsx src/i18n/i18n.test.ts && pnpm --dir apps/desktop check`

```powershell
git add -- apps/desktop/src/features/agents apps/desktop/src/features/projects apps/desktop/src/app/router.tsx apps/desktop/src/i18n apps/desktop/src/styles/base.css
git commit -m "feat: wire Agent and project workspace routes"
```

### Task 6: Verify Task8 and prepare review

**Files:**
- Modify only files implicated by a failing verification command within Task8 scope.

- [ ] **Step 1: Run complete frontend quality gates**

Run: `pnpm check:frontend; pnpm test:frontend; pnpm build:frontend; git diff --check`

Expected: all commands exit successfully; only the known large-chunk build warning may remain.

- [ ] **Step 2: Run feature security scan**

Run: `rg -n "\b(Command|Command::|git|npx|npm|pnpm|fetch|WebSocket)\b" apps/desktop/src/features/agents apps/desktop/src/features/projects`

Expected: no process, shell, network or package execution references in feature code.

- [ ] **Step 3: Review accessibility and visual constraints**

Verify unavailable states, keyboard focus, long-path wrapping, flat project filtering, shared-target counts, experimental labels, reduced-motion inheritance and no runtime/authorization claims.

- [ ] **Step 4: Commit only verification corrections**

```powershell
git add -- apps/desktop/src/features/agents apps/desktop/src/features/projects apps/desktop/src/app apps/desktop/src/i18n apps/desktop/src/styles/base.css
git commit -m "fix: harden Agent and project workspace verification"
```

Skip this commit when no corrective changes are needed.

- [ ] **Step 5: Report the branch and limitations**

Report branch, commits, tests, build result, production unavailable limitation and exact files changed. Do not create or merge a PR unless explicitly requested.
