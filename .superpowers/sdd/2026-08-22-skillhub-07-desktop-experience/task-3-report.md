# Task 3 Report — Overview and Actionable Deployment Chart

## Status

Completed in commit `fcd74f5` (`feat: add actionable deployment overview chart`).

## What I Implemented

- Replaced the overview placeholder route with a real `OverviewPage` that consumes the cached `BootstrapSnapshot` from the shell outlet context.
- Added overview metrics, a pending-summary panel, and a lazily loaded deployment distribution chart with:
  - Agent/project dimension switching
  - Truthful empty states
  - Visible textual equivalents for every chart value
  - Drill-down targets:
    - `/agents/{key}?view=deployments`
    - `/projects/{key}?view=deployments`
- Declared nested agent/project routes so those drill-down URLs do not 404 while Task 8 remains placeholder-only.
- Updated shell title resolution so nested `/agents/:agentKey` and `/projects/:projectKey` keep the correct topbar title.
- Added overview i18n copy in English and Simplified Chinese.
- Added the missing `echarts` dependency and verified the build emits a separate lazy chunk for `DeploymentBarChart`.

## Files Changed

- `apps/desktop/package.json`
- `apps/desktop/src/app/AppShell.tsx`
- `apps/desktop/src/app/router.tsx`
- `apps/desktop/src/app/router.test.tsx`
- `apps/desktop/src/features/overview/OverviewPage.tsx`
- `apps/desktop/src/features/overview/DeploymentBarChart.tsx`
- `apps/desktop/src/features/overview/PendingSummary.tsx`
- `apps/desktop/src/features/overview/api.ts`
- `apps/desktop/src/features/overview/OverviewPage.test.tsx`
- `apps/desktop/src/i18n/en-US/common.json`
- `apps/desktop/src/i18n/zh-CN/common.json`
- `apps/desktop/src/styles/base.css`
- `pnpm-lock.yaml`

## TDD Evidence

### RED

Command:

```powershell
$env:CI='true'
pnpm --dir apps/desktop test --run src/features/overview/OverviewPage.test.tsx src/app/router.test.tsx
```

Relevant failing output before implementation:

```text
FAIL  src/features/overview/OverviewPage.test.tsx
Error: Failed to resolve import "./OverviewPage"

FAIL  src/app/router.test.tsx > keeps shell titles for filtered agent and project deployment destinations
Error: No route matches URL "/agents/openai.codex-cli"
```

Why this failure was expected:

- `OverviewPage.tsx` did not exist yet.
- The app router had no nested `agents/:agentKey` or `projects/:projectKey` routes yet, so drill-down URLs 404ed.

### GREEN

Focused command (rerun in isolation after implementation):

```powershell
$env:CI='true'
pnpm --dir apps/desktop test --run src/features/overview/OverviewPage.test.tsx src/app/router.test.tsx
```

Passing output:

```text
✓ src/app/router.test.tsx (3 tests)
✓ src/features/overview/OverviewPage.test.tsx (4 tests)
Tests 7 passed (7)
```

## Verification Commands and Results

Focused tests:

```powershell
$env:CI='true'
pnpm --dir apps/desktop test --run src/features/overview/OverviewPage.test.tsx src/app/router.test.tsx
```

Result: PASS (`7/7`)

Full desktop test suite:

```powershell
$env:CI='true'
pnpm --dir apps/desktop test --run
```

Result: PASS (`51/51`)

Lint:

```powershell
$env:CI='true'
pnpm --dir apps/desktop lint
```

Result: PASS

Typecheck:

```powershell
$env:CI='true'
pnpm --dir apps/desktop typecheck
```

Result: PASS

Production build:

```powershell
$env:CI='true'
pnpm --dir apps/desktop build
```

Result: PASS

Relevant build evidence:

```text
dist/assets/index-CSiDpmQZ.js               388.16 kB
dist/assets/DeploymentBarChart-KC85Yxz_.js 469.66 kB
```

This confirms the chart code is emitted as a separate lazy chunk.

Whitespace check:

```powershell
git diff --check HEAD~1 HEAD
```

Result: PASS (no diff-check findings)

## Self-Review

- Scope: stayed within Task 3 only; did not implement later Agent/project workspaces.
- Contract discipline: reused `BootstrapSnapshot` as the single cached source and did not add duplicate native queries or binding edits.
- Truthfulness: the overview does not render `recent_operations`, does not fabricate compatibility/runtime claims, and uses empty states when no deployment relationships exist.
- Accessibility: chart values remain visible in a text list, the dimension switch uses radios, and drill-down actions have explicit labels.
- Bundle behavior: the chart lives in its own lazy-loaded file and the build emitted a distinct chart chunk.

## Notes / Concerns

- One focused-suite run failed when it was launched in parallel with a separate full-suite run in the same worktree session; rerunning the focused suite by itself passed cleanly. I do not believe this indicates a product defect, but I am recording it for transparency because the shared harness was under concurrent validation load.

## Fix Round 1

### Status

Completed in follow-up commit `484fef1` (`fix: harden overview deployment chart delivery`).

### Changes Applied

1. Removed the shell-level cached summary block from `AppShell` so the overview-owned metric cards remain the single visible source of the skill count on routed pages.
2. Split the chart into an eager `DeploymentBarChart` wrapper and a lazy `DeploymentBarChartRuntime` engine so the numeric text equivalent remains visible while the ECharts runtime is still loading.
3. Bound bar, axis, tooltip, split-line, and surface colors to resolved theme CSS tokens and refreshed them when `resolvedTheme` changes, preserving readability across all existing themes without copying raw theme tables into TypeScript.
4. Disabled ECharts animation entirely for the runtime chart.
5. Replaced the new radial hero background with the existing flat token-based raised surface treatment.
6. Updated the overview and router tests to cover the real provider tree, the non-duplicated overview skill count, and the eager numeric-list fallback contract.

### RED

Focused RED command:

```powershell
$env:CI='true'
pnpm --dir apps/desktop test --run src/features/overview/DeploymentBarChart.test.tsx src/app/router.test.tsx
```

Expected failing output before the production fix:

```text
FAIL  src/app/router.test.tsx > wires theme, language, data and motion providers at the production entry without duplicating the overview summary
expected document not to contain element, found <p>Cached skill library</p> instead

FAIL  src/features/overview/DeploymentBarChart.test.tsx > keeps the numeric deployment list visible while the lazy chart runtime is still unresolved
Unable to find an element with the text: Loading deployment chart.

FAIL  src/features/overview/DeploymentBarChart.test.tsx > resolves palette values from theme tokens and keeps chart animation disabled
Unable to find an element by: [data-testid="runtime-props"]
```

Additional regression caught while widening focused coverage to the existing overview suite:

```powershell
$env:CI='true'
pnpm --dir apps/desktop test --run src/features/overview/DeploymentBarChart.test.tsx src/features/overview/OverviewPage.test.tsx src/app/router.test.tsx
```

```text
FAIL  src/features/overview/OverviewPage.test.tsx
Error: useTheme must be used within ThemeProvider
```

That failure was resolved by updating the overview test harness to mount `ThemeProvider`, matching the real app tree.

### GREEN

Focused covering command:

```powershell
$env:CI='true'
pnpm --dir apps/desktop test --run src/features/overview/DeploymentBarChart.test.tsx src/features/overview/OverviewPage.test.tsx src/app/router.test.tsx
```

Passing output:

```text
✓ src/features/overview/DeploymentBarChart.test.tsx (2 tests)
✓ src/features/overview/OverviewPage.test.tsx (4 tests)
✓ src/app/router.test.tsx (3 tests)
Tests 9 passed (9)
```

### Verification Commands and Results

Lint:

```powershell
$env:CI='true'
pnpm --dir apps/desktop lint
```

Result:

```text
$ eslint . --max-warnings 0
```

Typecheck:

```powershell
$env:CI='true'
pnpm --dir apps/desktop typecheck
```

Result:

```text
$ tsc --noEmit
```

Production build:

```powershell
$env:CI='true'
pnpm --dir apps/desktop build
```

Result:

```text
dist/assets/index-CTK_Vg7B.js                      389.53 kB
dist/assets/DeploymentBarChartRuntime-DiabR7sk.js 469.36 kB
✓ built in 3.04s
```

This confirms the chart engine remains in a separate lazy chunk after the wrapper/runtime split.

Whitespace / diff check:

```powershell
git diff --check
```

Result: PASS (Git emitted LF→CRLF checkout warnings on Windows, but no diff-check errors)

Repository hygiene:

- Restored the tracked `apps/desktop/dist/.gitkeep` after the build.
- Verified `.pnpm-store` resolved to `C:\Users\crock\.codex\worktrees\b522\skill-hub\.pnpm-store` and removed only that in-worktree directory before commit.

### Files Changed in Fix Round 1

- `apps/desktop/src/app/AppShell.tsx`
- `apps/desktop/src/app/router.test.tsx`
- `apps/desktop/src/features/overview/DeploymentBarChart.tsx`
- `apps/desktop/src/features/overview/DeploymentBarChart.test.tsx`
- `apps/desktop/src/features/overview/DeploymentBarChartRuntime.tsx`
- `apps/desktop/src/features/overview/OverviewPage.test.tsx`
- `apps/desktop/src/features/overview/OverviewPage.tsx`
- `apps/desktop/src/styles/base.css`

### Self-Review

- The cached snapshot remains the single data source; no new native query or binding change was introduced.
- The numeric list now renders outside Suspense, so the accessible text equivalent survives runtime delay and lazy loading.
- Theme styling is derived from the existing CSS token system rather than a duplicated theme map, and the runtime chunk still lazy-loads separately from the overview page shell.
- The review fixes stayed inside Task 3 scope and did not extend the placeholder agent/project workspaces beyond the already-approved drill-down routes.
