# SkillHub Desktop Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the confirmed high-density desktop experience: initialization, cached home, Skill/Agent/project workspaces, customizable dynamic drawers, Markdown preview/editing, import/deployment/security/pending/recovery flows, settings and bilingual accessible interaction.

**Architecture:** React feature modules consume only generated Rust queries/commands through TanStack Query. Radix provides accessible behavior, SkillHub-owned components and design tokens provide the visual system, and all risky actions use prepare/preview/commit flows from the Rust core.

**Tech Stack:** React, TypeScript, Vite, TanStack Query/Table, Tailwind CSS, Radix Primitives, Motion, ECharts, CodeMirror 6, remark/rehype, Mermaid strict mode, i18next, Vitest, Testing Library, Playwright.

**Spec:** `docs/产品与交互设计.md` sections 1–20; `docs/需求文档.md` section 6 and 7; `docs/技术架构设计.md` 14–17.

## Global Constraints

- Do not let React read/write files, SQLite or credentials directly.
- Do not show deployment as Agent loaded/authorized/usable.
- Do not use a single health score or merge lifecycle/deployment/version/security states.
- Preserve list filter, selection, scroll and focus when drawers open/close.
- Support system scaling, keyboard navigation, screen readers and reduced motion on Windows/macOS.
- Specific brand colors remain a later visual choice; implement semantic tokens and light/dark/system themes now.
- Remote images are blocked by default; links show their actual target before opening.

---

### Task 1: Build design tokens, accessible primitives, routing and i18n

**Files:**
- Create: `apps/desktop/src/styles/theme.css`
- Create: `apps/desktop/src/styles/base.css`
- Create: `apps/desktop/src/ui/Button.tsx`
- Create: `apps/desktop/src/ui/Drawer.tsx`
- Create: `apps/desktop/src/ui/ConfirmDialog.tsx`
- Create: `apps/desktop/src/ui/StatusBadge.tsx`
- Create: `apps/desktop/src/ui/DataState.tsx`
- Create: `apps/desktop/src/app/router.tsx`
- Create: `apps/desktop/src/app/queryClient.ts`
- Create: `apps/desktop/src/i18n/index.ts`
- Create: `apps/desktop/src/i18n/zh-CN/common.json`
- Create: `apps/desktop/src/i18n/en-US/common.json`
- Test: `apps/desktop/src/ui/Drawer.test.tsx`
- Test: `apps/desktop/src/i18n/i18n.test.ts`

**Interfaces:**
- Produces: semantic tokens, `Drawer`, `ConfirmDialog`, `StatusBadge`, `AppRouter`, `queryClient`, typed translation resources.

- [ ] **Step 1: Write focus-return and reduced-motion drawer tests**

```tsx
it("returns focus to the invoking row when the drawer closes", async () => {
  render(<DrawerHarness />);
  await user.click(screen.getByRole("button", { name: "PDF Skill" }));
  await user.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.getByRole("button", { name: "PDF Skill" })).toHaveFocus();
});

it("removes transform motion when reduced motion is requested", () => {
  mockReducedMotion(true);
  render(<Drawer open onOpenChange={() => {}}>内容</Drawer>);
  expect(screen.getByTestId("drawer-panel")).toHaveAttribute("data-reduced-motion", "true");
});
```

- [ ] **Step 2: Write locale-completeness test**

```ts
it("ships identical key sets for Simplified Chinese and English", () => {
  expect(flatKeys(enUS)).toEqual(flatKeys(zhCN));
});
```

- [ ] **Step 3: Run tests and observe missing components**

Run: `pnpm --dir apps/desktop test --run src/ui/Drawer.test.tsx src/i18n/i18n.test.ts`

Expected: FAIL with missing files.

- [ ] **Step 4: Implement tokens and primitives**

Use CSS variables for color roles, typography, spacing, radii, shadows and motion durations. Configure `MotionConfig reducedMotion="user"`; use Radix focus management. i18n starts with system locale, supports immediate switching and formats date/time/size through `Intl`.

Run: `pnpm --dir apps/desktop test --run src/ui/Drawer.test.tsx src/i18n/i18n.test.ts && pnpm --dir apps/desktop build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/desktop/src/styles apps/desktop/src/ui apps/desktop/src/app/router.tsx apps/desktop/src/app/queryClient.ts apps/desktop/src/i18n apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat: add accessible SkillHub desktop design foundation"
```

---

### Task 2: Implement application shell, cached startup and initialization wizard

**Files:**
- Create: `apps/desktop/src/app/AppShell.tsx`
- Create: `apps/desktop/src/app/Sidebar.tsx`
- Create: `apps/desktop/src/features/bootstrap/api.ts`
- Create: `apps/desktop/src/features/bootstrap/BootstrapGate.tsx`
- Create: `apps/desktop/src/features/onboarding/OnboardingWizard.tsx`
- Create: `apps/desktop/src/features/onboarding/LibraryStep.tsx`
- Create: `apps/desktop/src/features/onboarding/CompatibilityStep.tsx`
- Create: `apps/desktop/src/features/onboarding/ScanStep.tsx`
- Test: `apps/desktop/src/features/bootstrap/BootstrapGate.test.tsx`
- Test: `apps/desktop/src/features/onboarding/OnboardingWizard.test.tsx`

**Interfaces:**
- Consumes: `GetBootstrapSnapshot`, `RunInitializationScan`, `DiscoverAgents`.
- Produces: persistent navigation shell and skippable initialization flow.

- [ ] **Step 1: Write cached-startup test**

```tsx
it("shows cached home data while filesystem verification continues", async () => {
  mockQuery("GetBootstrapSnapshot", cachedSnapshot({ skills: 42, scanPhase: "verifying" }));
  render(<BootstrapGate />);
  expect(await screen.findByText("42")).toBeVisible();
  expect(screen.getByText("正在核对本地变化")).toBeVisible();
  expect(screen.queryByRole("progressbar", { name: "阻塞启动" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Write skip and path-confirmation tests**

```tsx
it("allows skipping while requiring explicit confirmation before creating the default library", async () => {
  render(<OnboardingWizard />);
  expect(screen.getByText(currentPlatformDefaultLibraryPath())).toBeVisible();
  await user.click(screen.getByRole("button", { name: "跳过初始化" }));
  expect(mockCommands()).toContainEqual({ type: "complete_onboarding", payload: { skipped: true } });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --dir apps/desktop test --run src/features/bootstrap src/features/onboarding`

Expected: FAIL with missing shell/wizard.

- [ ] **Step 4: Implement startup and wizard states**

Show cached navigation immediately. Wizard steps are library path, compatibility targets and optional initial scan; every step can go back, and the entire wizard can be skipped. Compatibility choices require confirmation and never auto-deploy. Migration/recovery has a truthful blocking screen; ordinary scans remain background tasks.

Run: `pnpm --dir apps/desktop test --run src/features/bootstrap src/features/onboarding`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/desktop/src/app apps/desktop/src/features/bootstrap apps/desktop/src/features/onboarding apps/desktop/src/i18n
git commit -m "feat: show cached startup and skippable initialization"
```

---

### Task 3: Implement overview and deployment-distribution bar chart

**Files:**
- Create: `apps/desktop/src/features/overview/OverviewPage.tsx`
- Create: `apps/desktop/src/features/overview/DeploymentBarChart.tsx`
- Create: `apps/desktop/src/features/overview/PendingSummary.tsx`
- Create: `apps/desktop/src/features/overview/api.ts`
- Test: `apps/desktop/src/features/overview/OverviewPage.test.tsx`

**Interfaces:**
- Consumes: `BootstrapSnapshot`, deployment distribution and pending summary queries.
- Produces: overview with actionable chart drill-down.

- [ ] **Step 1: Write chart content and drill-down tests**

```tsx
it("renders deployment counts as bars and opens the matching filtered workspace", async () => {
  render(<OverviewPage />, { wrapper: seededQueries(overviewFixture()) });
  expect(await screen.findByRole("img", { name: /各 Agent 部署数量/ })).toBeVisible();
  expect(screen.getByText("Codex 12")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "查看 Codex 的 12 个部署" }));
  expect(mockNavigate()).toHaveBeenCalledWith("/agents/openai.codex-cli?view=deployments");
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --dir apps/desktop test --run src/features/overview`

Expected: FAIL with missing overview.

- [ ] **Step 3: Implement lazy ECharts with textual equivalent**

Lazy-load ECharts after cached summary renders. Use bar chart only, enable ARIA description and visible numerical summary. Do not show recent-operation logs on home; show only pending/actionable summaries and deployment distribution.

- [ ] **Step 4: Run tests and build**

Run: `pnpm --dir apps/desktop test --run src/features/overview && pnpm --dir apps/desktop build`

Expected: PASS; ECharts is emitted as a lazy chunk.

- [ ] **Step 5: Commit**

```bash
git add -- apps/desktop/src/features/overview apps/desktop/src/app/router.tsx apps/desktop/src/i18n apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat: add actionable deployment overview chart"
```

---

### Task 4: Implement Skill library table, saved views and configurable quick drawer

**Files:**
- Create: `apps/desktop/src/features/skills/SkillLibraryPage.tsx`
- Create: `apps/desktop/src/features/skills/SkillTable.tsx`
- Create: `apps/desktop/src/features/skills/SkillFilters.tsx`
- Create: `apps/desktop/src/features/skills/SavedViews.tsx`
- Create: `apps/desktop/src/features/skills/SkillQuickDrawer.tsx`
- Create: `apps/desktop/src/features/skills/drawerModules.ts`
- Create: `apps/desktop/src/features/skills/api.ts`
- Test: `apps/desktop/src/features/skills/SkillLibraryPage.test.tsx`
- Test: `apps/desktop/src/features/skills/SkillQuickDrawer.test.tsx`

**Interfaces:**
- Consumes: `SearchQuery`, catalog page query, saved-view and UI-preference commands.
- Produces: high-density list, multi-select, saved filters and user-configurable summary drawer.

- [ ] **Step 1: Write selection-scope and saved-view tests**

```tsx
it("distinguishes visible rows from all filtered results before batch action", async () => {
  render(<SkillLibraryPage />, { wrapper: seededQueries(skillPageFixture(25, 80)) });
  await user.click(screen.getByRole("checkbox", { name: "选择当前页面 25 项" }));
  expect(screen.getByText("已选择当前页面 25 项")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "选择全部 80 个筛选结果" }));
  expect(screen.getByText("已选择全部 80 项")).toBeVisible();
});
```

- [ ] **Step 2: Write configurable-drawer test**

```tsx
it("allows global module ordering while keeping required modules visible", async () => {
  render(<SkillQuickDrawer skillId={skillId} />);
  await user.click(screen.getByRole("button", { name: "配置快速抽屉" }));
  expect(screen.getByText("名称与主要操作")).toHaveAttribute("aria-disabled", "true");
  await dragModule("部署摘要", "安全检查");
  expect(mockCommands()).toContainEqual(expect.objectContaining({ type: "save_drawer_preferences" }));
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --dir apps/desktop test --run src/features/skills/SkillLibraryPage.test.tsx src/features/skills/SkillQuickDrawer.test.tsx`

Expected: FAIL with missing Skill workspace.

- [ ] **Step 4: Implement TanStack Table and drawer behavior**

Support search, combination filters, tags, lifecycle, deployment, version, separate security summaries, density, columns and saved views. Drawer width has standard/wide/near-fullscreen plus drag resize; required modules cannot be hidden. Row navigation and drawer switching preserve list scroll/selection.

Run: `pnpm --dir apps/desktop test --run src/features/skills`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/desktop/src/features/skills apps/desktop/src/app/router.tsx apps/desktop/src/i18n
git commit -m "feat: add high-density Skill library and quick drawer"
```

---

### Task 5: Implement Skill detail, metadata, lifecycle, trial and version history

**Files:**
- Create: `apps/desktop/src/features/skill-detail/SkillDetailPage.tsx`
- Create: `apps/desktop/src/features/skill-detail/MetadataPanel.tsx`
- Create: `apps/desktop/src/features/skill-detail/LifecyclePanel.tsx`
- Create: `apps/desktop/src/features/skill-detail/TrialActions.tsx`
- Create: `apps/desktop/src/features/skill-detail/VersionTimeline.tsx`
- Create: `apps/desktop/src/features/skill-detail/RelationsPanel.tsx`
- Create: `apps/desktop/src/features/skill-detail/RequirementsPanel.tsx`
- Test: `apps/desktop/src/features/skill-detail/SkillDetailPage.test.tsx`

**Interfaces:**
- Consumes: catalog, version, relation, source, requirement, combination and trial commands/queries.
- Produces: authoritative complete Skill detail page.

- [ ] **Step 1: Write original/translation/note and trial-close-loop tests**

```tsx
it("keeps original description, saved translation and user note distinct", async () => {
  render(<SkillDetailPage skillId={skillId} />, { wrapper: seededQueries(detailFixture()) });
  expect(await screen.findByText("Original description")).toBeVisible();
  expect(screen.getByText("模型译文")).toBeVisible();
  expect(screen.getByLabelText("我的用途说明")).toHaveValue("用于 PDF 表格提取");
});

it("converts trial by removing only the trial label", async () => {
  render(<TrialActions skillId={trialSkillId} />, { wrapper: seededQueries(trialFixture()) });
  await user.click(screen.getByRole("button", { name: "正式纳入管理" }));
  expect(mockCommands()).toContainEqual({ type: "set_trial", payload: { skill_id: trialSkillId, trial: null } });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail`

Expected: FAIL with missing detail modules.

- [ ] **Step 3: Implement independent panels and high-risk summaries**

Display identity/source/license, versions/diff/rollback, Agent/project/physical directory relations, call policy, declared requirements, separate checks, duplicate analysis, combinations, external changes and operation history. Never imply declared dependencies were verified or installed.

- [ ] **Step 4: Run tests**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/desktop/src/features/skill-detail apps/desktop/src/features/skills apps/desktop/src/i18n
git commit -m "feat: add complete Skill lifecycle detail workspace"
```

---

### Task 6: Implement secure Markdown preview and lightweight editor

**Files:**
- Create: `apps/desktop/src/features/markdown/MarkdownWorkspace.tsx`
- Create: `apps/desktop/src/features/markdown/MarkdownRenderer.tsx`
- Create: `apps/desktop/src/features/markdown/MarkdownEditor.tsx`
- Create: `apps/desktop/src/features/markdown/MermaidBlock.tsx`
- Create: `apps/desktop/src/features/markdown/ExternalLink.tsx`
- Create: `apps/desktop/src/features/markdown/RemoteImage.tsx`
- Create: `apps/desktop/src/features/markdown/sanitize.ts`
- Test: `apps/desktop/src/features/markdown/MarkdownRenderer.test.tsx`
- Test: `apps/desktop/src/features/markdown/MarkdownEditor.test.tsx`
- Create: `fixtures/skills/markdown-format/SKILL.md`
- Create: `fixtures/skills/markdown-unsafe/SKILL.md`

**Interfaces:**
- Consumes: read Markdown file, save draft, validate/save Skill content and open external application commands.
- Produces: reading/source/edit modes with safe rendering.

- [ ] **Step 1: Write format and sanitization tests**

```tsx
it("renders GFM tables code and frontmatter while removing script and event handlers", async () => {
  render(<MarkdownRenderer markdown={unsafeRichMarkdownFixture} />);
  expect(screen.getByRole("table")).toBeVisible();
  expect(screen.getByText("typescript")).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector("[onclick]")).toBeNull();
});

it("blocks remote images and confirms the actual external link target", async () => {
  render(<MarkdownRenderer markdown={'![x](https://img.example/x.png) [site](https://example.com)'} />);
  expect(screen.getByText("远程图片已阻止：img.example")).toBeVisible();
  await user.click(screen.getByRole("link", { name: "site" }));
  expect(screen.getByText("https://example.com")).toBeVisible();
});
```

- [ ] **Step 2: Write draft/save test**

```tsx
it("keeps draft local and creates a version only after explicit save", async () => {
  render(<MarkdownEditor initial="# A" skillId={skillId} />);
  await user.type(screen.getByRole("textbox"), " changed");
  expect(mockCommands()).not.toContainEqual(expect.objectContaining({ type: "save_skill_content" }));
  await user.click(screen.getByRole("button", { name: "保存并创建版本" }));
  expect(mockCommands()).toContainEqual(expect.objectContaining({ type: "save_skill_content" }));
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --dir apps/desktop test --run src/features/markdown`

Expected: FAIL with missing renderer/editor.

- [ ] **Step 4: Implement strict renderer and CodeMirror editor**

Support CommonMark, GFM, frontmatter, task lists, tables, footnotes, local images and code highlighting. Mermaid uses strict security mode and falls back to code. Unknown syntax remains in source. Read-only content offers copy/takeover and external-open actions but no in-place save.

Run: `pnpm --dir apps/desktop test --run src/features/markdown && pnpm --dir apps/desktop build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/desktop/src/features/markdown fixtures/skills/markdown-format fixtures/skills/markdown-unsafe apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat: preview and edit Markdown safely"
```

---

### Task 7: Implement discovery, source, import and conflict UI

**Files:**
- Create: `apps/desktop/src/features/discovery/DiscoveryPage.tsx`
- Create: `apps/desktop/src/features/discovery/LocalDiscovery.tsx`
- Create: `apps/desktop/src/features/discovery/OnlineDiscovery.tsx`
- Create: `apps/desktop/src/features/import/ImportWizard.tsx`
- Create: `apps/desktop/src/features/import/SourceInput.tsx`
- Create: `apps/desktop/src/features/import/CandidateSelection.tsx`
- Create: `apps/desktop/src/features/import/ConflictResolution.tsx`
- Create: `apps/desktop/src/features/import/ImportSummary.tsx`
- Test: `apps/desktop/src/features/import/ImportWizard.test.tsx`

**Interfaces:**
- Consumes: source parser/acquisition, prepare/commit import, local search and online source search APIs.
- Produces: one import wizard for every entry point.

- [ ] **Step 1: Write npx-reference and local ownership tests**

```tsx
it("explains that npx text is parsed and never executed", async () => {
  render(<ImportWizard />);
  await user.type(screen.getByLabelText("来源"), "npx skills add github:owner/repo");
  expect(await screen.findByText("只解析来源，不执行 npx 命令")).toBeVisible();
});

it("offers relation/takeover before copy for a recognized Agent directory", async () => {
  render(<ImportWizard />, { wrapper: seededQueries(agentOwnedCandidate()) });
  expect(await screen.findByRole("radio", { name: "纳入管理并保留当前位置" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "复制到集中库" })).not.toBeChecked();
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --dir apps/desktop test --run src/features/import`

Expected: FAIL with missing wizard.

- [ ] **Step 3: Implement unified prepare/decision/commit flow**

Show acquisition progress, one/many candidate selection, format/basic check summary, exact/same-name/semantic conflicts, copy/takeover/reuse/independent/skip choices and optional target selection. Force import never displays overwrite as a meaning.

- [ ] **Step 4: Run tests**

Run: `pnpm --dir apps/desktop test --run src/features/discovery src/features/import`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/desktop/src/features/discovery apps/desktop/src/features/import apps/desktop/src/app/router.tsx apps/desktop/src/i18n
git commit -m "feat: add unified discovery and import workflow"
```

---

### Task 8: Implement Agent and project workspaces

**Files:**
- Create: `apps/desktop/src/features/agents/AgentListPage.tsx`
- Create: `apps/desktop/src/features/agents/AgentDetailPage.tsx`
- Create: `apps/desktop/src/features/agents/RelationsView.tsx`
- Create: `apps/desktop/src/features/agents/UsageEvidencePanel.tsx`
- Create: `apps/desktop/src/features/projects/ProjectListPage.tsx`
- Create: `apps/desktop/src/features/projects/ProjectQuickDrawer.tsx`
- Create: `apps/desktop/src/features/projects/ProjectDetailPage.tsx`
- Create: `apps/desktop/src/features/projects/SharedConfigPanel.tsx`
- Create: `apps/desktop/src/features/projects/BestEffortAssembly.tsx`
- Test: `apps/desktop/src/features/agents/AgentDetailPage.test.tsx`
- Test: `apps/desktop/src/features/projects/ProjectListPage.test.tsx`

**Interfaces:**
- Consumes: discovery/project/profile/shared config/evidence queries and commands.
- Produces: separate client instances, merged physical directory view, multi-tag project workspace and best-effort assembly UI.

- [ ] **Step 1: Write no-runtime-claim and shared-target tests**

```tsx
it("shows discovered directory facts without trust or usability status", async () => {
  render(<AgentDetailPage />, { wrapper: seededQueries(agentFixture()) });
  expect(await screen.findByText("已发现客户端和 Skill 目录")).toBeVisible();
  expect(screen.queryByText(/已授权|可用|验证通过/)).not.toBeInTheDocument();
});

it("renders two logical clients connected to one physical directory", async () => {
  render(<RelationsView data={sharedTargetFixture()} />);
  expect(screen.getAllByTestId("logical-target")).toHaveLength(2);
  expect(screen.getAllByTestId("physical-target")).toHaveLength(1);
});
```

- [ ] **Step 2: Write project multi-tag test**

```tsx
it("filters one project through multiple tags without creating a folder tree", async () => {
  render(<ProjectListPage />, { wrapper: seededQueries(projectFixture()) });
  await chooseTag("客户项目");
  await chooseTag("Rust");
  expect(screen.getByText("Demo Project")).toBeVisible();
  expect(screen.queryByRole("tree")).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --dir apps/desktop test --run src/features/agents src/features/projects`

Expected: FAIL with missing workspaces.

- [ ] **Step 4: Implement pages and experimental labels**

Agent page separates brand/client/instance and physical relations; usage evidence is marked “实验功能，仅供参考”, while Runtime Hook is “研发中”. Project list supports saved filters, configurable drawer and bulk actions; best-effort assembly shows satisfied/skipped/conflict/failed entries without claiming all-or-nothing success.

Run: `pnpm --dir apps/desktop test --run src/features/agents src/features/projects`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/desktop/src/features/agents apps/desktop/src/features/projects apps/desktop/src/app/router.tsx apps/desktop/src/i18n
git commit -m "feat: add Agent and project management workspaces"
```

---

### Task 9: Implement deployment, security, pending, removal and recovery workflows

**Files:**
- Create: `apps/desktop/src/features/deployment/DeploymentDialog.tsx`
- Create: `apps/desktop/src/features/deployment/DeploymentResults.tsx`
- Create: `apps/desktop/src/features/security/SecurityResults.tsx`
- Create: `apps/desktop/src/features/security/FindingActions.tsx`
- Create: `apps/desktop/src/features/pending/PendingPage.tsx`
- Create: `apps/desktop/src/features/removal/RemovalImpactDialog.tsx`
- Create: `apps/desktop/src/features/recovery/RecoveryPage.tsx`
- Create: `apps/desktop/src/features/operations/OperationProgress.tsx`
- Test: `apps/desktop/src/features/deployment/DeploymentDialog.test.tsx`
- Test: `apps/desktop/src/features/security/SecurityResults.test.tsx`
- Test: `apps/desktop/src/features/removal/RemovalImpactDialog.test.tsx`

**Interfaces:**
- Consumes: prepare/commit deployment/removal/repair operations and separate check results.
- Produces: risk-aware operation workflows and pending closure actions.

- [ ] **Step 1: Write multi-select and physical-result tests**

```tsx
it("supports one or many Agent targets and reports each result", async () => {
  render(<DeploymentDialog skillId={skillId} />, { wrapper: seededQueries(deploymentTargets()) });
  await user.click(screen.getByLabelText("Codex CLI"));
  await user.click(screen.getByLabelText("Claude Code"));
  await user.click(screen.getByRole("button", { name: "预览部署" }));
  expect(await screen.findAllByTestId("target-plan")).toHaveLength(2);
});
```

- [ ] **Step 2: Write separate-check and linked-resolution tests**

```tsx
it("renders basic and LLM checks independently and refreshes summary after handling", async () => {
  render(<SecurityResults skillId={skillId} />, { wrapper: seededQueries(separateCheckFixture()) });
  expect(screen.getByRole("heading", { name: "基础安全检查" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "LLM 安全检查" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "确认并忽略此项" }));
  expect(mockInvalidations()).toContain("skill-security-summary");
});
```

- [ ] **Step 3: Write delete dependency test**

```tsx
it("requires a choice for each deployment before deleting the central Skill", async () => {
  render(<RemovalImpactDialog impact={deleteImpactFixture()} />);
  expect(screen.getAllByRole("combobox", { name: /部署处理方式/ })).toHaveLength(2);
  expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
});
```

- [ ] **Step 4: Implement workflows and run tests**

Operations show planned mode in plain language with technical detail collapsed. Pending items expose direct resolve/recheck/convert/delete/recover actions. Progress survives page navigation via operation ID; partial failure lists every outcome. High-risk confirmation cannot be reduced to a generic OK dialog.

Run: `pnpm --dir apps/desktop test --run src/features/deployment src/features/security src/features/pending src/features/removal src/features/recovery src/features/operations`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/desktop/src/features/deployment apps/desktop/src/features/security apps/desktop/src/features/pending apps/desktop/src/features/removal apps/desktop/src/features/recovery apps/desktop/src/features/operations apps/desktop/src/i18n
git commit -m "feat: add deployment safety and recovery workflows"
```

---

### Task 10: Implement settings, network-storage placeholder and application update UX

**Files:**
- Create: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Create: `apps/desktop/src/features/settings/GeneralSettings.tsx`
- Create: `apps/desktop/src/features/settings/LibrarySettings.tsx`
- Create: `apps/desktop/src/features/settings/ViewSettings.tsx`
- Create: `apps/desktop/src/features/settings/AutomationSettings.tsx`
- Create: `apps/desktop/src/features/settings/AiNetworkSettings.tsx`
- Create: `apps/desktop/src/features/settings/BackupSettings.tsx`
- Create: `apps/desktop/src/features/settings/NetworkStoragePlaceholder.tsx`
- Create: `apps/desktop/src/features/settings/ApplicationUpdate.tsx`
- Test: `apps/desktop/src/features/settings/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: settings, credentials, backup, network policy and app update queries/commands.
- Produces: all confirmed settings and no fake future actions.

- [ ] **Step 1: Write global network-off and placeholder tests**

```tsx
it("turns off online helpers while leaving local management enabled", async () => {
  render(<AiNetworkSettings settings={networkSettings()} />);
  await user.click(screen.getByLabelText("关闭所有网络功能"));
  expect(mockCommands()).toContainEqual(expect.objectContaining({ type: "set_network_enabled", payload: { enabled: false } }));
  expect(screen.getByText("本地扫描、搜索、部署和备份仍可使用")).toBeVisible();
});

it("network storage page has no connect authorize or test button", () => {
  render(<NetworkStoragePlaceholder />);
  expect(screen.getByText("下一大版本规划")).toBeVisible();
  expect(screen.queryByRole("button", { name: /连接|授权|测试/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Write unsigned-manual-update test**

```tsx
it("opens the release page instead of claiming automatic update on unsigned builds", async () => {
  render(<ApplicationUpdate buildTrust="windows_unsigned" update={availableUpdate()} />);
  await user.click(screen.getByRole("button", { name: "打开 GitHub Release" }));
  expect(mockCommands()).toContainEqual(expect.objectContaining({ type: "open_official_release" }));
  expect(screen.queryByText("自动安装中")).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --dir apps/desktop test --run src/features/settings`

Expected: FAIL with missing settings UI.

- [ ] **Step 4: Implement settings modules**

Include language/theme, library path and migration entry, scan roots/frequency, UI preferences, per-Skill/batch/global auto-check/upgrade, LLM provider test and data-scope disclosure, private sources, network master switch, backup retention/location, Windows/macOS update trust text and the network-storage future placeholder.

Run: `pnpm --dir apps/desktop test --run src/features/settings`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/desktop/src/features/settings apps/desktop/src/app/router.tsx apps/desktop/src/i18n
git commit -m "feat: add local settings and future storage boundary"
```

---

### Task 11: Add desktop end-to-end accessibility and startup tests

**Files:**
- Create: `tests/e2e/playwright.config.ts`
- Create: `tests/e2e/fixtures.ts`
- Create: `tests/e2e/onboarding.spec.ts`
- Create: `tests/e2e/import-deploy.spec.ts`
- Create: `tests/e2e/edit-recover.spec.ts`
- Create: `tests/e2e/keyboard-accessibility.spec.ts`
- Create: `tests/e2e/startup-performance.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: repeatable user-journey and startup measurements against an isolated app-data/library fixture.

- [ ] **Step 1: Write the closed-loop E2E scenario**

```ts
test("ordinary user imports, checks, deploys, edits and undeploys without Git or admin", async ({ app }) => {
  await app.skipOnboarding();
  await app.importLocalFixture("safe-pdf");
  await app.expectBasicCheck("检查通过");
  await app.deployTo("Codex fixture");
  await app.editSkillMd("用途备注");
  await app.undeployKeepingCentralSkill();
  await app.expectCentralSkill("safe-pdf");
});
```

- [ ] **Step 2: Add keyboard/focus and reduced-motion journeys**

Tab through navigation, table, drawer, dialogs and confirmations; assert visible focus and return focus. Start with reduced-motion media setting and assert drawer/page transitions omit transforms.

- [ ] **Step 3: Add startup timing capture**

Seed 100 Skills and cached snapshot, record process start to first enabled primary navigation element, and assert `<= 2000ms` only on the documented reference runner profile. Record background verification separately; do not wait for it in the interactive metric.

- [ ] **Step 4: Run E2E locally**

Run: `pnpm test:e2e`

Expected: all scenarios PASS; startup report records cached-interactive and background-scan timings separately.

- [ ] **Step 5: Commit**

```bash
git add -- tests/e2e package.json pnpm-lock.yaml
git commit -m "test: cover desktop lifecycle and accessibility journeys"
```

---

## Plan Verification

Run fresh:

```text
pnpm check:frontend
pnpm test:frontend
pnpm --dir apps/desktop build
pnpm test:e2e
```

Then manually inspect the Windows and macOS builds at 100%, 125%, 150% and 200% scaling; verify Chinese/English switching, keyboard-only operation, screen-reader labels, reduced motion, long Markdown, 300-row tables, drawer resizing and partial-operation results.
