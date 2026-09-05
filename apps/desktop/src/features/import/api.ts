export type SourceInputKind =
  | "local_path"
  | "url"
  | "git"
  | "npx_reference"
  | "unknown";

export type ImportPhase =
  | "idle"
  | "parsing"
  | "acquiring"
  | "analyzing"
  | "ready"
  | "committing"
  | "completed"
  | "failed"
  | "cancelled";

export type CandidateOwnership =
  | "managed"
  | "agent_builtin"
  | "plugin"
  | "other_tool"
  | "unknown";

export type ImportAction =
  | "reuse"
  | "copy"
  | "takeover"
  | "independent"
  | "skip";

export type ConflictKind =
  | "exact_duplicate"
  | "same_name"
  | "semantic_match"
  | "agent_owned";

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
  /** Where the imported skill comes from. */
  candidatePath?: string;
  /** Existing skills the candidate collides with, per the analysis contract. */
  matchedSkillIds?: string[];
  duplicateKind?: string | null;
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

export interface ImportProgress {
  candidateId: string;
  completed: number;
  total: number;
}

export interface ImportFacade {
  parseSource(input: string): Promise<SourceDescriptor>;
  acquireCandidates(
    source: SourceDescriptor,
    signal?: AbortSignal,
  ): Promise<ImportCandidate[]>;
  analyzeConflicts(candidates: ImportCandidate[]): Promise<ImportPlan>;
  commitImport(
    plan: ImportPlan,
    actions: Record<string, ImportAction>,
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportResult[]>;
  cancel(): Promise<void>;
}

export class ImportUnavailableError extends Error {
  constructor() {
    super("import is unavailable until the native contract is generated");
    this.name = "ImportUnavailableError";
  }
}

export class ImportCancelledError extends Error {
  constructor() {
    super("import acquisition was cancelled");
    this.name = "ImportCancelledError";
  }
}

export function parseSourceInput(input: string): Promise<SourceDescriptor> {
  const trimmed = input.trim();
  const npxMatch = trimmed.match(/^npx\s+skills\s+add\s+(.+)$/i);

  if (npxMatch?.[1]) {
    return Promise.resolve({
      displayTarget: npxMatch[1].trim(),
      executesCommand: false,
      input: trimmed,
      kind: "npx_reference",
    });
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return Promise.resolve({
      displayTarget: trimmed,
      executesCommand: false,
      input: trimmed,
      kind: "url",
    });
  }

  if (/^(?:git@|github:|git\+ssh:|git\+https:)/i.test(trimmed) || /\.git(?:#.*)?$/i.test(trimmed)) {
    return Promise.resolve({
      displayTarget: trimmed,
      executesCommand: false,
      input: trimmed,
      kind: "git",
    });
  }

  return Promise.resolve({
    displayTarget: trimmed,
    executesCommand: false,
    input: trimmed,
    kind: trimmed ? "local_path" : "unknown",
  });
}

const unavailable = <T,>(): Promise<T> =>
  Promise.reject(new ImportUnavailableError());

export const unavailableImportFacade: ImportFacade = {
  acquireCandidates: unavailable,
  analyzeConflicts: unavailable,
  cancel: () => Promise.resolve(),
  commitImport: unavailable,
  parseSource: parseSourceInput,
};

export type MockImportScenario =
  | "safe-local"
  | "agent-owned-partial"
  | "conflict-required"
  | "cancelled";

export interface MockImportCalls {
  analyzedCandidates: string[][];
  cancelled: number;
  committedActions: Array<Record<string, ImportAction>>;
  executedCommands: string[];
  parsedInputs: string[];
  acquiredSources: string[];
}

export interface MockImportFacade extends ImportFacade {
  calls: MockImportCalls;
  fixtures: {
    candidates: ImportCandidate[];
    plan: ImportPlan;
    results: ImportResult[];
  };
}

interface MockImportOptions {
  scenario: MockImportScenario;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fixtureCandidates(
  scenario: MockImportScenario,
  source: SourceDescriptor,
): ImportCandidate[] {
  const base = [
    {
      basicCheck: "passed" as const,
      id: "safe-pdf",
      name: "PDF Reader",
      ownership: "unknown" as const,
      path: `${source.displayTarget}/pdf-reader`,
    },
    {
      basicCheck: "not_checked" as const,
      id: "safe-browser",
      name: "Browser Helper",
      ownership: "unknown" as const,
      path: `${source.displayTarget}/browser-helper`,
    },
  ];

  return base.map((candidate, index) => ({
    ...candidate,
    ownership:
      scenario === "agent-owned-partial" && index === 0
        ? "agent_builtin"
        : candidate.ownership,
    source,
  }));
}

function fixtureConflicts(
  scenario: MockImportScenario,
  candidates: ImportCandidate[],
): ImportConflict[] {
  if (scenario === "agent-owned-partial") {
    return [
      {
        allowedActions: ["takeover", "copy", "skip"],
        candidateId: candidates[0].id,
        kind: "agent_owned",
        required: true,
        summary: "目录已由 Agent 管理",
      },
    ];
  }

  if (scenario === "conflict-required") {
    return [
      {
        allowedActions: ["copy", "independent", "skip"],
        candidateId: candidates[0].id,
        kind: "same_name",
        required: true,
        summary: "集中库中已有同名 Skill",
      },
    ];
  }

  return [];
}

export function createMockImportFacade(
  options: MockImportOptions,
): MockImportFacade {
  const calls: MockImportCalls = {
    analyzedCandidates: [],
    acquiredSources: [],
    cancelled: 0,
    committedActions: [],
    executedCommands: [],
    parsedInputs: [],
  };
  let lastCandidates: ImportCandidate[] = [];
  let cancelled = false;
  let cancelReject: (() => void) | undefined;

  const facade: MockImportFacade = {
    calls,
    fixtures: {
      candidates: [],
      plan: { candidates: [], conflicts: [] },
      results: [],
    },
    async acquireCandidates(source, signal) {
      calls.acquiredSources.push(source.displayTarget);
      if (options.scenario === "cancelled") {
        return new Promise<ImportCandidate[]>((_, reject) => {
          cancelReject = () => reject(new ImportCancelledError());
          signal?.addEventListener("abort", () => cancelReject?.(), { once: true });
        });
      }
      if (cancelled || signal?.aborted) {
        throw new ImportCancelledError();
      }
      lastCandidates = fixtureCandidates(options.scenario, source);
      facade.fixtures.candidates = clone(lastCandidates);
      return clone(lastCandidates);
    },
    async analyzeConflicts(candidates) {
      calls.analyzedCandidates.push(candidates.map(({ id }) => id));
      const selected = clone(candidates);
      const plan = {
        candidates: selected,
        conflicts: fixtureConflicts(options.scenario, selected),
      };
      facade.fixtures.plan = clone(plan);
      return clone(plan);
    },
    async commitImport(plan, actions) {
      calls.committedActions.push(clone(actions));
      const results = plan.candidates.map<ImportResult>((candidate) => {
        const action = actions[candidate.id] ?? "copy";
        if (action === "skip") {
          return {
            action,
            candidateId: candidate.id,
            message: "已跳过",
            status: "skipped",
          };
        }
        return {
          action,
          candidateId: candidate.id,
          message: "已导入",
          status: "succeeded",
        };
      });
      facade.fixtures.results = clone(results);
      return clone(results);
    },
    cancel() {
      cancelled = true;
      cancelReject?.();
      cancelReject = undefined;
      calls.cancelled += 1;
      return Promise.resolve();
    },
    parseSource(input) {
      calls.parsedInputs.push(input);
      return parseSourceInput(input);
    },
  };

  void lastCandidates;
  return facade;
}
