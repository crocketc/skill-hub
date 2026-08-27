# SkillHub Task4 Skill Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Plan07 Task4 high-density Skill library, saved views, explicit batch-selection scopes, and configurable quick drawer without inventing missing Rust contracts or fake production data.

**Architecture:** A typed, injectable `SkillLibraryFacade` isolates the React workspace from the currently incomplete Specta bindings. Pure query/selection helpers own URL and batch scope semantics; focused React components consume React Query results, while the production route injects an unavailable facade and a development-only preview injects deterministic fixtures.

**Tech Stack:** React 18, TypeScript 5.8 strict mode, React Router 7, TanStack Query 5, TanStack Table 8, Radix Dialog, i18next, Vitest, Testing Library, semantic HTML, and the existing SkillHub CSS token system.

**Spec:** `docs/superpowers/specs/2026-08-25-skillhub-task4-skill-library-design.md`

## Global Constraints

- Follow `AGENTS.md`, `docs/产品与交互设计.md`, and Plan07; do not expand Task4 into Rust catalog contracts, Task5 full details, Task7 import, or Task9 mutation workflows.
- Use TDD for every behavior: add the focused failing test, run it and observe the expected failure, implement the minimum behavior, rerun the focused test, then commit.
- Do not edit `apps/desktop/src/api/bindings.ts`; all future Rust contracts remain Specta-generated and drift-checked.
- The production `/library` route must use the `unavailableSkillLibraryFacade` instance and show a clear unavailable state; deterministic Skill fixtures are allowed only in tests and the development-only preview route.
- The Skill library defaults to compact 36–40px rows and 25 items per page; it offers 10, 25, 50, and 100 item page sizes without virtual scrolling.
- Theme changes alter complete color tokens only; all nine themes use the same component structure and geometry.
- The quick drawer defaults to the wide 620–720px preset, overlays rather than reflows the table, supports standard/wide/near-full presets and drag resizing, and remembers global preferences through the facade.
- Required drawer modules and the table selection/name columns cannot be hidden.
- Batch actions emit typed intent only; Task4 must not show deployment, security, export, archive, or deletion success.
- All visible copy is translated in both `en-US` and `zh-CN`, and `apps/desktop/src/i18n/i18n.test.ts` must continue to prove identical key sets.
- Preserve keyboard access, visible focus, reduced-motion behavior, list scroll, selection, URL query state, and focus restoration.
- React implementation follows `vercel-react-best-practices`: start independent queries in parallel, keep derived state out of effects, avoid inline component definitions, and do not add memoization without measured need.
- Each task ends with focused tests, `git diff --check`, and an independent commit.

---

## File Structure

### New production files

- `apps/desktop/src/features/skills/api.ts`: front-end domain models, facade contract, defaults, unavailable implementation, query keys, and error classification.
- `apps/desktop/src/features/skills/selection.ts`: explicit selection union and pure transition/intent helpers.
- `apps/desktop/src/features/skills/queryState.ts`: URL parsing/serialization, stable filter snapshots, and saved-view application.
- `apps/desktop/src/features/skills/SkillFilters.tsx`: search and combination filter controls.
- `apps/desktop/src/features/skills/SavedViews.tsx`: built-in/user saved views, overflow menu, save action, and dirty state.
- `apps/desktop/src/features/skills/SkillTable.tsx`: TanStack Table columns, sorting, pagination, density, keyboard row opening, and checkbox isolation.
- `apps/desktop/src/features/skills/drawerModules.ts`: required/optional drawer module registry and preference normalization/reordering.
- `apps/desktop/src/features/skills/SkillQuickDrawer.tsx`: detail query, fixed summary, configurable modules, presets, resize handling, and save-failure state.
- `apps/desktop/src/features/skills/SkillLibraryPage.tsx`: React Query orchestration, URL state, selection retention, data states, batch bar, drawer state, and scroll/focus preservation.
- `apps/desktop/src/features/skills/testFixtures.ts`: deterministic Mock Facade used by tests and the development preview only.
- `apps/desktop/src/features/skills/SkillLibraryPreview.tsx`: development-only visual QA entry.

### New tests

- `apps/desktop/src/features/skills/api.test.ts`: facade defaults and unavailable classification.
- `apps/desktop/src/features/skills/selection.test.ts`: selection transitions and batch target conversion.
- `apps/desktop/src/features/skills/queryState.test.ts`: URL and saved-view round trips.
- `apps/desktop/src/features/skills/SkillFilters.test.tsx`: accessible filters and saved views.
- `apps/desktop/src/features/skills/SkillTable.test.tsx`: columns, density, sorting, selection, and row interaction.
- `apps/desktop/src/features/skills/SkillQuickDrawer.test.tsx`: required modules, ordering, width, resizing, persistence failure, and focus behavior.
- `apps/desktop/src/features/skills/SkillLibraryPage.test.tsx`: loading/empty/error/unavailable, URL restoration, selection retention, batch intents, and drawer context.

### Existing files to modify

- `apps/desktop/package.json` and `pnpm-lock.yaml`: add `@tanstack/react-table` only.
- `apps/desktop/src/ui/Drawer.tsx` and `Drawer.test.tsx`: expose class/style/leading accessory hooks without embedding Skill-specific behavior.
- `apps/desktop/src/ui/DataState.tsx` and `DataState.test.tsx`: add a non-error `unavailable` state.
- `apps/desktop/src/app/router.tsx` and `router.test.tsx`: replace the library placeholder, reserve `/library/:skillId`, and add a development-only preview route.
- `apps/desktop/src/app/RoutePlaceholder.tsx`: accept an optional translated boundary description for the reserved Task5 route.
- `apps/desktop/src/i18n/en-US/common.json` and `zh-CN/common.json`: add identical `skillLibrary` keys.
- `apps/desktop/src/styles/base.css`: add Skill library/table/drawer styles using existing semantic tokens.

---

### Task 1: Establish the typed facade and selection model

**Files:**
- Create: `apps/desktop/src/features/skills/api.ts`
- Create: `apps/desktop/src/features/skills/api.test.ts`
- Create: `apps/desktop/src/features/skills/selection.ts`
- Create: `apps/desktop/src/features/skills/selection.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: existing `@tanstack/react-query`; no generated Rust binding.
- Produces: `SkillLibraryFacade`, `SkillLibraryQuery`, `SkillPage`, `SkillTableRow`, `SkillQuickView`, `SavedSkillView`, table/drawer preferences, selection helpers, and stable query keys used by all later tasks.

- [ ] **Step 1: Add the table dependency**

Run:

```powershell
pnpm --dir apps/desktop add @tanstack/react-table@^8.21.3
```

Expected: `apps/desktop/package.json` contains one new runtime dependency and `pnpm-lock.yaml` changes without unrelated upgrades.

- [ ] **Step 2: Write failing facade and selection tests**

Create `api.test.ts` with these assertions:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRAWER_PREFERENCES,
  DEFAULT_SKILL_QUERY,
  DEFAULT_TABLE_PREFERENCES,
  isSkillLibraryUnavailable,
  unavailableSkillLibraryFacade,
} from "./api";

describe("Skill library facade defaults", () => {
  it("defaults to compact rows, 25 items, and a wide drawer", () => {
    expect(DEFAULT_SKILL_QUERY.pageSize).toBe(25);
    expect(DEFAULT_TABLE_PREFERENCES.density).toBe("compact");
    expect(DEFAULT_DRAWER_PREFERENCES.preset).toBe("wide");
    expect(DEFAULT_DRAWER_PREFERENCES.widthPx).toBe(680);
  });

  it("classifies only the missing production contract as unavailable", async () => {
    const error = await unavailableSkillLibraryFacade
      .listSkills(DEFAULT_SKILL_QUERY)
      .catch((reason: unknown) => reason);
    expect(isSkillLibraryUnavailable(error)).toBe(true);
    expect(isSkillLibraryUnavailable(new Error("disk read failed"))).toBe(false);
  });
});
```

Create `selection.test.ts` with the three-state contract:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SKILL_QUERY } from "./api";
import {
  excludeFromAllFiltered,
  selectAllFiltered,
  selectExplicit,
  selectionToBatchTarget,
} from "./selection";

describe("Skill selection", () => {
  it("keeps explicit IDs across pages", () => {
    const first = selectExplicit({ kind: "none" }, ["a", "b"], true);
    const second = selectExplicit(first, ["c"], true);
    expect(second).toEqual({ kind: "explicit", skillIds: ["a", "b", "c"] });
  });

  it("represents all filtered results without materializing every ID", () => {
    const filter = {
      filters: DEFAULT_SKILL_QUERY.filters,
      text: DEFAULT_SKILL_QUERY.text,
    };
    const selected = selectAllFiltered(filter, "filter:v1", 80);
    const excluded = excludeFromAllFiltered(selected, "skill-17", true);
    expect(selectionToBatchTarget(excluded)).toEqual({
      kind: "filtered",
      filter,
      excludedSkillIds: ["skill-17"],
    });
  });
});
```

- [ ] **Step 3: Run the tests and verify the red state**

Run:

```powershell
pnpm --dir apps/desktop test --run src/features/skills/api.test.ts src/features/skills/selection.test.ts
```

Expected: FAIL because `api.ts` and `selection.ts` do not exist.

- [ ] **Step 4: Implement the exact front-end models and facade**

Define these public types in `api.ts`; keep enum-like values as string unions so future Specta adapters can map them explicitly:

```ts
export type SkillLifecycle = "active" | "trial" | "archived";
export type CheckState = "passed" | "warning" | "failed" | "not_run" | "unavailable";
export type SkillDensity = "compact" | "standard" | "comfortable";
export type DrawerPreset = "standard" | "wide" | "near_full";
export type SkillColumnId =
  | "select"
  | "name"
  | "purpose"
  | "tags"
  | "lifecycle"
  | "deployments"
  | "version"
  | "security"
  | "original_description"
  | "translated_description"
  | "source"
  | "ownership"
  | "license"
  | "invocation"
  | "requirements";

export interface SkillLibraryFilters {
  aiCheck: CheckState[];
  basicCheck: CheckState[];
  deployment: "any" | "deployed" | "not_deployed";
  lifecycle: SkillLifecycle[];
  tags: string[];
  version: "any" | "upgrade_available";
}

export interface SkillLibraryQuery {
  filters: SkillLibraryFilters;
  page: number;
  pageSize: 10 | 25 | 50 | 100;
  savedViewId?: string;
  sort: { column: SkillColumnId; direction: "asc" | "desc" };
  text: string;
}

export interface SkillTableRow {
  aiCheck: CheckState;
  agentDeploymentCount: number;
  alias?: string;
  basicCheck: CheckState;
  currentVersion: string;
  highRiskCount: number;
  id: string;
  invocation?: string;
  license?: string;
  lifecycle: SkillLifecycle;
  name: string;
  originalDescription?: string;
  ownership?: string;
  pendingCount: number;
  projectDeploymentCount: number;
  purpose: string;
  requirements: string[];
  source?: string;
  tags: string[];
  translatedDescription?: string;
  upgradeAvailable: boolean;
}

export interface SkillPage {
  facets: { tags: string[] };
  items: SkillTableRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface SkillQuickView extends SkillTableRow {
  dependencies: string[];
  duplicateCandidates: string[];
  externalChanges: string[];
  usageEvidence?: { invocationCount: number; lastUsedAt?: string };
}

export interface SkillTablePreferences {
  columnOrder: SkillColumnId[];
  density: SkillDensity;
  visibleColumns: SkillColumnId[];
}

export type DrawerModuleId =
  | "identity"
  | "primary_actions"
  | "risk_summary"
  | "full_details"
  | "relations"
  | "versions"
  | "source_license"
  | "security_checks"
  | "invocation_requirements"
  | "dependencies_duplicates"
  | "external_changes"
  | "usage_evidence";

export interface SkillDrawerPreferences {
  moduleOrder: DrawerModuleId[];
  preset: DrawerPreset;
  visibleModules: DrawerModuleId[];
  widthPx: number;
}

export interface SavedSkillView {
  builtIn: boolean;
  id: string;
  /** Translation key for built-in views; user-entered label for saved views. */
  name: string;
  query: Pick<SkillLibraryQuery, "filters" | "sort" | "text">;
  table: SkillTablePreferences;
}

export type BatchAction = "add_to" | "security_check" | "export" | "archive";
export type SkillFilterSnapshot = Pick<SkillLibraryQuery, "filters" | "text">;
export type BatchTarget =
  | { kind: "skill_ids"; skillIds: string[] }
  | { kind: "filtered"; filter: SkillFilterSnapshot; excludedSkillIds: string[] };
export interface SkillBatchIntent { action: BatchAction; target: BatchTarget }

export interface SkillLibraryFacade {
  emitBatchIntent(intent: SkillBatchIntent): Promise<void>;
  getSkillQuickView(skillId: string): Promise<SkillQuickView>;
  listSavedViews(): Promise<SavedSkillView[]>;
  listSkills(query: SkillLibraryQuery): Promise<SkillPage>;
  loadDrawerPreferences(): Promise<SkillDrawerPreferences>;
  loadTablePreferences(): Promise<SkillTablePreferences>;
  retainMatchingSkillIds(skillIds: string[], query: SkillLibraryQuery): Promise<string[]>;
  saveDrawerPreferences(preferences: SkillDrawerPreferences): Promise<void>;
  saveTablePreferences(preferences: SkillTablePreferences): Promise<void>;
  saveView(view: Omit<SavedSkillView, "builtIn" | "id">): Promise<SavedSkillView>;
}
```

Export frozen defaults with page `1`, page size `25`, compact density, required columns, wide drawer width `680`, and all module IDs in their default order. Export `BUILT_IN_SAVED_VIEWS` with `all`, `active`, `attention`, and `updates`; their `name` values are `skillLibrary.savedViews.builtIn.*` translation keys and their queries respectively use defaults, active lifecycle, warning/failed checks, and upgrade availability. Export `skillLibraryKeys` with `root`, `page(query)`, `savedViews`, `tablePreferences`, `drawerPreferences`, and `quickView(skillId)` factories. Implement `SkillLibraryUnavailableError`, `isSkillLibraryUnavailable`, and `unavailableSkillLibraryFacade`; only `listSkills` and `getSkillQuickView` throw the unavailable error, preference loaders return frozen defaults, reads of user saved views return `[]`, and mutation methods reject with the unavailable error.

- [ ] **Step 5: Implement pure selection transitions**

Use sorted arrays rather than mutable `Set` values so state, tests, and intent payloads remain deterministic:

```ts
import type { BatchTarget, SkillFilterSnapshot } from "./api";

export type SkillSelection =
  | { kind: "none" }
  | { kind: "explicit"; skillIds: string[] }
  | {
      kind: "all_filtered";
      excludedSkillIds: string[];
      filter: SkillFilterSnapshot;
      filterKey: string;
      total: number;
    };

export function selectExplicit(
  state: SkillSelection,
  skillIds: string[],
  selected: boolean,
): SkillSelection;

export function selectAllFiltered(
  filter: SkillFilterSnapshot,
  filterKey: string,
  total: number,
): Extract<SkillSelection, { kind: "all_filtered" }>;
export function excludeFromAllFiltered(
  state: Extract<SkillSelection, { kind: "all_filtered" }>,
  skillId: string,
  excluded: boolean,
): Extract<SkillSelection, { kind: "all_filtered" }>;
export function retainExplicitSelection(state: SkillSelection, matchingIds: string[]): SkillSelection;
export function selectionCount(state: SkillSelection): number;
export function selectionToBatchTarget(state: Exclude<SkillSelection, { kind: "none" }>): BatchTarget;
```

All helpers deduplicate and lexically sort IDs. `selectAllFiltered` clones the text/filter snapshot rather than retaining mutable arrays. Removing the last explicit ID returns `{ kind: "none" }`; `selectionCount(all_filtered)` returns `total - excludedSkillIds.length`; `selectionToBatchTarget` forwards the structured filter snapshot and exclusions but not the UI-only comparison key.

- [ ] **Step 6: Run focused verification and commit**

Run:

```powershell
pnpm --dir apps/desktop test --run src/features/skills/api.test.ts src/features/skills/selection.test.ts
pnpm --dir apps/desktop typecheck
git diff --check
git add -- apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/features/skills/api.ts apps/desktop/src/features/skills/api.test.ts apps/desktop/src/features/skills/selection.ts apps/desktop/src/features/skills/selection.test.ts
git commit -m "feat: define Skill library frontend contracts"
```

Expected: both test files PASS, typecheck exits `0`, diff check is clean, and the commit contains no generated binding edit.

---

### Task 2: Add URL query state, filters, and saved views

**Files:**
- Create: `apps/desktop/src/features/skills/queryState.ts`
- Create: `apps/desktop/src/features/skills/queryState.test.ts`
- Create: `apps/desktop/src/features/skills/SkillFilters.tsx`
- Create: `apps/desktop/src/features/skills/SavedViews.tsx`
- Create: `apps/desktop/src/features/skills/SkillFilters.test.tsx`
- Modify: `apps/desktop/src/i18n/en-US/common.json`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`

**Interfaces:**
- Consumes: `SkillLibraryQuery`, `SavedSkillView`, `SkillTablePreferences`, and defaults from Task 1.
- Produces: `parseSkillLibrarySearchParams`, `serializeSkillLibrarySearchParams`, `skillFilterKey`, `applySavedView`, `SkillFilters`, and `SavedViews` for Task 5.

- [ ] **Step 1: Write failing URL round-trip tests**

Create `queryState.test.ts`:

```ts
import { expect, it } from "vitest";
import {
  DEFAULT_SKILL_QUERY,
  DEFAULT_TABLE_PREFERENCES,
  type SkillLibraryQuery,
} from "./api";
import {
  applySavedView,
  parseSkillLibrarySearchParams,
  serializeSkillLibrarySearchParams,
  skillFilterKey,
} from "./queryState";

it("round-trips query and drawer state while normalizing unordered filters", () => {
  const query: SkillLibraryQuery = {
    ...DEFAULT_SKILL_QUERY,
    filters: {
      ...DEFAULT_SKILL_QUERY.filters,
      lifecycle: ["trial", "active"],
      tags: ["pdf", "docs"],
    },
    page: 3,
    text: "reader",
  };
  const params = serializeSkillLibrarySearchParams(query, "skill-pdf");
  expect(parseSkillLibrarySearchParams(params)).toEqual({
    query: {
      ...query,
      filters: { ...query.filters, lifecycle: ["active", "trial"], tags: ["docs", "pdf"] },
    },
    skillId: "skill-pdf",
  });
  expect(skillFilterKey(query)).toBe(skillFilterKey(parseSkillLibrarySearchParams(params).query));
});

it("applies a saved view without copying page or selection", () => {
  const result = applySavedView(DEFAULT_SKILL_QUERY, {
    builtIn: false,
    id: "view-risk",
    name: "Risk review",
    query: {
      filters: { ...DEFAULT_SKILL_QUERY.filters, basicCheck: ["failed"] },
      sort: { column: "security", direction: "desc" },
      text: "",
    },
    table: DEFAULT_TABLE_PREFERENCES,
  });
  expect(result.query.page).toBe(1);
  expect(result.query.savedViewId).toBe("view-risk");
  expect(result.table.density).toBe("compact");
});
```

- [ ] **Step 2: Write failing accessible component tests**

Create `SkillFilters.test.tsx` with an i18n provider and these behaviors:

```tsx
it("emits a page-reset query when search or filters change", () => {
  const onChange = vi.fn();
  renderSkillFilters({ onChange, query: { ...DEFAULT_SKILL_QUERY, page: 4 } });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
    target: { value: "pdf" },
  });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 1, text: "pdf", savedViewId: undefined }),
  );
});

it("applies a saved view and exposes dirty state without saving page or selection", () => {
  const onApply = vi.fn();
  renderSavedViews({ activeViewId: "view-risk", dirty: true, onApply });
  expect(screen.getByText("Unsaved changes")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Risk review" }));
  expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: "view-risk" }));
});
```

The render helpers are local functions in the test file and use `createSkillHubI18n(["en-US"])`; do not add a shared test abstraction for two components.

- [ ] **Step 3: Run the tests and verify the red state**

Run:

```powershell
pnpm --dir apps/desktop test --run src/features/skills/queryState.test.ts src/features/skills/SkillFilters.test.tsx
```

Expected: FAIL because the query and component modules do not exist.

- [ ] **Step 4: Implement deterministic URL parsing and saved-view application**

Use these URL keys and omit default values to keep links readable:

```ts
const PARAMS = {
  aiCheck: "ai",
  basicCheck: "basic",
  deployment: "deployment",
  lifecycle: "lifecycle",
  page: "page",
  pageSize: "size",
  savedViewId: "view",
  skillId: "skill",
  sort: "sort",
  tags: "tag",
  text: "q",
  version: "version",
} as const;
```

`parseSkillLibrarySearchParams` must reject unknown union values, clamp invalid pages to `1`, accept only page sizes `10 | 25 | 50 | 100`, sort/deduplicate multi-value filters, and return `{ query, skillId }`. `serializeSkillLibrarySearchParams` must use repeated parameters for tags and state arrays. `skillFilterKey` must serialize only `text` and `filters`, excluding page, page size, saved view, and sort. `applySavedView` must return `{ query, table }`, reset page to `1`, and set `savedViewId`.

- [ ] **Step 5: Implement controlled filter and saved-view components**

Use these props so Task 5 owns persistence and URL mutation:

```ts
export interface SkillFiltersProps {
  availableTags: string[];
  onChange: (query: SkillLibraryQuery) => void;
  onClear: () => void;
  query: SkillLibraryQuery;
  resultCount: number;
}

export interface SavedViewsProps {
  activeViewId?: string;
  dirty: boolean;
  onApply: (view: SavedSkillView) => void;
  onSave: () => void;
  views: SavedSkillView[];
}
```

Render native labelled inputs/selects and fieldsets. Resolve a built-in view label with `t(view.name)` and render a user view's `name` verbatim. Keep built-in plus the first four user views on one line; place remaining user views in a labelled `<details>` menu. Search and every filter change reset page to `1` and clear `savedViewId`; `onClear` restores default text/filters while preserving page size. The save action only calls `onSave`; it does not synthesize an ID or success message.

- [ ] **Step 6: Add the exact translation subtree**

Add matching `skillLibrary.filters` and `skillLibrary.savedViews` keys. English values:

```json
{
  "filters": {
    "aiCheck": "AI check",
    "basicCheck": "Basic check",
    "clear": "Clear filters",
    "deployment": "Deployment",
    "lifecycle": "Lifecycle",
    "resultCount": "{{count}} results",
    "search": "Search skills",
    "tags": "Tags",
    "version": "Version"
  },
  "savedViews": {
    "builtIn": {
      "active": "Active",
      "all": "All skills",
      "attention": "Needs attention",
      "updates": "Updates"
    },
    "more": "More views",
    "save": "Save current view",
    "unsaved": "Unsaved changes"
  }
}
```

Chinese values:

```json
{
  "filters": {
    "aiCheck": "AI 检查",
    "basicCheck": "基础检查",
    "clear": "清除筛选",
    "deployment": "部署状态",
    "lifecycle": "生命周期",
    "resultCount": "{{count}} 个结果",
    "search": "搜索 Skill",
    "tags": "标签",
    "version": "版本"
  },
  "savedViews": {
    "builtIn": {
      "active": "活跃",
      "all": "全部 Skill",
      "attention": "需要处理",
      "updates": "可更新"
    },
    "more": "更多视图",
    "save": "保存当前视图",
    "unsaved": "未保存更改"
  }
}
```

- [ ] **Step 7: Run focused verification and commit**

Run:

```powershell
pnpm --dir apps/desktop test --run src/features/skills/queryState.test.ts src/features/skills/SkillFilters.test.tsx src/i18n/i18n.test.ts
pnpm --dir apps/desktop typecheck
git diff --check
git add -- apps/desktop/src/features/skills/queryState.ts apps/desktop/src/features/skills/queryState.test.ts apps/desktop/src/features/skills/SkillFilters.tsx apps/desktop/src/features/skills/SavedViews.tsx apps/desktop/src/features/skills/SkillFilters.test.tsx apps/desktop/src/i18n/en-US/common.json apps/desktop/src/i18n/zh-CN/common.json
git commit -m "feat: add Skill library query controls"
```

Expected: focused tests and locale parity PASS; no URL key stores selection.

---

### Task 3: Build the compact TanStack Table workspace

**Files:**
- Create: `apps/desktop/src/features/skills/SkillTable.tsx`
- Create: `apps/desktop/src/features/skills/SkillTable.test.tsx`
- Modify: `apps/desktop/src/i18n/en-US/common.json`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`
- Modify: `apps/desktop/src/styles/base.css`

**Interfaces:**
- Consumes: page rows, query, table preferences, and `SkillSelection` from Tasks 1–2.
- Produces: controlled table events for query changes, selection changes, preference changes, and row opening; no data fetching.

- [ ] **Step 1: Write failing table behavior tests**

Create fixtures for two rows inside `SkillTable.test.tsx` and assert these behaviors:

```tsx
it("uses compact density and keeps checkbox clicks separate from row opening", () => {
  const onOpenSkill = vi.fn();
  const onSelectionChange = vi.fn();
  renderTable({ onOpenSkill, onSelectionChange });
  expect(screen.getByRole("table")).toHaveAttribute("data-density", "compact");
  fireEvent.click(screen.getByRole("checkbox", { name: "Select PDF Reader" }));
  expect(onSelectionChange).toHaveBeenCalled();
  expect(onOpenSkill).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("cell", { name: /PDF Reader/ }));
  expect(onOpenSkill).toHaveBeenCalledWith("skill-pdf", expect.any(HTMLElement));
});

it("opens a focused row with Enter and emits manual sort and pagination", () => {
  const onOpenSkill = vi.fn();
  const onQueryChange = vi.fn();
  renderTable({ onOpenSkill, onQueryChange });
  fireEvent.keyDown(screen.getByRole("row", { name: /PDF Reader/ }), { key: "Enter" });
  expect(onOpenSkill).toHaveBeenCalledWith("skill-pdf", expect.any(HTMLElement));
  fireEvent.click(screen.getByRole("button", { name: "Sort by name" }));
  expect(onQueryChange).toHaveBeenCalledWith(
    expect.objectContaining({ page: 1, sort: { column: "name", direction: "asc" } }),
  );
});

it("does not allow the select or name columns to be hidden", () => {
  const onPreferencesChange = vi.fn();
  renderTable({ onPreferencesChange });
  fireEvent.click(screen.getByRole("button", { name: "Columns and density" }));
  expect(screen.getByRole("checkbox", { name: "Selection" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "Name" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Move version before deployments" }));
  const next = onPreferencesChange.mock.calls.at(-1)![0];
  expect(next.columnOrder.indexOf("version")).toBeLessThan(
    next.columnOrder.indexOf("deployments"),
  );
});
```

Also test page sizes `10`, `25`, `50`, `100`, the current range text, separate basic/AI security labels, and `aria-sort`.

- [ ] **Step 2: Run the table test and verify the red state**

Run:

```powershell
pnpm --dir apps/desktop test --run src/features/skills/SkillTable.test.tsx
```

Expected: FAIL because `SkillTable.tsx` does not exist.

- [ ] **Step 3: Implement the controlled table API**

Export this props contract:

```ts
export interface SkillTableProps {
  onOpenSkill: (skillId: string, rowElement: HTMLElement) => void;
  onPreferencesChange: (preferences: SkillTablePreferences) => void;
  onQueryChange: (query: SkillLibraryQuery) => void;
  onSelectionChange: (selection: SkillSelection) => void;
  page: SkillPage;
  preferences: SkillTablePreferences;
  query: SkillLibraryQuery;
  selection: SkillSelection;
}
```

Build column definitions outside the component in a `createSkillColumns(t)` function. Use `useReactTable` with `manualPagination: true`, `manualSorting: true`, `pageCount: Math.ceil(total / pageSize)`, `getCoreRowModel()`, and row IDs from `row.original.id`. Render a semantic `<table>`, `<thead>`, `<tbody>`, and `<th aria-sort>` inside a `role="region"`, `tabIndex={-1}` container labelled by `skillLibrary.table.resultsRegion`. Do not enable TanStack client filtering or pagination.

The name cell contains name, alias, and purpose without creating a nested row-opening button. Optional metadata columns read the row's original/translated descriptions, source, ownership, license, invocation, and requirements fields. The deployments cell reports Agent and project counts separately. The security cell contains two labelled status summaries plus pending/high-risk counts; `not_run` and `unavailable` use neutral/info tones rather than danger.

The row has `tabIndex={0}` and opens on click or Enter. Every interactive descendant stops click propagation. Store the concrete row element in the callback so Task 5 can restore focus.

- [ ] **Step 4: Implement selection, columns, density, and pagination controls**

The header checkbox selects only the current page through `selectExplicit`; when selection is `all_filtered`, row checkboxes toggle exclusion with `excludeFromAllFiltered`. Column controls enforce:

```ts
const LOCKED_COLUMNS: SkillColumnId[] = ["select", "name"];
const PAGE_SIZES = [10, 25, 50, 100] as const;
```

Visible column changes preserve column order and call `onPreferencesChange`; accessible move-before controls reorder optional columns while locked columns remain present. Density changes set `compact | standard | comfortable`. Pagination displays `start–end` and total, uses disabled previous/next buttons at boundaries, and resets page to `1` when page size changes.

- [ ] **Step 5: Add table translations and compact styles**

Add matching locale keys for all column names, density labels, sorting, selection, page size, pagination, check states, lifecycle values, version update, and deployment counts. The required English accessible names are `Select current page`, `Select {{name}}`, `Sort by {{column}}`, and `Columns and density`; Chinese equivalents are `选择当前页面`, `选择 {{name}}`, `按{{column}}排序`, and `列与密度`.

Append a `.sh-skill-table` block to `base.css` with these density variables:

```css
.sh-skill-table[data-density="compact"] { --skill-row-height: 2.375rem; }
.sh-skill-table[data-density="standard"] { --skill-row-height: 2.75rem; }
.sh-skill-table[data-density="comfortable"] { --skill-row-height: 3.25rem; }

.sh-skill-table tbody tr { min-height: var(--skill-row-height); }
.sh-skill-table th,
.sh-skill-table td { height: var(--skill-row-height); }
```

Use a single bordered surface, sticky header, horizontal overflow, tabular numerals for counts, truncated secondary text with a title/accessible name, and focus-visible outline on rows. Do not add card styling per row.

- [ ] **Step 6: Run focused verification and commit**

Run:

```powershell
pnpm --dir apps/desktop test --run src/features/skills/SkillTable.test.tsx src/i18n/i18n.test.ts
pnpm --dir apps/desktop typecheck
git diff --check
git add -- apps/desktop/src/features/skills/SkillTable.tsx apps/desktop/src/features/skills/SkillTable.test.tsx apps/desktop/src/i18n/en-US/common.json apps/desktop/src/i18n/zh-CN/common.json apps/desktop/src/styles/base.css
git commit -m "feat: add compact Skill library table"
```

Expected: table tests PASS at compact default; checkbox tests never invoke row opening.

---

### Task 4: Build the configurable wide quick drawer

**Files:**
- Create: `apps/desktop/src/features/skills/drawerModules.ts`
- Create: `apps/desktop/src/features/skills/SkillQuickDrawer.tsx`
- Create: `apps/desktop/src/features/skills/SkillQuickDrawer.test.tsx`
- Modify: `apps/desktop/src/ui/Drawer.tsx`
- Modify: `apps/desktop/src/ui/Drawer.test.tsx`
- Modify: `apps/desktop/src/i18n/en-US/common.json`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`
- Modify: `apps/desktop/src/styles/base.css`

**Interfaces:**
- Consumes: `SkillLibraryFacade`, quick-view query key, drawer preference types, and existing Radix `Drawer`.
- Produces: `SkillQuickDrawer`, normalized module preferences, preset/resize helpers, and a generic Drawer panel-extension seam.

- [ ] **Step 1: Write the failing generic Drawer extension test**

Add to `Drawer.test.tsx`:

```tsx
it("applies a caller-owned panel class, style, and leading accessory", () => {
  mockReducedMotion(false);
  render(
    <I18nextProvider i18n={skillHubI18n}>
      <Drawer
        leadingAccessory={<span data-testid="resize-handle" />}
        onOpenChange={() => undefined}
        open
        panelClassName="custom-drawer"
        panelStyle={{ width: "42rem" }}
        returnFocusRef={{ current: null }}
        title="Details"
      >
        Content
      </Drawer>
    </I18nextProvider>,
  );
  expect(screen.getByTestId("drawer-panel")).toHaveClass("custom-drawer");
  expect(screen.getByTestId("drawer-panel")).toHaveStyle({ width: "42rem" });
  expect(screen.getByTestId("resize-handle")).toBeVisible();
});
```

- [ ] **Step 2: Write failing drawer preference and interaction tests**

Use a fresh QueryClient, memory router, i18n provider, and Mock Facade per test. Cover:

```tsx
it("keeps required modules visible while reordering optional modules", async () => {
  const facade = createMockSkillLibraryFacade();
  renderDrawer({ facade });
  fireEvent.click(await screen.findByRole("button", { name: "Configure quick drawer" }));
  expect(screen.getByRole("checkbox", { name: "Identity" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "Risk summary" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Move versions before relations" }));
  await waitFor(() => {
    const order = facade.calls.saveDrawerPreferences.at(-1)!.moduleOrder;
    expect(order.indexOf("versions")).toBeLessThan(order.indexOf("relations"));
  });
});

it("starts wide, changes presets, and persists a clamped drag width", async () => {
  const facade = createMockSkillLibraryFacade();
  renderDrawer({ facade, viewportWidth: 1200 });
  expect(await screen.findByTestId("skill-quick-drawer")).toHaveStyle(
    "--skill-drawer-width: 680px",
  );
  fireEvent.click(screen.getByRole("button", { name: "Near full screen" }));
  fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize quick drawer" }), {
    clientX: 500,
    pointerId: 1,
  });
  fireEvent.pointerMove(window, { clientX: 420, pointerId: 1 });
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(facade.calls.saveDrawerPreferences.at(-1)?.widthPx).toBeGreaterThanOrEqual(420);
});

it("keeps temporary preferences visible when persistence fails", async () => {
  const facade = createMockSkillLibraryFacade({ failDrawerSave: true });
  renderDrawer({ facade });
  fireEvent.click(await screen.findByRole("button", { name: "Standard width" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Preference was not saved");
  expect(screen.getByTestId("skill-quick-drawer")).toHaveAttribute("data-preset", "standard");
});
```

Also assert detail loading/error states, reset-to-default, independent body scrolling, full detail link `/library/skill-pdf`, and reduced-motion data inherited from `Drawer`.

- [ ] **Step 3: Run the drawer tests and verify the red state**

Run:

```powershell
pnpm --dir apps/desktop test --run src/ui/Drawer.test.tsx src/features/skills/SkillQuickDrawer.test.tsx
```

Expected: the new generic Drawer test fails on missing props and the Skill drawer module is missing.

- [ ] **Step 4: Add narrow generic extension props to Drawer**

Extend `DrawerBaseProps` without moving domain behavior into `ui/Drawer.tsx`:

```ts
interface DrawerBaseProps {
  children: ReactNode;
  closeLabel?: string;
  description?: string;
  leadingAccessory?: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  panelClassName?: string;
  panelStyle?: CSSProperties;
  title: string;
}
```

Merge `panelClassName` with `sh-drawer`, apply `panelStyle` to `Dialog.Content`, and render `leadingAccessory` before the header. Preserve existing overlay, focus-return, reduced-motion, and close behavior unchanged.

- [ ] **Step 5: Implement module normalization and width helpers**

In `drawerModules.ts`, export:

```ts
export const REQUIRED_DRAWER_MODULES = [
  "identity",
  "primary_actions",
  "risk_summary",
  "full_details",
] as const;

export const OPTIONAL_DRAWER_MODULES = [
  "relations",
  "versions",
  "source_license",
  "security_checks",
  "invocation_requirements",
  "dependencies_duplicates",
  "external_changes",
  "usage_evidence",
] as const;

export function normalizeDrawerPreferences(
  preferences: SkillDrawerPreferences,
): SkillDrawerPreferences;
export function reorderDrawerModule(
  order: DrawerModuleId[],
  moved: DrawerModuleId,
  before: DrawerModuleId,
): DrawerModuleId[];
export function drawerWidthForPreset(preset: DrawerPreset, viewportWidth: number): number;
export function clampDrawerWidth(widthPx: number, viewportWidth: number): number;
```

Normalization always restores missing required modules, removes unknown/duplicate entries, and never permits a required module to leave `visibleModules`. Preset widths are `480`, `680`, and `viewportWidth - 48`; clamp to `min 420` and `max viewportWidth - 32`.

- [ ] **Step 6: Implement the drawer with optimistic local preferences**

Export this component contract:

```ts
export interface SkillQuickDrawerProps {
  facade: SkillLibraryFacade;
  onOpenChange: (open: boolean) => void;
  onPreferencesChange: (preferences: SkillDrawerPreferences) => void;
  open: boolean;
  preferences: SkillDrawerPreferences;
  returnFocusRef: RefObject<HTMLElement | null>;
  skillId?: string;
}
```

Fetch details only when `open && skillId` through `useQuery({ queryKey: skillLibraryKeys.quickView(skillId), queryFn, enabled })`. Render fixed identity/actions/risk/full-detail regions and optional modules from a top-level module renderer map. Render `usage_evidence` only when `usageEvidence` exists; absence means no reliable evidence and must not produce a zero-use claim. Primary actions only call `facade.emitBatchIntent` for a single ID and never show a success toast.

Treat `preferences` as controlled state. Preset, visibility, reorder, reset, and completed pointer-resize updates first call `onPreferencesChange(next)` and then call `saveDrawerPreferences(next)`. A rejection shows the translated persistence alert while the parent-owned temporary layout remains visible. The resize handle uses `role="separator"`, `aria-orientation="vertical"`, pointer capture where available, window pointer listeners during the drag, and cleanup on pointer up/unmount. Persist once on pointer up, not for every move.

- [ ] **Step 7: Add drawer translations and overlay geometry**

Add matching locale keys for configure, presets, resize, reset, module names, move-before labels, module empty values, detail states, preference failure, and full details. Add CSS:

```css
.sh-skill-drawer {
  width: min(var(--skill-drawer-width, 42.5rem), calc(100vw - 2rem));
}

.sh-skill-drawer__resize {
  position: absolute;
  z-index: 1;
  top: 0;
  bottom: 0;
  left: -0.25rem;
  width: 0.5rem;
  cursor: ew-resize;
}

.sh-skill-drawer__modules {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

@media (max-width: 48rem) {
  .sh-skill-drawer__modules { grid-template-columns: 1fr; }
}
```

The header, primary actions, risk summary, and full-details entry remain sticky inside the drawer layout; the modules region scrolls independently. The overlay continues to use the existing theme overlay token and does not alter `.sh-app-shell__content` width.

- [ ] **Step 8: Run focused verification and commit**

Run:

```powershell
pnpm --dir apps/desktop test --run src/ui/Drawer.test.tsx src/features/skills/SkillQuickDrawer.test.tsx src/i18n/i18n.test.ts
pnpm --dir apps/desktop typecheck
git diff --check
git add -- apps/desktop/src/ui/Drawer.tsx apps/desktop/src/ui/Drawer.test.tsx apps/desktop/src/features/skills/drawerModules.ts apps/desktop/src/features/skills/SkillQuickDrawer.tsx apps/desktop/src/features/skills/SkillQuickDrawer.test.tsx apps/desktop/src/i18n/en-US/common.json apps/desktop/src/i18n/zh-CN/common.json apps/desktop/src/styles/base.css
git commit -m "feat: add configurable Skill quick drawer"
```

Expected: generic Drawer regressions and all Skill drawer tests PASS; required module controls remain disabled.

---

### Task 5: Compose page queries, selection scopes, and truthful states

**Files:**
- Create: `apps/desktop/src/features/skills/testFixtures.ts`
- Create: `apps/desktop/src/features/skills/SkillLibraryPage.tsx`
- Create: `apps/desktop/src/features/skills/SkillLibraryPage.test.tsx`
- Modify: `apps/desktop/src/ui/DataState.tsx`
- Modify: `apps/desktop/src/ui/DataState.test.tsx`
- Modify: `apps/desktop/src/i18n/en-US/common.json`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`
- Modify: `apps/desktop/src/styles/base.css`

**Interfaces:**
- Consumes: facade, query helpers, filters, saved views, table, drawer, and selection helpers from Tasks 1–4.
- Produces: the complete injected `SkillLibraryPage` and deterministic Mock Facade for route and visual integration in Task 6.

- [ ] **Step 1: Write the failing unavailable DataState test**

Add to `DataState.test.tsx`:

```tsx
it("announces unavailable data without treating it as an application error", () => {
  render(<DataState message="Catalog contract is unavailable" state="unavailable" />);
  expect(screen.getByRole("status")).toHaveTextContent("Catalog contract is unavailable");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Write failing page-state and selection tests**

Use `createMemoryRouter` with initial entries and a fresh QueryClient. The deterministic facade records calls and can return loading gates, empty pages, ordinary errors, preference failures, and matching-ID responses. Cover:

```tsx
it("distinguishes current-page selection from all filtered results", async () => {
  const facade = createMockSkillLibraryFacade({ total: 80 });
  renderLibrary({ facade });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select current page" }));
  expect(screen.getByText("25 items selected on this page")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Select all 80 filtered results" }));
  expect(screen.getByText("All 80 filtered results selected")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Run security check" }));
  expect(facade.calls.emitBatchIntent).toContainEqual({
    action: "security_check",
    target: {
      kind: "filtered",
      excludedSkillIds: [],
      filter: expect.objectContaining({ text: "" }),
    },
  });
  expect(screen.queryByText("Security check completed")).not.toBeInTheDocument();
});

it("restores query and drawer state from the URL and preserves scroll and focus", async () => {
  const facade = createMockSkillLibraryFacade();
  const view = renderLibrary({
    facade,
    initialEntry: "/library?q=pdf&page=2&size=25&skill=skill-pdf",
  });
  expect(await screen.findByRole("searchbox", { name: "Search skills" })).toHaveValue("pdf");
  expect(await screen.findByRole("dialog", { name: "PDF Reader" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(view.router.state.location.search).not.toContain("skill=");
  expect(screen.getByRole("region", { name: "Skill results" })).toHaveFocus();
  fireEvent.click(screen.getByRole("cell", { name: /PDF Reader/ }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("row", { name: /PDF Reader/ })).toHaveFocus();
});

it("clears all-filtered selection when filters change and validates explicit IDs", async () => {
  const facade = createMockSkillLibraryFacade({ matchingSkillIds: ["skill-pdf"] });
  renderLibrary({ facade });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select current page" }));
  fireEvent.click(screen.getByRole("button", { name: /Select all/ }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
    target: { value: "reader" },
  });
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Selection cleared because filters changed",
  );
});
```

Add separate tests for first loading, empty library, no filtered result, ordinary query error with retry, facade unavailable, preference save failure, saved-view application, explicit selection retention through `retainMatchingSkillIds`, and drawer switching without resetting query/page/selection.

- [ ] **Step 3: Run the page tests and verify the red state**

Run:

```powershell
pnpm --dir apps/desktop test --run src/ui/DataState.test.tsx src/features/skills/SkillLibraryPage.test.tsx
```

Expected: DataState rejects `unavailable` and the page/mock modules are missing.

- [ ] **Step 4: Add the unavailable DataState variant**

Change the state union to:

```ts
state: "loading" | "empty" | "error" | "unavailable";
```

Only `error` uses `role="alert"` and assertive live behavior. Loading, empty, and unavailable use `role="status"` and polite announcements.

- [ ] **Step 5: Implement deterministic fixtures and call recording**

Export:

```ts
export interface MockSkillLibraryOptions {
  failDrawerSave?: boolean;
  failPage?: Error;
  matchingSkillIds?: string[];
  pageItems?: SkillTableRow[];
  total?: number;
}

export interface MockSkillLibraryFacade extends SkillLibraryFacade {
  calls: {
    emitBatchIntent: SkillBatchIntent[];
    listSkills: SkillLibraryQuery[];
    saveDrawerPreferences: SkillDrawerPreferences[];
    saveTablePreferences: SkillTablePreferences[];
    saveView: Array<Omit<SavedSkillView, "builtIn" | "id">>;
  };
}

export function createMockSkillLibraryFacade(
  options?: MockSkillLibraryOptions,
): MockSkillLibraryFacade;
```

Use named fixtures `skill-pdf`, `skill-docx`, and `skill-browser`; do not call the real bindings. Clone return values so tests cannot mutate shared defaults. Keep this module out of imports used by the production `/library` route.

- [ ] **Step 6: Implement page orchestration with parallel queries**

Export:

```ts
export interface SkillLibraryPageProps {
  facade: SkillLibraryFacade;
}

export function SkillLibraryPage({ facade }: SkillLibraryPageProps): JSX.Element;
```

Use `useSearchParams` for query and `skill` drawer ID. Start page, user saved views, table preferences, and drawer preferences in the same render with four independent `useQuery` calls. Prepend `BUILT_IN_SAVED_VIEWS` to the user views in render and deduplicate by ID. Pass `page.facets.tags` to `SkillFilters`; do not infer the available tag set from only visible rows. Never put page rows or saved-view query results into duplicate state. Use local state only for `SkillSelection`, temporary table/drawer preferences, the last row focus target, scroll position, preference status, and the batch announcement.

Table and drawer preference handlers update temporary controlled state immediately and call the matching facade save method. A rejection keeps the temporary state, sets the translated not-persisted status, and offers retry or restore-default; a successful retry invalidates the relevant preference query.

Selecting all filtered results calls `selectAllFiltered({ text: query.text, filters: query.filters }, skillFilterKey(query), page.total)` so the eventual batch target contains a structured snapshot rather than only visible IDs.

When filters change:

- reset page through the controlled query;
- clear `all_filtered` and announce the reason;
- call `retainMatchingSkillIds` for an explicit selection and replace it with the returned IDs;
- ignore stale retention results by comparing the current `skillFilterKey` before applying them.

Opening a row records the table scroll container position and row element, then writes `skill=<id>` to the existing query string. Closing removes only `skill`; switching rows changes only `skill`. Pass the recorded row ref to `SkillQuickDrawer`; if the drawer was restored directly from a URL or the invoking row no longer exists after data refresh, focus the `tabIndex={-1}` table region labelled by `skillLibrary.table.resultsRegion`.

The floating batch bar renders only for non-empty selection, states the exact scope, offers typed `add_to`, `security_check`, `export`, and `archive` intent buttons, and provides clear selection. Calling an action awaits `emitBatchIntent`; success does not render completion copy, while an unavailable rejection explains that the workflow is not connected.

- [ ] **Step 7: Render truthful page states**

State order must be deterministic:

1. Page query pending: compact skeleton rows with fixed final geometry.
2. `SkillLibraryUnavailableError`: unavailable DataState explaining the missing catalog contract.
3. Ordinary page error: error DataState with `refetch` retry.
4. `total === 0` and no active filters/text: empty library state with a non-functional boundary message for the later import flow.
5. `items.length === 0` with active filters/text: no-results state with clear-filter action.
6. Data: saved views, filters, table, selection bar, and drawer.

Saved-view and preference query errors do not replace valid table data. Show an inline status and use defaults; allow retry. Saving a view opens a native labelled name form, sends only `query: { filters, sort, text }` and current table preferences, invalidates saved-view queries on success, and shows an error without inventing an ID on failure.

- [ ] **Step 8: Add page translations and balanced workspace styling**

Add matching locale keys for page count/status, loading rows, empty/no-results/unavailable/error, retry, save-view form, selection scopes, selection-cleared announcement, batch actions, and unconnected workflow. Required English strings in tests are `25 items selected on this page`, `Select all {{count}} filtered results`, `All {{count}} filtered results selected`, and `Selection cleared because filters changed`; provide natural Chinese counterparts.

Add `.sh-skill-library` styles for one-line saved views, second-row query tools, full-width table, and fixed bottom batch bar. Use the A balanced layout, existing surface/border tokens, `gap: var(--space-3)`, and no decorative hero. Reserve bottom padding while the batch bar is present so it never covers the last table row.

- [ ] **Step 9: Run focused verification and commit**

Run:

```powershell
pnpm --dir apps/desktop test --run src/ui/DataState.test.tsx src/features/skills/SkillLibraryPage.test.tsx src/features/skills
pnpm --dir apps/desktop typecheck
git diff --check
git add -- apps/desktop/src/ui/DataState.tsx apps/desktop/src/ui/DataState.test.tsx apps/desktop/src/features/skills/testFixtures.ts apps/desktop/src/features/skills/SkillLibraryPage.tsx apps/desktop/src/features/skills/SkillLibraryPage.test.tsx apps/desktop/src/i18n/en-US/common.json apps/desktop/src/i18n/zh-CN/common.json apps/desktop/src/styles/base.css
git commit -m "feat: compose Skill library workspace"
```

Expected: every skills test PASS; batch tests record intent and find no fake success copy.

---

### Task 6: Wire production and development routes, then run final QA

**Files:**
- Create: `apps/desktop/src/features/skills/SkillLibraryPreview.tsx`
- Modify: `apps/desktop/src/app/router.tsx`
- Modify: `apps/desktop/src/app/router.test.tsx`
- Modify: `apps/desktop/src/app/RoutePlaceholder.tsx`
- Modify: `apps/desktop/src/i18n/en-US/common.json`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`
- Modify: `apps/desktop/src/styles/base.css`

**Interfaces:**
- Consumes: `SkillLibraryPage`, unavailable facade, and Mock Facade from Task 5.
- Produces: truthful `/library`, reserved `/library/:skillId`, development-only `/__preview/skill-library`, and final Task4 acceptance evidence.

- [ ] **Step 1: Write failing route integration tests**

Update the existing `/library` router assertion and add:

```tsx
it("uses the unavailable facade on the production Skill library route", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/library");
  render(<AppRouter />);
  expect(await screen.findByText("Skill catalog data is not connected yet")).toBeVisible();
  expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
});

it("reserves the full-detail URL without changing the shell section", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/library/skill-pdf");
  render(<AppRouter />);
  expect(await screen.findAllByRole("heading", { name: "Skill library" })).toHaveLength(2);
  expect(screen.getByText("Full Skill details are delivered in the next task")).toBeVisible();
});
```

Do not assert the preview route in production-mode Vitest because `import.meta.env.DEV` is controlled by Vite; test `SkillLibraryPreview` directly with the Mock Facade.

- [ ] **Step 2: Run route tests and verify the red state**

Run:

```powershell
pnpm --dir apps/desktop test --run src/app/router.test.tsx
```

Expected: FAIL because `/library` still renders `RoutePlaceholder`.

- [ ] **Step 3: Wire route injection and the development-only preview**

Replace the library route with:

```tsx
{
  path: "library",
  element: <SkillLibraryPage facade={unavailableSkillLibraryFacade} />,
},
{
  path: "library/:skillId",
  element: <RoutePlaceholder titleKey="navigation.library" descriptionKey="skillLibrary.fullDetailsBoundary" />,
},
```

Extend `RoutePlaceholder` with this backward-compatible prop so other routes keep their current description:

```tsx
interface RoutePlaceholderProps {
  descriptionKey?: string;
  titleKey: RouteTitleKey;
}

export function RoutePlaceholder({
  descriptionKey = "appShell.placeholder",
  titleKey,
}: RoutePlaceholderProps) {
  const { t } = useTranslation();
  return (
    <section className="sh-app-shell__placeholder">
      <h2>{t(titleKey)}</h2>
      <p>{t(descriptionKey)}</p>
    </section>
  );
}
```

Create `SkillLibraryPreview` as a top-level component that constructs its Mock Facade once with `useState(() => createMockSkillLibraryFacade())` and renders `SkillLibraryPage`. Also export `SkillLibraryPreviewShell`, which renders `AppShell` with a fixed clean `BootstrapSnapshot`, `verification={{ kind: "unavailable" }}`, and an `<Outlet>` supplied by `AppShell`. This bypasses native bootstrap only for the preview and still exercises the real sidebar/topbar geometry.

Use this exact preview snapshot; it contains shell counters only and no Skill rows:

```tsx
const PREVIEW_BOOTSTRAP_SNAPSHOT: BootstrapSnapshot = {
  agent_count: 2,
  deployed_count: 12,
  deployment_categories: [],
  last_scan_at: null,
  pending: { by_kind: {}, total: 0 },
  project_count: 6,
  recent_operations: [],
  recovery_state: "clean",
  skill_count: 80,
};

export function SkillLibraryPreviewShell() {
  return (
    <AppShell
      snapshot={PREVIEW_BOOTSTRAP_SNAPSHOT}
      verification={{ kind: "unavailable" }}
    />
  );
}
```

Add the preview as a separate top-level route tree, not as a child of the production `DesktopApp`, so plain Vite visual QA does not call the Tauri bootstrap binding:

```tsx
...(import.meta.env.DEV
  ? [
      {
        path: "__preview",
        element: <SkillLibraryPreviewShell />,
        children: [
          { path: "skill-library", element: <SkillLibraryPreview /> },
        ],
      },
    ]
  : []),
```

The production `/library` module must not import or construct Mock data. Confirm `pnpm --dir apps/desktop build` tree-shakes the preview fixture by checking the output bundle for `PDF Reader` in Step 6.

- [ ] **Step 4: Finish responsive and theme-safe CSS**

Add breakpoints without changing component geometry by theme:

- Below `72rem`, filters wrap while saved views stay horizontally scrollable.
- Below `56rem`, optional low-priority columns overflow horizontally rather than disappearing silently.
- Below `48rem`, drawer modules become one column and near-full width clamps to the viewport.
- Coarse pointers keep interactive controls at least `2.75rem` while table rows remain compact for mouse/keyboard environments.
- `prefers-reduced-motion: reduce` inherits the existing global terminal-state rule; no new transition overrides it.

Verify neutral, warning, danger, and focus states rely only on semantic tokens already defined for all nine themes.

- [ ] **Step 5: Run the full automated acceptance suite**

Run in this order:

```powershell
pnpm --dir apps/desktop test --run src/features/skills
pnpm --dir apps/desktop test --run
pnpm --dir apps/desktop check
pnpm --dir apps/desktop build
rg -n "PDF Reader" apps/desktop/dist
git diff --check
```

Expected:

- All Skill tests and the full Vitest suite PASS.
- ESLint and TypeScript checks exit `0`.
- Production build succeeds.
- `rg` exits `1` with no `PDF Reader` match, proving deterministic preview data is absent from the production bundle.
- Diff check reports no whitespace errors.

- [ ] **Step 6: Perform visual and keyboard QA through the development preview**

Run:

```powershell
pnpm --dir apps/desktop exec vite --host 127.0.0.1
```

Open `/__preview/skill-library` and verify this checklist in both `moss-neutral` and `grok-night`, then repeat the critical labels in `zh-CN` and `en-US`:

1. Compact rows measure 36–40px and 25 rows fit without card-like gaps.
2. Saved views remain one line; search and filters wrap without covering the table.
3. Current-page and all-filtered selections display different scopes in the floating bar.
4. Row body, Enter, checkbox, sort, pagination, and column/density controls do not conflict.
5. The wide drawer overlays the table at 680px, resizes, switches presets, and falls back to one module column at narrow widths.
6. Closing the drawer restores the invoking row focus and the list does not jump.
7. Required drawer modules remain visible; optional modules reorder, hide, and reset.
8. Reduced-motion mode removes drawer translation while preserving the final state.
9. Focus rings, muted text, status badges, overlay, and error states remain legible in both themes.

Stop the dev server after the checks; do not alter production route injection for the preview.

- [ ] **Step 7: Commit the route and final integration**

Run:

```powershell
git add -- apps/desktop/src/features/skills/SkillLibraryPreview.tsx apps/desktop/src/app/router.tsx apps/desktop/src/app/router.test.tsx apps/desktop/src/app/RoutePlaceholder.tsx apps/desktop/src/i18n/en-US/common.json apps/desktop/src/i18n/zh-CN/common.json apps/desktop/src/styles/base.css
git commit -m "feat: wire Skill library desktop route"
git status --short
```

Expected: commit succeeds and `git status --short` is empty. If `RoutePlaceholder.tsx` did not require modification, omit it from `git add`.

---

## Final Review Gate

Before declaring Plan07 Task4 complete:

1. Compare every section of `docs/superpowers/specs/2026-08-25-skillhub-task4-skill-library-design.md` with Tasks 1–6 and record any uncovered requirement as a failing test before changing implementation.
2. Run `git log --oneline -6` and confirm each focused task has its own commit.
3. Run `git diff HEAD~6 -- apps/desktop/src/api/bindings.ts`; expected output is empty.
4. Confirm the production route displays unavailable state and the development preview contains the deterministic rows.
5. Confirm no batch action reports success and no Task5/7/9 workflow was implemented.
6. Use `superpowers:verification-before-completion` before reporting completion.
7. Use `superpowers:requesting-code-review` for the completed Task4 diff before moving to Plan07 Task5.
