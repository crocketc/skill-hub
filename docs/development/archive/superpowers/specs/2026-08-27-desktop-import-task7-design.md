# Desktop Discovery and Import UI Design

## Scope and decision

This design covers Plan07 Task7: the desktop discovery entry points and one unified import wizard. It is intentionally UI-only. The Rust application facade and generated TypeScript bindings do not currently expose import preparation or commit operations, so this task defines a typed frontend boundary and deterministic test Mock without inventing or changing backend contracts.

The production boundary must report that import is not connected yet. Mock data is allowed only in tests and an explicitly isolated preview route; it must never be imported by the production library or discovery route.

## Module boundaries

`apps/desktop/src/features/import/api.ts` owns the frontend `ImportFacade` contract, domain types, unavailable implementation and deterministic fixture factories. It does not read files, make network requests or execute commands.

`apps/desktop/src/features/discovery/DiscoveryPage.tsx` is the entry surface. `LocalDiscovery.tsx` and `OnlineDiscovery.tsx` present local and online discovery modes while delegating all acquisition to the facade. `apps/desktop/src/features/import/ImportWizard.tsx` owns step state and orchestration. The wizard is decomposed into `SourceInput`, `CandidateSelection`, `ConflictResolution` and `ImportSummary`; these components receive typed props and remain independently testable.

The existing router and i18n resources receive only the new navigation labels and UI copy. No existing Skill, Agent, project or Markdown component is reshaped. No component accesses Tauri bindings directly; a future backend adapter can implement `ImportFacade` after import commands and queries are frozen.

## Facade contract

```ts
export type SourceInputKind = "local_path" | "url" | "git" | "npx_reference" | "unknown";
export type ImportPhase = "idle" | "parsing" | "acquiring" | "analyzing" | "ready" | "committing" | "completed" | "failed" | "cancelled";
export type CandidateOwnership = "managed" | "agent_builtin" | "plugin" | "other_tool" | "unknown";
export type ImportAction = "reuse" | "copy" | "takeover" | "independent" | "skip";
export type ConflictKind = "exact_duplicate" | "same_name" | "semantic_match" | "agent_owned";

export interface SourceDescriptor {
  input: string;
  kind: SourceInputKind;
  displayTarget: string;
  executesCommand: false;
}

export interface ImportCandidate {
  id: string;
  name: string;
  source: SourceDescriptor;
  path: string;
  ownership: CandidateOwnership;
  basicCheck: "not_checked" | "passed" | "failed";
}

export interface ImportConflict {
  candidateId: string;
  kind: ConflictKind;
  summary: string;
  allowedActions: ImportAction[];
  required: true;
}

export interface ImportPlan {
  candidates: ImportCandidate[];
  conflicts: ImportConflict[];
}

export interface ImportResult {
  candidateId: string;
  action: ImportAction;
  status: "succeeded" | "skipped" | "failed";
  message: string;
}

export interface ImportFacade {
  parseSource(input: string): Promise<SourceDescriptor>;
  acquireCandidates(source: SourceDescriptor, signal?: AbortSignal): Promise<ImportCandidate[]>;
  analyzeConflicts(candidates: ImportCandidate[]): Promise<ImportPlan>;
  commitImport(plan: ImportPlan, actions: Record<string, ImportAction>): Promise<ImportResult[]>;
  cancel(): Promise<void>;
}
```

`unavailableImportFacade` rejects acquisition and commit with a typed unavailable error while parsing remains local and deterministic. The parser recognizes `npx skills add ...` as `npx_reference` and sets `executesCommand: false`; it never invokes a process.

## User flow and state rules

The wizard has five visible states: source, acquisition, candidates, conflicts and summary. The step indicator reflects the current state and completed states are navigable backward. Source text remains in state after failure or cancellation. Acquisition exposes cancel and retry. Candidate selection supports one or many candidates and requires at least one selected candidate before analysis.

Conflicts are shown per candidate, never collapsed into one global health score. An Agent-owned candidate defaults to `takeover` only as a suggested radio choice; the user must explicitly select it. Exact duplicate may offer `reuse` or `skip`; same-name and semantic conflicts may offer `copy`, `independent` or `skip` as supplied by the plan. `takeover` explains that the current location remains and becomes managed; it does not imply deployment or runtime authorization. “Force import” is rendered as “独立导入/Import independently” and never as overwrite.

The final action bar is disabled when no candidate is selected, a required conflict lacks an action, or the facade is unavailable. Commit results remain itemized so partial success and failure are truthful. A completed summary offers navigation back to the library, but it does not fabricate a newly managed Skill when the production facade is unavailable.

## Visual and accessibility rules

Use existing semantic tokens, typography, density and button/dialog primitives. The wizard uses a compact stepper, scrollable center panel and sticky bottom action bar. Long paths wrap or collapse into a disclosure; the panel itself remains keyboard reachable. Narrow windows become one column without changing action order. Candidate/conflict status uses text plus icon plus semantic color, with `aria-live` for phase changes and visible focus for every control. The interface must honor reduced motion and must not add local hard-coded theme colors.

## Testing strategy

Tests are written before implementation and must demonstrate the expected failure. `ImportWizard.test.tsx` covers:

1. npx text is parsed and visibly marked as non-executable;
2. local Agent ownership offers takeover before copy and does not imply deployment;
3. multiple candidates can be selected;
4. a required conflict disables commit until an action is chosen;
5. cancellation preserves source input and retry re-enters acquisition;
6. partial commit results show success, skipped and failed candidates independently;
7. unavailable production facade exposes a boundary state instead of Mock data.

Focused tests run with `pnpm --dir apps/desktop test --run src/features/import`; the complete frontend check, test, build and `git diff --check` run before delivery.

## Explicit non-goals

- No Rust command/query/event or Specta binding changes.
- No real filesystem, HTTP, Git, npx, shell or package-script execution.
- No automatic deployment, overwrite behavior or implicit ownership takeover.
- No changes to existing component shapes, theme definitions or unrelated workspaces.

