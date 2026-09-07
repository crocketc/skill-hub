# SkillHub Task5 Skill Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the authoritative Skill detail workspace with preserved library context, independently loaded panels, section-scoped metadata editing, trial lifecycle actions, relationship and requirement facts, and a safe version/rollback experience.

**Architecture:** Add a feature-local `SkillDetailFacade` that exposes typed view models and mutations without extending the Task4 list facade or hand-editing Specta bindings. React Query owns server facts per panel, while each editable section owns only its unsaved draft. The page uses the approved anchor/main/status-rail layout and a deterministic mock preview; the production route uses an explicit unavailable facade until Rust contracts are generated.

**Tech Stack:** React, TypeScript, React Router, TanStack React Query, react-i18next, Vitest, Testing Library, semantic CSS theme tokens, generated Rust/Specta bindings.

**Spec:** `docs/superpowers/specs/2026-08-26-skillhub-task5-skill-detail-design.md`

## Global Constraints

- Follow TDD for every behavior: observe a meaningful failing test before implementation, then make the smallest change that passes.
- Do not hand-edit `apps/desktop/src/api/bindings.ts`; Rust contracts remain the source of truth and generated bindings must show no drift.
- Task5 does not implement Markdown rendering/editing from Task6 or deployment/removal/security-remediation commits from Task9.
- Preserve Task4 list, quick-drawer, URL-query, focus and selection behavior.
- All user-visible copy must use matching `zh-CN` and `en-US` i18n keys.
- All nine themes change complete semantic palettes only; Task5 must not introduce theme-specific component shapes or hardcoded feature colors.
- Use compact desktop density, visible focus, text/icon status cues, `prefers-reduced-motion`, and Windows/macOS-safe browser behavior.
- Production routes must never fall back to mock Skill data or show a successful mutation when the production facade is unavailable.

---

### Task 1: Define Skill detail contracts, query keys and deterministic fixtures

**Files:**
- Create: `apps/desktop/src/features/skill-detail/api.ts`
- Create: `apps/desktop/src/features/skill-detail/api.test.ts`
- Create: `apps/desktop/src/features/skill-detail/testFixtures.ts`

**Interfaces:**
- Consumes: `SkillLifecycle`, `CheckState`, `SkillLibraryQuery` and `BatchAction` from `apps/desktop/src/features/skills/api.ts`.
- Produces: `SkillDetailFacade`, all Task5 view models, `SkillDetailIntent`, `SkillMetadataPatch`, `skillDetailKeys`, `SkillDetailNotFoundError`, `SkillDetailUnavailableError`, `unavailableSkillDetailFacade`, and `createMockSkillDetailFacade`.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import {
  SkillDetailNotFoundError,
  SkillDetailUnavailableError,
  skillDetailKeys,
  unavailableSkillDetailFacade,
} from "./api";

describe("Skill detail contracts", () => {
  it("creates stable panel-specific query keys", () => {
    expect(skillDetailKeys.summary("skill-pdf")).toEqual([
      "skill-detail",
      "skill-pdf",
      "summary",
    ]);
    expect(skillDetailKeys.versions("skill-pdf")).toEqual([
      "skill-detail",
      "skill-pdf",
      "versions",
    ]);
  });

  it("rejects production detail queries without returning demo data", async () => {
    await expect(
      unavailableSkillDetailFacade.getSummary("skill-pdf"),
    ).rejects.toBeInstanceOf(SkillDetailUnavailableError);
    await expect(
      unavailableSkillDetailFacade.getVersions("skill-pdf"),
    ).rejects.toBeInstanceOf(SkillDetailUnavailableError);
  });

  it("keeps missing objects distinct from an unavailable production contract", () => {
    expect(new SkillDetailNotFoundError("missing")).not.toBeInstanceOf(
      SkillDetailUnavailableError,
    );
  });
});
```

- [ ] **Step 2: Run the contract test and observe RED**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/api.test.ts`

Expected: FAIL because `./api` does not exist.

- [ ] **Step 3: Implement the exact feature contracts**

Create `api.ts` with these public shapes and no dependency on handwritten copies of generated Rust results:

```ts
import type {
  BatchAction,
  CheckState,
  SkillLibraryQuery,
  SkillLifecycle,
} from "../skills/api";

export interface SkillDetailSummary {
  agentDeploymentCount: number;
  aiCheck: CheckState;
  alias?: string;
  basicCheck: CheckState;
  currentVersion: string;
  highRiskCount: number;
  id: string;
  lifecycle: SkillLifecycle;
  name: string;
  pendingCount: number;
  projectDeploymentCount: number;
  purpose: string;
  trialDue?: string;
  upgradeAvailable: boolean;
}

export interface SkillTranslation {
  locale: string;
  model: string;
  sourceVersion: string;
  stale: boolean;
  text: string;
  translatedAt: string;
  userRevised: boolean;
}

export interface SkillMetadata {
  alias?: string;
  author?: string;
  copyright?: string;
  license?: string;
  note?: string;
  originalDescription?: string;
  ownership?: string;
  purpose: string;
  source?: string;
  tags: string[];
  translation?: SkillTranslation;
}

export interface SkillMetadataPatch {
  alias?: string | null;
  note?: string | null;
  purpose?: string;
  tags?: string[];
  translationText?: string | null;
}

export interface SkillRelation {
  affectedByCurrentVersion: boolean;
  id: string;
  kind: "agent" | "project";
  label: string;
  logicalTarget: string;
  physicalTarget: string;
  pinned: boolean;
  version: string;
}

export interface SkillRequirementFact {
  declaration: string;
  id: string;
  name: string;
  verification: "declared_only" | "unavailable";
}

export interface SkillDetailInsights {
  combinations: string[];
  dependencies: string[];
  deterministicDuplicates: string[];
  externalChanges: string[];
  operationHistory: Array<{ at: string; id: string; label: string }>;
  semanticDuplicates: string[];
  usageEvidence?: { invocationCount: number; lastUsedAt?: string };
}

export interface SkillVersionEntry {
  basicCheck: CheckState;
  changes: { added: number; changed: number; removed: number };
  createdAt: string;
  id: string;
  label: string;
  origin: "edit" | "import" | "rollback" | "upstream";
}

export interface SkillVersionDiff {
  added: string[];
  changed: string[];
  leftVersionId: string;
  removed: string[];
  rightVersionId: string;
}

export interface RollbackDeploymentImpact {
  affected: boolean;
  id: string;
  label: string;
  pinned: boolean;
  version: string;
}

export interface SkillRollbackImpact {
  deployments: RollbackDeploymentImpact[];
  rerunsBasicCheck: true;
  targetVersionId: string;
}

export interface AdjacentSkillContext {
  next?: { id: string; name: string };
  position: number;
  previous?: { id: string; name: string };
  total: number;
}

export type SkillDetailIntent =
  | { action: BatchAction; skillId: string; type: "batch" }
  | { skillId: string; type: "abandon_trial" }
  | {
      locale: string;
      overwriteUserRevision: boolean;
      skillId: string;
      type: "translate_description";
    };

export interface SkillDetailFacade {
  commitRollback(skillId: string, versionId: string): Promise<{ newVersionId: string }>;
  emitIntent(intent: SkillDetailIntent): Promise<void>;
  getAdjacentContext(skillId: string, query: SkillLibraryQuery): Promise<AdjacentSkillContext>;
  getInsights(skillId: string): Promise<SkillDetailInsights>;
  getMetadata(skillId: string): Promise<SkillMetadata>;
  getRelations(skillId: string): Promise<SkillRelation[]>;
  getRequirements(skillId: string): Promise<SkillRequirementFact[]>;
  getRollbackImpact(skillId: string, versionId: string): Promise<SkillRollbackImpact>;
  getSummary(skillId: string): Promise<SkillDetailSummary>;
  getVersionDiff(skillId: string, leftVersionId: string, rightVersionId: string): Promise<SkillVersionDiff>;
  getVersions(skillId: string): Promise<SkillVersionEntry[]>;
  saveMetadata(skillId: string, patch: SkillMetadataPatch): Promise<void>;
  setTrial(skillId: string, due: string | null): Promise<void>;
}
```

Define `skillDetailKeys` with `root`, `skill`, `summary`, `metadata`, `relations`, `requirements`, `insights`, `versions`, `versionDiff`, `rollbackImpact` and `adjacent` functions. Every key must include the Skill ID; `adjacent` must also include the serialized library query.

Define separate error classes so the page can render the correct recovery action:

```ts
export class SkillDetailNotFoundError extends Error {
  constructor(skillId: string) {
    super(`Skill not found: ${skillId}`);
    this.name = "SkillDetailNotFoundError";
  }
}

export class SkillDetailUnavailableError extends Error {
  constructor() {
    super("The Skill detail production contract is unavailable.");
    this.name = "SkillDetailUnavailableError";
  }
}
```

Make every unavailable facade method reject with `SkillDetailUnavailableError`. Do not return empty arrays because an empty production result would falsely claim authoritative knowledge.

- [ ] **Step 4: Add deterministic fixture helpers**

Create `testFixtures.ts` with `detailFixture()`, `trialDetailFixture()`, `rollbackFixture()` and `createMockSkillDetailFacade()`. The mock records calls in this exact shape:

```ts
export interface MockSkillDetailCalls {
  committedRollbacks: Array<{ skillId: string; versionId: string }>;
  intents: SkillDetailIntent[];
  metadataPatches: Array<{ patch: SkillMetadataPatch; skillId: string }>;
  trials: Array<{ due: string | null; skillId: string }>;
}

export interface MockSkillDetailOptions {
  adjacent?: AdjacentSkillContext | null;
  deferredRollbackImpact?: boolean;
  failMetadataSave?: boolean;
  failRelations?: boolean;
  failRelationsOnce?: boolean;
  failRollbackCommit?: boolean;
  failSummaryOnce?: boolean;
  failTrialSave?: boolean;
  missingSkill?: boolean;
  sharedPhysicalTarget?: boolean;
  usageEvidence?: SkillDetailInsights["usageEvidence"] | null;
}

export interface DetailFixtureOptions {
  userRevisedTranslation?: boolean;
}
```

`detailFixture(options?: DetailFixtureOptions)` must use `PDF Reader`, an original English description, a saved Chinese translation, purpose `用于 PDF 表格提取`, one Agent relation, one pinned project relation, declared-only requirements, and three versions. `createMockSkillDetailFacade(options?: MockSkillDetailOptions)` uses these fixtures and implements every option deterministically. `adjacent: null` means direct entry has no list context; `usageEvidence: null` means the evidence section is absent. No fixture may be imported by a production facade.

- [ ] **Step 5: Run the focused tests and observe GREEN**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/api.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the contract boundary**

```bash
git add -- apps/desktop/src/features/skill-detail/api.ts apps/desktop/src/features/skill-detail/api.test.ts apps/desktop/src/features/skill-detail/testFixtures.ts
git commit -m "feat: define Skill detail frontend contracts"
```

---

### Task 2: Build the routed detail shell and preserve Skill library context

**Files:**
- Create: `apps/desktop/src/features/skill-detail/detailContext.ts`
- Create: `apps/desktop/src/features/skill-detail/detailContext.test.ts`
- Create: `apps/desktop/src/features/skill-detail/DetailHeader.tsx`
- Create: `apps/desktop/src/features/skill-detail/DetailSectionNav.tsx`
- Create: `apps/desktop/src/features/skill-detail/DetailStatusRail.tsx`
- Create: `apps/desktop/src/features/skill-detail/SkillDetailPage.tsx`
- Create: `apps/desktop/src/features/skill-detail/SkillDetailPage.test.tsx`
- Modify: `apps/desktop/src/features/skills/SkillLibraryPage.tsx`
- Modify: `apps/desktop/src/features/skills/SkillQuickDrawer.tsx`
- Modify: `apps/desktop/src/features/skills/SkillQuickDrawer.test.tsx`

**Interfaces:**
- Consumes: `SkillDetailFacade`, `SkillDetailSummary`, `AdjacentSkillContext`, `skillDetailKeys`, `parseSkillLibrarySearchParams`, and Task4 library query state.
- Produces: routed `SkillDetailPage`, `SkillLibraryReturnState`, sanitized detail/list locations, the approved three-column shell, and context-preserving adjacent navigation.

- [ ] **Step 1: Write failing context and shell tests**

```tsx
it("returns to the filtered Skill library with its scroll and focus context", async () => {
  const facade = createMockSkillDetailFacade();
  renderDetail({
    facade,
    entry: {
      pathname: "/library/skill-pdf",
      search: "?q=pdf&sort=version:desc",
      state: {
        libraryReturn: { focusSkillId: "skill-pdf", scrollLeft: 0, scrollTop: 416 },
      },
    },
  });

  const back = await screen.findByRole("link", { name: "返回技能库" });
  expect(back).toHaveAttribute("href", "/library?q=pdf&sort=version%3Adesc");
});

it("omits fabricated previous and next controls on direct entry", async () => {
  renderDetail({ facade: createMockSkillDetailFacade({ adjacent: null }) });
  expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "上一个技能" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "下一个技能" })).not.toBeInTheDocument();
});
```

Add a Task4 regression test proving that the quick-drawer “完整详情” link removes the drawer-only `skill` query parameter while preserving `q`, filters, sort, page and saved view.

```tsx
it("keeps library query context in the full-detail link without the drawer parameter", async () => {
  renderDrawer({
    initialEntry: "/library?q=pdf&page=2&view=attention&skill=skill-pdf",
  });
  const link = await screen.findByRole("link", { name: "完整详情" });
  expect(link).toHaveAttribute(
    "href",
    "/library/skill-pdf?q=pdf&page=2&view=attention",
  );
});
```

- [ ] **Step 2: Run shell tests and observe RED**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/SkillDetailPage.test.tsx src/features/skill-detail/detailContext.test.ts src/features/skills/SkillQuickDrawer.test.tsx`

Expected: FAIL because the detail shell and return-state helpers do not exist.

- [ ] **Step 3: Implement explicit history state helpers**

In `detailContext.ts` define:

```ts
export interface SkillLibraryReturnState {
  focusSkillId: string;
  scrollLeft: number;
  scrollTop: number;
}

export function detailSearchFromLibrary(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("skill");
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function readLibraryReturnState(value: unknown): SkillLibraryReturnState | undefined {
  if (!value || typeof value !== "object" || !("libraryReturn" in value)) return undefined;
  const candidate = (value as { libraryReturn?: unknown }).libraryReturn;
  if (!candidate || typeof candidate !== "object") return undefined;
  const state = candidate as Partial<SkillLibraryReturnState>;
  return typeof state.focusSkillId === "string" &&
    Number.isFinite(state.scrollLeft) && Number.isFinite(state.scrollTop)
    ? state as SkillLibraryReturnState
    : undefined;
}
```

Pass the captured Task4 table scroll and row ID through the quick-drawer detail link. On return, `SkillLibraryPage` restores the scroll after the table region exists and focuses the matching row; if the row is absent, focus the table results region.

- [ ] **Step 4: Implement the approved shell with summary-first loading**

`SkillDetailPage` reads `skillId` from the route, parses the remaining search string as the library query, loads summary first, and loads adjacent context only when the URL contains meaningful library query context.

Use this stable region order:

```ts
export const DETAIL_SECTIONS = [
  "overview",
  "description",
  "metadata",
  "relations",
  "requirements",
  "security",
  "connections",
  "external",
  "versions",
] as const;
```

`DetailSectionNav` renders anchor links to these IDs. `DetailStatusRail` receives the summary and renders lifecycle/trial, checks, risk/pending counts, deployment counts and one context-aware primary action. Do not implement downstream commit flows; call `facade.emitIntent` for `add_to`, `security_check`, `export`, `archive` and `abandon_trial` boundaries.

- [ ] **Step 5: Run focused tests and observe GREEN**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/SkillDetailPage.test.tsx src/features/skill-detail/detailContext.test.ts src/features/skills/SkillQuickDrawer.test.tsx`

Expected: PASS, including direct entry, context-preserving return, adjacent navigation and Task4 drawer regression.

- [ ] **Step 6: Commit the routed shell**

```bash
git add -- apps/desktop/src/features/skill-detail/detailContext.ts apps/desktop/src/features/skill-detail/detailContext.test.ts apps/desktop/src/features/skill-detail/DetailHeader.tsx apps/desktop/src/features/skill-detail/DetailSectionNav.tsx apps/desktop/src/features/skill-detail/DetailStatusRail.tsx apps/desktop/src/features/skill-detail/SkillDetailPage.tsx apps/desktop/src/features/skill-detail/SkillDetailPage.test.tsx apps/desktop/src/features/skills/SkillLibraryPage.tsx apps/desktop/src/features/skills/SkillQuickDrawer.tsx apps/desktop/src/features/skills/SkillQuickDrawer.test.tsx
git commit -m "feat: add Skill detail workspace shell"
```

---

### Task 3: Add description, translation and section-scoped metadata editing

**Files:**
- Create: `apps/desktop/src/features/skill-detail/MetadataPanel.tsx`
- Create: `apps/desktop/src/features/skill-detail/MetadataPanel.test.tsx`
- Modify: `apps/desktop/src/features/skill-detail/SkillDetailPage.tsx`
- Modify: `apps/desktop/src/features/skill-detail/SkillDetailPage.test.tsx`
- Modify: `apps/desktop/src/features/skill-detail/api.ts`
- Modify: `apps/desktop/src/features/skill-detail/testFixtures.ts`

**Interfaces:**
- Consumes: `SkillMetadata`, `SkillMetadataPatch`, `SkillDetailFacade.saveMetadata`, `skillDetailKeys.metadata` and `skillLibraryKeys`.
- Produces: independently editable alias, purpose, tags, note and translation sections with preserved drafts and precise cache invalidation.

- [ ] **Step 1: Write failing separation and edit-state tests**

```tsx
it("keeps original description, saved translation and user note distinct", async () => {
  renderMetadata({ metadata: detailFixture().metadata });
  expect(await screen.findByText("Original description")).toBeVisible();
  expect(screen.getByText("模型译文")).toBeVisible();
  expect(screen.getByLabelText("我的用途说明")).toHaveValue("用于 PDF 表格提取");
});

it("keeps a failed purpose draft without putting unrelated sections in edit mode", async () => {
  const facade = createMockSkillDetailFacade({ failMetadataSave: true });
  renderMetadata({ facade, metadata: detailFixture().metadata });
  await user.click(screen.getByRole("button", { name: "编辑我的用途说明" }));
  await user.clear(screen.getByLabelText("我的用途说明"));
  await user.type(screen.getByLabelText("我的用途说明"), "新的本地用途");
  await user.click(screen.getByRole("button", { name: "保存我的用途说明" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("未能保存");
  expect(screen.getByLabelText("我的用途说明")).toHaveValue("新的本地用途");
  expect(screen.queryByLabelText("许可证编辑值")).not.toBeInTheDocument();
});

it("requires confirmation before replacing a user-revised translation", async () => {
  const facade = createMockSkillDetailFacade();
  renderMetadata({
    facade,
    metadata: detailFixture({ userRevisedTranslation: true }).metadata,
  });
  await user.click(screen.getByRole("button", { name: "重新翻译描述" }));
  expect(screen.getByText("现有用户修订译文将被替换")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(facade.calls.intents).toEqual([]);
  expect(screen.getByText("模型译文")).toBeVisible();
});
```

- [ ] **Step 2: Run metadata tests and observe RED**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/MetadataPanel.test.tsx src/features/skill-detail/SkillDetailPage.test.tsx`

Expected: FAIL because `MetadataPanel` does not exist.

- [ ] **Step 3: Implement independent edit sections**

Render original description as read-only. Render translation separately with locale/model/time/source-version facts and visible `stale`/`userRevised` labels. Implement independent edit regions for alias, purpose, tags, note and translation text.

Each region keeps this local state only:

```ts
interface EditSectionState<T> {
  draft: T;
  error?: string;
  mode: "read" | "edit" | "saving";
}
```

Cancel restores the last server value. A failed mutation returns to `edit`, preserves `draft`, sets `error`, and returns focus to the failing field. A successful mutation returns to `read` and invalidates:

```ts
queryClient.invalidateQueries({ queryKey: skillDetailKeys.metadata(skillId) });
queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(skillId) });
queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
```

- [ ] **Step 4: Add translation overwrite protection**

When `translation.userRevised` is true, starting a replacement translation first renders a confirmation whose text names the saved locale and explains that the user revision will be replaced. Cancel must leave the existing text unchanged. The actual LLM translation command is outside the frozen production boundary; emit a typed intent only after confirmation and never display translated-success copy without a facade result.

- [ ] **Step 5: Run focused tests and observe GREEN**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/MetadataPanel.test.tsx src/features/skill-detail/SkillDetailPage.test.tsx`

Expected: PASS for separation, save, cancel, failure retention, stale labels and user-revision protection.

- [ ] **Step 6: Commit metadata editing**

```bash
git add -- apps/desktop/src/features/skill-detail/MetadataPanel.tsx apps/desktop/src/features/skill-detail/MetadataPanel.test.tsx apps/desktop/src/features/skill-detail/SkillDetailPage.tsx apps/desktop/src/features/skill-detail/SkillDetailPage.test.tsx apps/desktop/src/features/skill-detail/api.ts apps/desktop/src/features/skill-detail/testFixtures.ts
git commit -m "feat: edit Skill detail metadata by section"
```

---

### Task 4: Implement lifecycle and lightweight trial actions

**Files:**
- Create: `apps/desktop/src/features/skill-detail/LifecyclePanel.tsx`
- Create: `apps/desktop/src/features/skill-detail/TrialActions.tsx`
- Create: `apps/desktop/src/features/skill-detail/TrialActions.test.tsx`
- Modify: `apps/desktop/src/features/skill-detail/DetailStatusRail.tsx`
- Modify: `apps/desktop/src/features/skill-detail/SkillDetailPage.tsx`
- Modify: `apps/desktop/src/features/skill-detail/api.ts`
- Modify: `apps/desktop/src/features/skill-detail/testFixtures.ts`

**Interfaces:**
- Consumes: summary lifecycle/trial facts, `SkillDetailFacade.setTrial`, `SkillDetailFacade.emitIntent` and summary/list query keys.
- Produces: set/extend/convert trial behavior and a typed `abandon_trial` handoff without implementing removal.

- [ ] **Step 1: Write failing trial-close-loop tests**

```tsx
it("converts trial by removing only the trial date", async () => {
  const facade = createMockSkillDetailFacade();
  renderTrial({ facade, summary: trialDetailFixture().summary });
  await user.click(screen.getByRole("button", { name: "正式纳入管理" }));
  expect(facade.calls.trials).toEqual([{ due: null, skillId: "skill-pdf" }]);
  expect(facade.calls.intents).toEqual([]);
});

it("hands abandon-trial to the later removal workflow without claiming deletion", async () => {
  const facade = createMockSkillDetailFacade();
  renderTrial({ facade, summary: trialDetailFixture().summary });
  await user.click(screen.getByRole("button", { name: "放弃试用" }));
  expect(facade.calls.intents).toContainEqual({
    skillId: "skill-pdf",
    type: "abandon_trial",
  });
  expect(screen.queryByText("已删除")).not.toBeInTheDocument();
});

it("extends the review date and preserves the chosen date when saving fails", async () => {
  const facade = createMockSkillDetailFacade({ failTrialSave: true });
  renderTrial({ facade, summary: trialDetailFixture().summary });
  await user.click(screen.getByRole("button", { name: "延长试用" }));
  await user.clear(screen.getByLabelText("复核日期"));
  await user.type(screen.getByLabelText("复核日期"), "2026-09-02");
  await user.click(screen.getByRole("button", { name: "保存复核日期" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("未能保存试用日期");
  expect(screen.getByLabelText("复核日期")).toHaveValue("2026-09-02");
  expect(facade.calls.trials).toEqual([{ due: "2026-09-02", skillId: "skill-pdf" }]);
});

it("cancels a trial-date edit without sending a mutation", async () => {
  const facade = createMockSkillDetailFacade();
  renderTrial({ facade, summary: trialDetailFixture().summary });
  await user.click(screen.getByRole("button", { name: "延长试用" }));
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(facade.calls.trials).toEqual([]);
});
```

- [ ] **Step 2: Run the trial tests and observe RED**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/TrialActions.test.tsx`

Expected: FAIL because trial components do not exist.

- [ ] **Step 3: Implement lifecycle facts and trial date editing**

`LifecyclePanel` explains active/trial/archived facts without describing trial as isolation or verification. `TrialActions` supports:

- setting a review date for a non-trial Skill;
- extending the current review date;
- converting by calling `setTrial(skillId, null)`;
- emitting `{ type: "abandon_trial", skillId }` for Task9.

Use a native date input with an explicit visible formatted date. Disable only the active submission. A failed mutation keeps the chosen date and shows an actionable error.

- [ ] **Step 4: Invalidate exact lifecycle consumers after success**

After `setTrial` succeeds, invalidate `skillDetailKeys.summary(skillId)` and `skillLibraryKeys.root`. The bootstrap/pending snapshot has no feature-local query key in Task5, so it updates only through the existing application snapshot/event path. Do not optimistically change deployment, security or lifecycle facts. Announce the actual saved review date or conversion through `aria-live="polite"`.

- [ ] **Step 5: Run focused tests and observe GREEN**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/TrialActions.test.tsx src/features/skill-detail/SkillDetailPage.test.tsx`

Expected: PASS for set, extend, convert, cancel, failure and abandonment handoff.

- [ ] **Step 6: Commit lifecycle and trial behavior**

```bash
git add -- apps/desktop/src/features/skill-detail/LifecyclePanel.tsx apps/desktop/src/features/skill-detail/TrialActions.tsx apps/desktop/src/features/skill-detail/TrialActions.test.tsx apps/desktop/src/features/skill-detail/DetailStatusRail.tsx apps/desktop/src/features/skill-detail/SkillDetailPage.tsx apps/desktop/src/features/skill-detail/api.ts apps/desktop/src/features/skill-detail/testFixtures.ts
git commit -m "feat: add Skill trial lifecycle actions"
```

---

### Task 5: Add relations, requirements and evidence-bounded insight panels

**Files:**
- Create: `apps/desktop/src/features/skill-detail/RelationsPanel.tsx`
- Create: `apps/desktop/src/features/skill-detail/RequirementsPanel.tsx`
- Create: `apps/desktop/src/features/skill-detail/InsightPanels.tsx`
- Create: `apps/desktop/src/features/skill-detail/InsightPanels.test.tsx`
- Modify: `apps/desktop/src/features/skill-detail/SkillDetailPage.tsx`
- Modify: `apps/desktop/src/features/skill-detail/testFixtures.ts`

**Interfaces:**
- Consumes: `SkillRelation[]`, `SkillRequirementFact[]`, `SkillDetailInsights`, and the panel-specific facade queries.
- Produces: factual relationship/physical-target views, declared-only requirement labeling, separate security/duplicate/external/history summaries, and conditional usage evidence.

- [ ] **Step 1: Write failing truth-boundary and partial-error tests**

```tsx
it("labels requirements as declared without claiming installation or verification", async () => {
  renderDetailPanels({ facade: createMockSkillDetailFacade() });
  expect(await screen.findByText("Poppler")).toBeVisible();
  expect(screen.getByText("仅来自 Skill 声明，SkillHub 未安装或验证")).toBeVisible();
  expect(screen.queryByText(/已安装|运行验证通过/)).not.toBeInTheDocument();
});

it("keeps successful panels visible when relations fail", async () => {
  renderDetailPanels({
    facade: createMockSkillDetailFacade({ failRelations: true }),
  });
  expect(await screen.findByRole("alert", { name: "关系加载失败" })).toBeVisible();
  expect(screen.getByText("Poppler")).toBeVisible();
  expect(screen.getByText("基础安全检查")).toBeVisible();
});

it("omits usage evidence when reliability is not established", async () => {
  renderDetailPanels({
    facade: createMockSkillDetailFacade({ usageEvidence: null }),
  });
  expect(await screen.findByText("外部变化与操作历史")).toBeVisible();
  expect(screen.queryByText("使用证据")).not.toBeInTheDocument();
});

it("retries a failed relation panel without reloading successful panels", async () => {
  renderDetailPanels({
    facade: createMockSkillDetailFacade({ failRelationsOnce: true }),
  });
  const retry = await screen.findByRole("button", { name: "重试关系" });
  expect(screen.getByText("Poppler")).toBeVisible();
  await user.click(retry);
  expect(await screen.findByText("Codex CLI")).toBeVisible();
  expect(screen.getByText("Poppler")).toBeVisible();
});

it("shows two logical relations connected to one physical target", async () => {
  renderDetailPanels({
    facade: createMockSkillDetailFacade({ sharedPhysicalTarget: true }),
  });
  expect(await screen.findAllByTestId("logical-target")).toHaveLength(2);
  expect(screen.getAllByTestId("physical-target")).toHaveLength(1);
});
```

- [ ] **Step 2: Run panel tests and observe RED**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/InsightPanels.test.tsx`

Expected: FAIL because the panels do not exist.

- [ ] **Step 3: Implement relation and requirement facts**

`RelationsPanel` groups logical Agent/project relations while exposing the physical target string and pinned/current version facts. Shared physical targets must be represented once as a physical fact connected to multiple logical rows; do not duplicate the physical directory as if it were two independent copies.

`RequirementsPanel` renders every requirement with its declaration and `verification` label. Only `declared_only` and `unavailable` are legal in Task5; neither may use success styling.

- [ ] **Step 4: Implement insight sections with strict absence semantics**

`InsightPanels` renders deterministic duplicates, semantic duplicates, dependencies, combinations, external changes and operation history as separate subsections. Basic and AI security summaries remain independent facts. Render usage evidence only when the fixture supplies `usageEvidence`; otherwise render nothing for that subsection.

Each query uses its own `DataState`-style error with retry. Empty arrays display an explanatory sentence specific to the fact, such as “未发现外部变化” rather than a blank card.

- [ ] **Step 5: Run focused tests and observe GREEN**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/InsightPanels.test.tsx src/features/skill-detail/SkillDetailPage.test.tsx`

Expected: PASS for physical-target grouping, declared-only wording, independent failures, empty states and usage-evidence omission.

- [ ] **Step 6: Commit factual detail panels**

```bash
git add -- apps/desktop/src/features/skill-detail/RelationsPanel.tsx apps/desktop/src/features/skill-detail/RequirementsPanel.tsx apps/desktop/src/features/skill-detail/InsightPanels.tsx apps/desktop/src/features/skill-detail/InsightPanels.test.tsx apps/desktop/src/features/skill-detail/SkillDetailPage.tsx apps/desktop/src/features/skill-detail/testFixtures.ts
git commit -m "feat: add Skill relation and evidence panels"
```

---

### Task 6: Implement the vertical version timeline and inline rollback impact

**Files:**
- Create: `apps/desktop/src/features/skill-detail/VersionTimeline.tsx`
- Create: `apps/desktop/src/features/skill-detail/VersionTimeline.test.tsx`
- Modify: `apps/desktop/src/features/skill-detail/SkillDetailPage.tsx`
- Modify: `apps/desktop/src/features/skill-detail/api.ts`
- Modify: `apps/desktop/src/features/skill-detail/testFixtures.ts`

**Interfaces:**
- Consumes: `SkillVersionEntry[]`, `SkillVersionDiff`, `SkillRollbackImpact`, version facade methods and query keys.
- Produces: vertical chronological history, exactly-two-version comparison, file-level diff summary, rollback impact preview and guarded commit.

- [ ] **Step 1: Write failing timeline and rollback tests**

```tsx
it("compares exactly two selected versions", async () => {
  const facade = createMockSkillDetailFacade();
  renderTimeline({ facade });
  await user.click(await screen.findByRole("checkbox", { name: "选择 v2.4.1 进行比较" }));
  await user.click(screen.getByRole("checkbox", { name: "选择 v2.4.0 进行比较" }));
  await user.click(screen.getByRole("button", { name: "比较所选版本" }));
  expect(await screen.findByText("新增文件：1")).toBeVisible();
  expect(screen.getByText("修改文件：2")).toBeVisible();
});

it("previews affected unpinned deployments and unaffected pinned versions before rollback", async () => {
  const facade = createMockSkillDetailFacade();
  renderTimeline({ facade });
  await user.click(await screen.findByRole("button", { name: "回滚到 v2.4.0" }));
  expect(await screen.findByText("Codex CLI 将更新")).toBeVisible();
  expect(screen.getByText("Demo Project 固定版本不受影响")).toBeVisible();
  expect(screen.getByText("回滚后重新执行基础安全检查")).toBeVisible();
  expect(facade.calls.committedRollbacks).toEqual([]);
});

it("blocks duplicate rollback submission and preserves the impact after failure", async () => {
  const facade = createMockSkillDetailFacade({ failRollbackCommit: true });
  renderTimeline({ facade });
  await user.click(await screen.findByRole("button", { name: "回滚到 v2.4.0" }));
  const confirm = await screen.findByRole("button", { name: "确认创建回滚版本" });
  await user.dblClick(confirm);
  expect(facade.calls.committedRollbacks).toHaveLength(1);
  expect(await screen.findByRole("alert")).toHaveTextContent("回滚未完成");
  expect(screen.getByText("Demo Project 固定版本不受影响")).toBeVisible();
});
```

- [ ] **Step 2: Run timeline tests and observe RED**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/VersionTimeline.test.tsx`

Expected: FAIL because `VersionTimeline` does not exist.

- [ ] **Step 3: Implement the timeline and comparison selection model**

Render current version first, then descending history. Each node includes origin, date, basic-check state and added/changed/removed counts. Use a two-item selection array:

```ts
function toggleComparedVersion(selected: string[], versionId: string): string[] {
  if (selected.includes(versionId)) return selected.filter((id) => id !== versionId);
  return selected.length === 2 ? [selected[1], versionId] : [...selected, versionId];
}
```

Enable “比较所选版本” only when there are exactly two IDs. Fetch file-level differences only after the user starts comparison. Keep unknown content differences out of Task5.

- [ ] **Step 4: Implement inline rollback preparation and commit**

Clicking rollback fetches `getRollbackImpact` and moves focus to the inline preview heading. Separate `affected: true` rows from pinned/unaffected rows, state that a new current version will be created, and state that the basic check reruns.

Disable confirmation while impact is loading, incomplete or committing. On success invalidate:

```ts
await Promise.all([
  queryClient.invalidateQueries({ queryKey: skillDetailKeys.versions(skillId) }),
  queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(skillId) }),
  queryClient.invalidateQueries({ queryKey: skillDetailKeys.relations(skillId) }),
  queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root }),
]);
```

On failure keep the preview and selected target visible. Cancel removes the preview and returns focus to the originating version action.

- [ ] **Step 5: Run focused tests and observe GREEN**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/VersionTimeline.test.tsx src/features/skill-detail/SkillDetailPage.test.tsx`

Expected: PASS for timeline order, two-version selection, lazy diff, impact facts, success, failure, cancel and duplicate-submit protection.

- [ ] **Step 6: Commit version lifecycle behavior**

```bash
git add -- apps/desktop/src/features/skill-detail/VersionTimeline.tsx apps/desktop/src/features/skill-detail/VersionTimeline.test.tsx apps/desktop/src/features/skill-detail/SkillDetailPage.tsx apps/desktop/src/features/skill-detail/api.ts apps/desktop/src/features/skill-detail/testFixtures.ts
git commit -m "feat: add Skill version and rollback timeline"
```

---

### Task 7: Compose production/preview routes, responsive styling, i18n and accessibility states

**Files:**
- Create: `apps/desktop/src/features/skill-detail/SkillDetailPreview.tsx`
- Create: `apps/desktop/src/features/skill-detail/skill-detail.css`
- Create: `apps/desktop/src/features/skill-detail/skill-detail.css.test.ts`
- Modify: `apps/desktop/src/features/skill-detail/SkillDetailPage.tsx`
- Modify: `apps/desktop/src/features/skill-detail/SkillDetailPage.test.tsx`
- Modify: `apps/desktop/src/app/router.tsx`
- Modify: `apps/desktop/src/app/router.test.tsx`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`
- Modify: `apps/desktop/src/i18n/en-US/common.json`
- Modify: `apps/desktop/src/i18n/i18n.test.ts`

**Interfaces:**
- Consumes: all Task5 components, `unavailableSkillDetailFacade`, deterministic mock facade, app providers and existing semantic theme tokens.
- Produces: complete `/library/:skillId` production route, isolated `/__preview/skill-detail/:skillId` route, responsive three/two/one-column layout, complete interaction states and bilingual copy.

- [ ] **Step 1: Write failing production-boundary, focus and state tests**

```tsx
it("uses the unavailable facade on the production detail route", async () => {
  await appRouter.navigate("/library/skill-pdf");
  render(<AppRouter />);
  expect(await screen.findByText("Skill 详情数据尚未接入")).toBeVisible();
  expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
});

it("keeps deterministic preview data isolated from production", async () => {
  await appRouter.navigate("/__preview/skill-detail/skill-pdf");
  render(<AppRouter />);
  expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
  await act(async () => appRouter.navigate("/library/skill-pdf"));
  expect(await screen.findByText("Skill 详情数据尚未接入")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "PDF Reader" })).not.toBeInTheDocument();
});

it("moves focus to the next Skill heading and announces the switch", async () => {
  renderDetail({ facade: createMockSkillDetailFacade() });
  await user.click(await screen.findByRole("button", { name: "下一个技能" }));
  expect(await screen.findByRole("heading", { name: "Spreadsheet Reader" })).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent("已切换到 Spreadsheet Reader");
});

it("retries a failed summary without rendering stale mock content", async () => {
  const facade = createMockSkillDetailFacade({ failSummaryOnce: true });
  renderDetail({ facade });
  expect(await screen.findByText("无法加载 Skill 详情")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
});

it("marks the visible section in anchor navigation", async () => {
  renderDetail({ facade: createMockSkillDetailFacade() });
  const versions = await screen.findByRole("link", { name: "版本历史" });
  mockSectionIntersection("versions");
  expect(versions).toHaveAttribute("aria-current", "location");
});

it("states why rollback confirmation is disabled while impact is loading", async () => {
  renderDetail({
    facade: createMockSkillDetailFacade({ deferredRollbackImpact: true }),
  });
  await user.click(await screen.findByRole("button", { name: "回滚到 v2.4.0" }));
  expect(screen.getByRole("button", { name: "确认创建回滚版本" })).toBeDisabled();
  expect(screen.getByText("正在核对受影响部署，完成后才能确认")).toBeVisible();
});

it("returns a missing Skill to the preserved library query", async () => {
  renderDetail({
    entry: { pathname: "/library/missing", search: "?q=pdf&page=2" },
    facade: createMockSkillDetailFacade({ missingSkill: true }),
  });
  expect(await screen.findByText("这个 Skill 已不存在或已移动")).toBeVisible();
  expect(screen.getByRole("link", { name: "返回技能库" })).toHaveAttribute(
    "href",
    "/library?q=pdf&page=2",
  );
});

it("returns focus to the section edit button after cancel", async () => {
  renderDetail({ facade: createMockSkillDetailFacade() });
  const edit = await screen.findByRole("button", { name: "编辑我的用途说明" });
  await user.click(edit);
  await user.click(screen.getByRole("button", { name: "取消编辑我的用途说明" }));
  expect(edit).toHaveFocus();
});
```

Create `skill-detail.css.test.ts` with static guardrails for reduced motion and feature-local color literals:

```ts
import css from "./skill-detail.css?raw";

it("ships reduced-motion terminal styles without feature-local color literals", () => {
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(css).toContain("transition-duration: 0.01ms");
  expect(css).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
});
```

- [ ] **Step 2: Run integration tests and observe RED**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail src/app/router.test.tsx src/i18n/i18n.test.ts`

Expected: FAIL because the production route still renders the placeholder and Task5 copy/styling is incomplete.

- [ ] **Step 3: Wire production and preview routes**

Replace the `/library/:skillId` placeholder with:

```tsx
<SkillDetailPage facade={unavailableSkillDetailFacade} />
```

Add a development-only preview route using a facade created inside `SkillDetailPreview`, never imported by the production route. Keep the shell title mapped to `navigation.library`.

- [ ] **Step 4: Add semantic-token-only responsive CSS**

Import `skill-detail.css` from `SkillDetailPage.tsx`. Use existing tokens such as `--color-surface`, `--color-surface-raised`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-accent`, spacing, radius and shadow tokens. Do not add raw hex, rgb, rgba or theme selectors in the feature stylesheet.

Implement these layout states:

```css
.sh-skill-detail__workspace {
  display: grid;
  grid-template-columns: 10rem minmax(0, 1fr) 18rem;
  gap: var(--space-4);
  align-items: start;
}

@media (max-width: 80rem) {
  .sh-skill-detail__workspace { grid-template-columns: minmax(0, 1fr) 17rem; }
  .sh-skill-detail__section-nav { grid-column: 1 / -1; }
}

@media (max-width: 60rem) {
  .sh-skill-detail__workspace { grid-template-columns: minmax(0, 1fr); }
  .sh-skill-detail__status-rail { position: static; }
}
```

Use sticky positioning only for the section navigation/status rail in layouts where each has one natural scroll owner. Do not add inner full-height scroll containers.

- [ ] **Step 5: Complete bilingual copy and accessible interaction states**

Add a `skillDetail` namespace with identical nested keys in both locale files. Cover headings, anchors, status facts, metadata edit labels, trial actions, version origin labels, comparison, rollback impact, empty states, retry, unavailable boundary, focus announcements and disabled reasons.

All interactive controls need visible labels and focus. Current anchor uses `aria-current="location"`. Status changes use one polite live region. Risk/error alerts use `role="alert"`. Reduced motion removes transform-based transitions and retains final opacity/state.

- [ ] **Step 6: Run all Task5 and frontend verification**

Run:

```text
pnpm --dir apps/desktop test --run src/features/skill-detail src/features/skills/SkillQuickDrawer.test.tsx src/app/router.test.tsx src/i18n/i18n.test.ts
pnpm --dir apps/desktop test --run
pnpm --dir apps/desktop check
pnpm --dir apps/desktop build
```

Expected: all Task5 tests, all frontend tests, ESLint, TypeScript and production build PASS.

- [ ] **Step 7: Verify generated bindings and feature styling boundaries**

Run:

```text
cargo test -p skillhub-desktop generate_bindings
git diff --exit-code -- apps/desktop/src/api/bindings.ts
rg -n "#[0-9a-fA-F]{3,8}|rgba?\(" apps/desktop/src/features/skill-detail/skill-detail.css
git diff --check
```

Expected: bindings test PASS; bindings diff is empty; color search returns no matches; diff check returns no errors.

- [ ] **Step 8: Commit the composed Task5 experience**

```bash
git add -- apps/desktop/src/features/skill-detail/SkillDetailPreview.tsx apps/desktop/src/features/skill-detail/skill-detail.css apps/desktop/src/features/skill-detail/skill-detail.css.test.ts apps/desktop/src/features/skill-detail/SkillDetailPage.tsx apps/desktop/src/features/skill-detail/SkillDetailPage.test.tsx apps/desktop/src/app/router.tsx apps/desktop/src/app/router.test.tsx apps/desktop/src/i18n/zh-CN/common.json apps/desktop/src/i18n/en-US/common.json apps/desktop/src/i18n/i18n.test.ts
git commit -m "feat: wire Skill detail desktop experience"
```

---

## Plan Verification

Before declaring Task5 complete, run fresh commands from the Task5 branch:

```text
pnpm --dir apps/desktop test --run src/features/skill-detail
pnpm --dir apps/desktop test --run
pnpm --dir apps/desktop check
pnpm --dir apps/desktop build
cargo test -p skillhub-desktop generate_bindings
git diff --exit-code -- apps/desktop/src/api/bindings.ts
git diff --check
```

Then inspect the preview at wide, medium and narrow desktop widths in Chinese and English. Check moss-neutral, codex-light and grok-night completely and spot-check the remaining six themes. Verify keyboard-only navigation, focus return after edit/cancel/rollback, reduced motion, long descriptions, absent evidence, one failed panel, many versions and a failed rollback commit.
