# Desktop Discovery and Import UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Plan07 Task7 discovery entry points and a safe, unified import wizard against a typed frontend Mock Facade, without changing Rust or generated bindings.

**Architecture:** The import feature is isolated behind `ImportFacade`. Its production implementation reports an unavailable boundary, while tests use deterministic fixtures for parsing, acquisition, conflict analysis and commit outcomes. `DiscoveryPage` owns local/online entry surfaces; `ImportWizard` composes source, candidate, conflict and summary steps and never touches files, network, commands or native bindings directly.

**Tech Stack:** React 18, TypeScript, React Router, TanStack Query-compatible injected facades, existing SkillHub UI primitives/tokens, i18next, Vitest and Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-27-desktop-import-task7-design.md`

## Global Constraints

- Do not modify Rust crates, Specta-generated bindings, or native command/query/event contracts.
- Do not read/write files, access HTTP, invoke Git/npx/shell/package scripts, or execute imported content from React.
- Mock data may appear only in tests or an explicitly isolated development preview route; production routes use `unavailableImportFacade`.
- “独立导入/Import independently” never means overwrite and never bypasses required conflict decisions.
- Agent discovery reports observed directory facts only; it must not claim authorization, usability or successful runtime execution.
- Preserve source input on failure/cancel, keep partial commit outcomes itemized, and expose retry/cancel actions.
- Reuse existing semantic tokens and primitives; no new hard-coded theme palette or component-shape redesign.
- All user-visible copy is present in both `zh-CN` and `en-US`; status is conveyed by text, icon and semantic color.
- Every behavior change follows TDD: write a failing test, run it to observe the expected failure, implement the smallest passing change, then rerun focused and full checks.

---

### Task 1: Define the Import Facade, parser and deterministic fixtures

**Files:**
- Create: `apps/desktop/src/features/import/api.ts`
- Create: `apps/desktop/src/features/import/api.test.ts`

**Interfaces:**
- Produces `SourceInputKind`, `ImportPhase`, `CandidateOwnership`, `ImportAction`, `ConflictKind`, `SourceDescriptor`, `ImportCandidate`, `ImportConflict`, `ImportPlan`, `ImportResult`, `ImportFacade`, `parseSourceInput`, `unavailableImportFacade`, and `createMockImportFacade`.
- `ImportFacade.parseSource(input: string): Promise<SourceDescriptor>` must never execute a command.
- `ImportFacade.acquireCandidates(source: SourceDescriptor, signal?: AbortSignal): Promise<ImportCandidate[]>` supports cancellation.
- `ImportFacade.analyzeConflicts(candidates: ImportCandidate[]): Promise<ImportPlan>` returns per-candidate required conflicts.
- `ImportFacade.commitImport(plan: ImportPlan, actions: Record<string, ImportAction>): Promise<ImportResult[]>` returns one result per candidate.

- [ ] **Step 1: Write the failing parser and facade tests**

```ts
it("parses npx text as a non-executable reference", async () => {
  const source = await parseSourceInput("npx skills add github:owner/repo");
  expect(source).toEqual(expect.objectContaining({
    kind: "npx_reference",
    displayTarget: "github:owner/repo",
    executesCommand: false,
  }));
});

it("rejects acquisition and commit at the production boundary", async () => {
  const source = await unavailableImportFacade.parseSource("C:\\Skills\\pdf");
  await expect(unavailableImportFacade.acquireCandidates(source)).rejects.toThrow(
    "import is unavailable",
  );
  await expect(unavailableImportFacade.commitImport({ candidates: [], conflicts: [] }, {}))
    .rejects.toThrow("import is unavailable");
});

it("returns deterministic Agent ownership and partial commit fixtures", async () => {
  const facade = createMockImportFacade({ scenario: "agent-owned-partial" });
  const source = await facade.parseSource("C:\\Agents\\codex\\skills");
  const candidates = await facade.acquireCandidates(source);
  expect(candidates[0].ownership).toBe("agent_builtin");
  const plan = await facade.analyzeConflicts(candidates);
  const results = await facade.commitImport(plan, {
    [candidates[0].id]: "takeover",
    [candidates[1].id]: "skip",
  });
  expect(results.map((result) => result.status)).toEqual(["succeeded", "skipped"]);
});
```

- [ ] **Step 2: Run the focused tests and observe the expected failure**

Run: `pnpm --dir apps/desktop test --run src/features/import/api.test.ts`

Expected: FAIL because the import API module and fixtures do not exist.

- [ ] **Step 3: Implement the minimal typed boundary and parser**

Implement the exact model from the spec. `parseSourceInput` trims input, recognizes `npx skills add ` followed by a non-empty reference, then `http:`, `https:`, Git-like values and otherwise treats the input as a local path. Every returned descriptor has `executesCommand: false`. `unavailableImportFacade` keeps parsing local but rejects acquisition, analysis and commit with `ImportUnavailableError`; `cancel` resolves without side effects.

```ts
export class ImportUnavailableError extends Error {
  constructor() {
    super("import is unavailable until the native contract is generated");
    this.name = "ImportUnavailableError";
  }
}
```

The Mock Facade clones fixtures before returning them, accepts a named scenario (`"safe-local"`, `"agent-owned-partial"`, `"conflict-required"`, `"cancelled"`), and records calls for assertions without invoking external APIs.

- [ ] **Step 4: Run the focused tests and verify the green result**

Run: `pnpm --dir apps/desktop test --run src/features/import/api.test.ts`

Expected: PASS with parser, unavailable-boundary and deterministic fixture assertions.

- [ ] **Step 5: Commit the facade contract**

```powershell
git add -- apps/desktop/src/features/import/api.ts apps/desktop/src/features/import/api.test.ts
git commit -m "feat: define desktop import facade boundary"
```

### Task 2: Build source input and candidate selection steps

**Files:**
- Create: `apps/desktop/src/features/import/SourceInput.tsx`
- Create: `apps/desktop/src/features/import/CandidateSelection.tsx`
- Create: `apps/desktop/src/features/import/SourceInput.test.tsx`
- Modify: `apps/desktop/src/features/import/api.ts` (only if fixture view helpers are required)

**Interfaces:**
- `SourceInput` props: `{ value: string; descriptor?: SourceDescriptor; disabled?: boolean; onChange(value: string): void; onParse(): void }`.
- `CandidateSelection` props: `{ candidates: ImportCandidate[]; selectedIds: string[]; onToggle(id: string): void; onContinue(): void; onBack(): void }`.
- Components emit no native calls and use existing `Button`, `DataState`, and semantic token classes.

- [ ] **Step 1: Write failing source and candidate tests**

```tsx
it("explains that npx input is parsed and never executed", async () => {
  const user = userEvent.setup();
  render(<SourceInput value="" onChange={vi.fn()} onParse={vi.fn()} />);
  await user.type(screen.getByLabelText("来源"), "npx skills add github:owner/repo");
  expect(screen.getByText("只解析来源，不执行 npx 命令")).toBeVisible();
});

it("supports selecting multiple candidates before continuing", async () => {
  const user = userEvent.setup();
  const candidates = createMockImportFacade({ scenario: "safe-local" }).fixtures.candidates;
  const onToggle = vi.fn();
  render(<CandidateSelection candidates={candidates} selectedIds={[]} onToggle={onToggle} onContinue={vi.fn()} onBack={vi.fn()} />);
  await user.click(screen.getByRole("checkbox", { name: candidates[0].name }));
  await user.click(screen.getByRole("checkbox", { name: candidates[1].name }));
  expect(onToggle).toHaveBeenNthCalledWith(1, candidates[0].id);
  expect(onToggle).toHaveBeenNthCalledWith(2, candidates[1].id);
});
```

- [ ] **Step 2: Run tests and verify the expected missing-component failure**

Run: `pnpm --dir apps/desktop test --run src/features/import/SourceInput.test.tsx`

Expected: FAIL because the source and candidate components do not exist.

- [ ] **Step 3: Implement source input and candidate list**

Use a labeled textarea/input with a live descriptor summary. Detect the npx prefix in the rendered value to show the non-execution note before parsing. Show parse errors inline while retaining the value. Candidate rows expose name, source target, path disclosure, ownership fact and basic-check text. The continue action is disabled when `selectedIds.length === 0`; row controls are keyboard reachable and selection is independent of visual color.

- [ ] **Step 4: Run focused tests and verify green**

Run: `pnpm --dir apps/desktop test --run src/features/import/SourceInput.test.tsx src/features/import/CandidateSelection.test.tsx`

Expected: PASS; add `CandidateSelection.test.tsx` if the component-specific test is split from the source test.

- [ ] **Step 5: Commit the first wizard steps**

```powershell
git add -- apps/desktop/src/features/import/SourceInput.tsx apps/desktop/src/features/import/CandidateSelection.tsx apps/desktop/src/features/import/SourceInput.test.tsx apps/desktop/src/features/import/CandidateSelection.test.tsx
git commit -m "feat: add import source and candidate steps"
```

### Task 3: Build conflict resolution and itemized summary

**Files:**
- Create: `apps/desktop/src/features/import/ConflictResolution.tsx`
- Create: `apps/desktop/src/features/import/ImportSummary.tsx`
- Create: `apps/desktop/src/features/import/ConflictResolution.test.tsx`
- Create: `apps/desktop/src/features/import/ImportSummary.test.tsx`

**Interfaces:**
- `ConflictResolution` props: `{ conflicts: ImportConflict[]; actions: Record<string, ImportAction>; onAction(candidateId: string, action: ImportAction): void; onContinue(): void; onBack(): void }`.
- `ImportSummary` props: `{ results: ImportResult[]; unavailable?: boolean; onRetry(): void; onOpenLibrary(): void }`.
- Conflict controls must expose only each conflict’s `allowedActions`; summary renders one result row per candidate.

- [ ] **Step 1: Write failing conflict and summary tests**

```tsx
it("keeps commit disabled until every required conflict has an action", async () => {
  const conflict: ImportConflict = {
    candidateId: "agent-pdf",
    kind: "agent_owned",
    summary: "目录已由 Agent 管理",
    allowedActions: ["takeover", "copy", "skip"],
    required: true,
  };
  const onContinue = vi.fn();
  render(<ConflictResolution conflicts={[conflict]} actions={{}} onAction={vi.fn()} onContinue={onContinue} onBack={vi.fn()} />);
  expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();
  await userEvent.setup().click(screen.getByRole("radio", { name: "保留当前位置并纳入管理" }));
  expect(screen.getByRole("button", { name: "继续" })).toBeEnabled();
});

it("renders partial success without collapsing skipped or failed candidates", () => {
  render(<ImportSummary results={[
    { candidateId: "a", action: "copy", status: "succeeded", message: "已导入" },
    { candidateId: "b", action: "skip", status: "skipped", message: "已跳过" },
    { candidateId: "c", action: "independent", status: "failed", message: "写入失败" },
  ]} onRetry={vi.fn()} onOpenLibrary={vi.fn()} />);
  expect(screen.getByText("已导入")).toBeVisible();
  expect(screen.getByText("已跳过")).toBeVisible();
  expect(screen.getByText("写入失败")).toBeVisible();
});
```

- [ ] **Step 2: Run focused tests and observe the expected failure**

Run: `pnpm --dir apps/desktop test --run src/features/import/ConflictResolution.test.tsx src/features/import/ImportSummary.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement explicit conflict choices and summary states**

Render conflict kind and summary per candidate. Map action labels in i18n: reuse, copy, takeover, independent and skip. Use the phrase “独立导入/Import independently” for `independent`; never render “overwrite”. Treat a missing required action as blocking. Summary supports completed, partial and unavailable variants; failed rows expose retry, but no unavailable variant fabricates results.

- [ ] **Step 4: Run focused tests and verify green**

Run: `pnpm --dir apps/desktop test --run src/features/import/ConflictResolution.test.tsx src/features/import/ImportSummary.test.tsx`

Expected: PASS with disabled/enabled commit behavior and itemized outcomes.

- [ ] **Step 5: Commit conflict and summary components**

```powershell
git add -- apps/desktop/src/features/import/ConflictResolution.tsx apps/desktop/src/features/import/ImportSummary.tsx apps/desktop/src/features/import/ConflictResolution.test.tsx apps/desktop/src/features/import/ImportSummary.test.tsx
git commit -m "feat: add import conflict and result summaries"
```

### Task 4: Compose the unified ImportWizard state machine

**Files:**
- Create: `apps/desktop/src/features/import/ImportWizard.tsx`
- Create: `apps/desktop/src/features/import/ImportWizard.test.tsx`
- Modify: `apps/desktop/src/features/import/api.ts` only for typed call-record helpers used by tests

**Interfaces:**
- `ImportWizard` props: `{ facade?: ImportFacade; onComplete?(results: ImportResult[]): void; onOpenLibrary?(): void }`.
- Default `facade` is `unavailableImportFacade` in production.
- The internal state transitions are `source → acquiring → candidates → analyzing → conflicts → committing → summary`, with `failed` and `cancelled` returning to the previous actionable state while preserving source input.

- [ ] **Step 1: Write the end-to-end wizard tests first**

```tsx
it("parses npx text without executing it and reaches candidate selection", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  render(<ImportWizard facade={facade} />);
  await user.type(screen.getByLabelText("来源"), "npx skills add github:owner/repo");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  expect(await screen.findByText("只解析来源，不执行 npx 命令")).toBeVisible();
  expect(facade.calls.executedCommands).toEqual([]);
});

it("suggests takeover for Agent-owned candidates and requires explicit selection", async () => {
  const user = userEvent.setup();
  render(<ImportWizard facade={createMockImportFacade({ scenario: "agent-owned-partial" })} />);
  await user.type(screen.getByLabelText("来源"), "C:\\Agents\\codex\\skills");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  expect(await screen.findByRole("radio", { name: "保留当前位置并纳入管理" })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "提交导入" })).toBeDisabled();
});

it("preserves source text after cancellation and reports partial results", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "cancelled" });
  render(<ImportWizard facade={facade} />);
  await user.type(screen.getByLabelText("来源"), "C:\\Skills\\pdf");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(screen.getByRole("button", { name: "取消获取" }));
  expect(screen.getByLabelText("来源")).toHaveValue("C:\\Skills\\pdf");
});
```

- [ ] **Step 2: Run the wizard tests and verify the expected failure**

Run: `pnpm --dir apps/desktop test --run src/features/import/ImportWizard.test.tsx`

Expected: FAIL because the wizard component does not exist.

- [ ] **Step 3: Implement the smallest reducer-driven orchestration**

Use `useReducer` with explicit events (`source_changed`, `parse_started`, `parse_succeeded`, `acquire_failed`, `candidates_selected`, `analysis_succeeded`, `action_selected`, `commit_succeeded`, `cancelled`, `retry`). Call the facade only in event handlers/effects associated with the current phase. Guard stale async responses with an operation token and use `AbortController` for acquisition. Keep selected IDs and actions in state; derive `canContinue` and `canCommit` instead of duplicating booleans.

Render a compact stepper, scrollable center panel and sticky action bar using existing classes/primitives. `aria-live="polite"` announces phase and error text. Production unavailability is shown at source/acquisition and disables commit; the wizard never imports Mock fixtures by default.

- [ ] **Step 4: Run all import tests and verify green**

Run: `pnpm --dir apps/desktop test --run src/features/import`

Expected: PASS for parser, selection, conflict gating, cancellation, retry, unavailable boundary and partial results.

- [ ] **Step 5: Commit the unified wizard**

```powershell
git add -- apps/desktop/src/features/import
git commit -m "feat: compose unified desktop import wizard"
```

### Task 5: Add discovery surfaces, routes and bilingual copy

**Files:**
- Create: `apps/desktop/src/features/discovery/DiscoveryPage.tsx`
- Create: `apps/desktop/src/features/discovery/LocalDiscovery.tsx`
- Create: `apps/desktop/src/features/discovery/OnlineDiscovery.tsx`
- Create: `apps/desktop/src/features/discovery/DiscoveryPage.test.tsx`
- Modify: `apps/desktop/src/app/router.tsx`
- Modify: `apps/desktop/src/app/AppShell.tsx` only if route-title resolution needs a separate import title
- Modify: `apps/desktop/src/i18n/en-US/common.json`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`

**Interfaces:**
- `DiscoveryPage` props: `{ importFacade?: ImportFacade }`.
- `LocalDiscovery` and `OnlineDiscovery` receive `{ onStartImport(): void }` and show only discovery facts/entry actions.
- `/discovery` renders `DiscoveryPage` with `unavailableImportFacade`; `DiscoveryPage` opens the wizard locally or at `/discovery/import` without constructing Mock data in production.

- [ ] **Step 1: Write failing route and discovery tests**

```tsx
it("shows local and online discovery entry points without runtime claims", () => {
  render(<DiscoveryPage />);
  expect(screen.getByRole("heading", { name: "本地发现" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "在线发现" })).toBeVisible();
  expect(screen.queryByText(/已授权|可用|验证通过/)).not.toBeInTheDocument();
});

it("keeps the production discovery route on the unavailable import boundary", async () => {
  renderRouter("/discovery");
  await userEvent.setup().click(screen.getByRole("button", { name: "导入 Skill" }));
  expect(await screen.findByText(/导入能力尚未连接|Import is not connected yet/)).toBeVisible();
  expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused discovery tests and observe failure**

Run: `pnpm --dir apps/desktop test --run src/features/discovery/DiscoveryPage.test.tsx`

Expected: FAIL because discovery modules and the real `/discovery` route do not exist.

- [ ] **Step 3: Implement discovery composition and route wiring**

Replace the current `/discovery` placeholder with `DiscoveryPage`. Keep local discovery focused on user-selected/local paths and online discovery labeled as an unavailable future boundary; both expose the same import entry. Add `/discovery/import` only if router state needs a direct deep link, and render `ImportWizard` with `unavailableImportFacade`. Extend route-title types/copy only where required.

Add matching i18n keys for navigation, steps, actions, phase labels, ownership facts, conflict actions, unavailable errors and result statuses. Run the existing locale key-set test after each JSON change.

- [ ] **Step 4: Run discovery/import and locale tests**

Run: `pnpm --dir apps/desktop test --run src/features/discovery src/features/import src/i18n/i18n.test.ts`

Expected: PASS with no Mock candidate visible through production routing.

- [ ] **Step 5: Commit discovery and route integration**

```powershell
git add -- apps/desktop/src/features/discovery apps/desktop/src/features/import apps/desktop/src/app/router.tsx apps/desktop/src/app/AppShell.tsx apps/desktop/src/i18n
git commit -m "feat: add discovery entry points and import routing"
```

### Task 6: Verify Task7 UI quality and prepare review

**Files:**
- Modify only files implicated by a failing verification command within Task7 scope.

- [ ] **Step 1: Run the complete frontend quality gates**

Run: `pnpm check:frontend; pnpm test:frontend; pnpm build:frontend; git diff --check`

Expected: all commands exit successfully; the build has no new errors and only the known large-chunk warning if it remains.

- [ ] **Step 2: Run the import-specific security boundary checks**

Run: `rg -n "\b(Command|Command::|git|npx|npm|pnpm)\b" apps/desktop/src/features/discovery apps/desktop/src/features/import`

Expected: no process, shell or package execution appears in the new feature code; only explanatory user-facing text may mention npx.

- [ ] **Step 3: Perform the finesse product UI pre-flight**

Inspect the development discovery route and wizard at desktop and narrow widths. Verify compact hierarchy, token-based surfaces, sticky action bar, independent scrolling, keyboard focus, `aria-live`, reduced-motion behavior, non-color status labels, long-path wrapping, unavailable production boundary and no “overwrite” wording. Verify npx text is visibly parsed-only and Agent ownership never becomes an authorization claim.

- [ ] **Step 4: Commit only verification corrections**

```powershell
git add -- apps/desktop/src/features/discovery apps/desktop/src/features/import apps/desktop/src/app apps/desktop/src/i18n
git commit -m "fix: harden discovery and import UI verification"
```

Skip this commit when verification produces no corrective changes.

- [ ] **Step 5: Report the branch for review**

Record the branch name, commits, focused and full test commands, build result, known limitations (production import unavailable until native contracts exist), and the exact files changed. Do not create or merge a PR unless the user explicitly requests that integration action.

