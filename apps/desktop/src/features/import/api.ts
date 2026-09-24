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
  /** DEV-3：SKILL.md frontmatter `name`；与 name（文件夹名）不一致时给非阻塞警告。 */
  frontmatterName?: string | null;
}

export interface ImportMatchedSkill {
  id: string;
  displayName: string;
  runtimeName: string;
  source?: string;
}

export interface ImportConflict {
  candidateId: string;
  /** Display name of the candidate (runtime name or SKILL.md name) for readable conflict rows. */
  candidateName?: string;
  kind: ConflictKind;
  summary: string;
  allowedActions: ImportAction[];
  required: true;
  /** Where the imported skill comes from. */
  candidatePath?: string;
  /** Existing skills the candidate collides with, per the analysis contract. */
  matchedSkillIds?: string[];
  matchedSkills?: ImportMatchedSkill[];
  duplicateKind?: string | null;
}

export interface ImportPlan {
  candidates: ImportCandidate[];
  conflicts: ImportConflict[];
  /** prepare_import 的确定性关系分类；前端只负责确认，不重新判断。 */
  governanceGroups?: import("../relationshipGovernance/relationshipGovernance").ImportGovernanceGroup[];
}

/** OPT-20260914-08：导入成功时随结果返回的存证摘要（导入那一刻的事实）。 */
export interface ImportProvenanceSummary {
  agentClientId: string | null;
  originalPath: string;
  importedAt: string;
}

export interface ImportResult {
  candidateId: string;
  action: ImportAction;
  status: "succeeded" | "skipped" | "failed" | "todo";
  message: string;
  /** 导入即存证：提交成功且落库时携带；复用/跳过等分支诚实缺省。 */
  provenance?: ImportProvenanceSummary;
  /** 关系治理是导入后的独立、可回退操作；导入不会清理原始副本。 */
  originalPreserved?: boolean;
  /** 已持久化并可由关系概览查询读取的真实治理待办。 */
  governanceTasks?: import("../../api/bindings").GovernanceTaskFact[];
  /** 结构化原因码，界面不得反向解析展示文案。 */
  reasonCode?: string;
  /** 计划 9.7：本次导入命中的集中库 Skill；跳过/失败诚实缺省。 */
  skillId?: string;
  /**
   * 计划 9.7：本次导入建立或刷新的活动来源副本关系；完成页据此直连
   * “这次导入”的治理上下文。绝不从缓存路径反查关系。
   */
  sourceRelationId?: string;
}

/** 一次向导提交会话的批次摘要；计数由后端持久化映射计算，前端不汇总猜测。 */
export interface ImportBatchSummary {
  batchId: string;
  /** 有活动来源副本关系的成功项数量；Online 等无来源关系的结果不计入。 */
  manageableSourceCount: number;
}

/** commitImport 的完整结果：批次级上下文与逐项结果分离（计划 9.3/9.7）。 */
export interface ImportCommitOutcome {
  batch: ImportBatchSummary;
  results: ImportResult[];
}

export interface ImportProgress {
  candidateId: string;
  completed: number;
  total: number;
}

/** M-29：来源分层——每个已选目录的扫描状态；未扫描也必须可见。 */
export type SourceScanStatus =
  | { kind: "unscanned" }
  | { kind: "scanning" }
  | { kind: "scanned"; count: number }
  | { kind: "failed"; reason: string };

/** One per-object result of the optional AI import pre-check (US-016). */
export interface ImportAiPreCheckOutcome {
  candidateId: string;
  failureCode: string | null;
  fileCount: number;
  findingCount: number;
  state: "not_checked" | "running" | "passed" | "failed";
}

export interface ImportAiPreCheckReport {
  model: string;
  outcomes: ImportAiPreCheckOutcome[];
  provider: string;
  requested: number;
}

export interface ImportFacade {
  parseSource(input: string): Promise<SourceDescriptor>;
  acquireCandidates(
    source: SourceDescriptor,
    signal?: AbortSignal,
  ): Promise<ImportCandidate[]>;
  /**
   * OPT-20260914-01：可选逐候选进度回调，契约与 commitImport 的
   * ImportProgress 一致（{ candidateId, completed, total }，总数即候选数）。
   * 回调是可选能力：不支持回调的实现照旧只接收 candidates，向导据实降级为
   * 不确定进度，绝不伪造百分比。
   */
  analyzeConflicts(
    candidates: ImportCandidate[],
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportPlan>;
  commitImport(
    plan: ImportPlan,
    actions: Record<string, ImportAction>,
    onProgress?: (progress: ImportProgress) => void,
    governanceDecision?: import("../relationshipGovernance/relationshipGovernance").ImportGovernanceDecision,
  ): Promise<ImportCommitOutcome>;
  cancel(): Promise<void>;
  /** Optional advisory AI safety pre-check (step 5). Findings never change
   * the deterministic import gates; failures are per object. Absent keeps
   * the wizard importable without the AI step entirely. */
  runAiPreChecks?(plan: ImportPlan): Promise<ImportAiPreCheckReport>;
  /** Task 8：AI 可用性的真实信号——已配置并启用的供应商存在即可用。
   * 面板的 aiAvailable 由此派生，不再用能力函数存在性冒充。 */
  listLlmProviders(): Promise<
    import("../../api/bindings").LlmProviderView[]
  >;
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
      displayTarget: npxMatch[1].trim().split(/\s+/)[0] ?? "",
      executesCommand: false,
      input: trimmed,
      kind: "npx_reference",
    });
  }

  if (/^(?:github|gitlab):[^\s/]+\/.+/i.test(trimmed)) {
    return Promise.resolve({
      displayTarget: trimmed,
      executesCommand: false,
      input: trimmed,
      kind: "git",
    });
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const repositoryUrl = /^https:\/\/(?:www\.)?(?:github\.com|gitlab\.com)\/[\w.@_-]+(?:\/[\w.@_-]+)+\/?(?:\.git)?$/i;
    return Promise.resolve({
      displayTarget: trimmed,
      executesCommand: false,
      input: trimmed,
      kind: repositoryUrl.test(trimmed) ? "git" : "url",
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
  listLlmProviders: unavailable,
  parseSource: parseSourceInput,
};

/** Task 8：默认 mock 环境带一个已启用、凭据已配置的供应商视图，
 * 与“能力函数在场即可用”的历史行为保持一致；测试可覆写。 */
export function usableProviderViewFixture(): import("../../api/bindings").LlmProviderView {
  return {
    config: {
      id: "mock-provider",
      label: "Mock Provider",
      protocol: "open_ai_compatible",
      deployment: "local",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "mock-model",
      credential_ref: null,
      enabled: true,
    },
    credential_configured: true,
    is_default: true,
    last_connection_test: null,
  };
}

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
  /** true 时分析计划携带确定性关系分组，走治理确认阶段（预览/E2E 用）。 */
  governance?: boolean;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** 治理预览分组：跨候选按类别聚合成组，成员携带来源路径与受影响 Agent。 */
function fixtureGovernanceGroups(
  candidates: ImportCandidate[],
): ImportPlan["governanceGroups"] {
  const [first, second] = candidates;
  if (!first) return [];
  const groups: NonNullable<ImportPlan["governanceGroups"]> = [
    {
      available_actions: ["preserve_original", "create_todo"],
      classification: "shared_directory_read",
      default_action: "preserve_original",
      group_id: "shared-directory-read",
      members: [
        {
          affected_agents: ["trae.code"],
          display_name: first.name,
          member_id: first.id,
          source_path: first.path,
        },
      ],
    },
  ];
  if (second) {
    groups.push({
      available_actions: ["preserve_original", "create_todo"],
      classification: "same_name_different_content",
      default_action: "create_todo",
      group_id: "same-name-different-content",
      members: [
        {
          affected_agents: [],
          display_name: second.name,
          member_id: second.id,
          source_path: second.path,
        },
      ],
    });
  }
  return groups;
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
        candidateName: candidates[0].name,
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
        candidateName: candidates[0].name,
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
    async analyzeConflicts(candidates, onProgress) {
      calls.analyzedCandidates.push(candidates.map(({ id }) => id));
      const selected = clone(candidates);
      // 进度契约与真实 facade 一致：逐候选回调，总数即候选数。
      for (const [index, candidate] of selected.entries()) {
        onProgress?.({ candidateId: candidate.id, completed: index + 1, total: selected.length });
      }
      const plan = {
        candidates: selected,
        conflicts: fixtureConflicts(options.scenario, selected),
        ...(options.governance
          ? {
              governanceGroups: fixtureGovernanceGroups(selected),
            }
          : {}),
      };
      facade.fixtures.plan = clone(plan);
      return clone(plan);
    },
    async commitImport(plan, actions) {
      calls.committedActions.push(clone(actions));
      const results = plan.candidates.map<ImportResult>((candidate, index) => {
        const action = actions[candidate.id] ?? "copy";
        if (action === "skip") {
          return {
            action,
            candidateId: candidate.id,
            message: "已跳过",
            status: "skipped",
          };
        }
        if (options.governance && index === 0) {
          // 治理确认的"创建待办"路径：结果携带已持久化的治理待办事实。
          return {
            action,
            candidateId: candidate.id,
            message: "importWorkflow.commitMessages.imported",
            originalPreserved: true,
            status: "todo",
            skillId: `mock-skill-${index}`,
            sourceRelationId: `rel-mock-${index}`,
            governanceTasks: [
              {
                created_at: "0",
                detail: "import.governance.task.confirm_shared_directory_impact",
                kind: "confirm_shared_directory_impact",
                resolved: false,
                resolved_at: null,
                subject_id: candidate.id,
                task_id: "task:preview-governance",
              },
            ],
          };
        }
        return {
          action,
          candidateId: candidate.id,
          message: "已导入",
          status: "succeeded",
          skillId: `mock-skill-${index}`,
          sourceRelationId: `rel-mock-${index}`,
        };
      });
      facade.fixtures.results = clone(results);
      // 批次摘要与逐项结果分离：成功且携带来源关系的项才计入。
      const manageableSourceCount = results.filter(
        (result) => result.sourceRelationId !== undefined,
      ).length;
      return clone({
        batch: { batchId: "batch-mock", manageableSourceCount },
        results,
      });
    },
    cancel() {
      cancelled = true;
      cancelReject?.();
      cancelReject = undefined;
      calls.cancelled += 1;
      return Promise.resolve();
    },
    async listLlmProviders() {
      return options.governance ? [] : [usableProviderViewFixture()];
    },
    parseSource(input) {
      calls.parsedInputs.push(input);
      return parseSourceInput(input);
    },
  };

  void lastCandidates;
  return facade;
}
