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
  /**
   * W3-1：候选检查状态。acquire 阶段只有 not_checked；analyze 阶段的
   * prepare 会带回真实 check_state（passed/warning/failed/unavailable），
   * 徽标据实显示，不再硬编码“尚未检查”。
   */
  basicCheck: "not_checked" | "passed" | "failed" | "warning" | "unavailable";
  /** DEV-3：SKILL.md frontmatter `name`；与 name（文件夹名）不一致时给非阻塞警告。 */
  frontmatterName?: string | null;
  /**
   * W2-2（FB-007）：候选在其来源根下的相对目录。native facade 从真实
   * 扫描结果填充；mock/预览可缺省。批内候选 key 的稳定后缀。
   */
  relativeRoot?: string | null;
}

/** analyze_import_batch 的同内容组：后端建议保留项与其余应跳过项。 */
export interface ImportBatchSameContentGroup {
  /** 建议保留（= 复制导入）的候选；同内容孪生可互换。 */
  keepCandidateId: string;
  normalizedRuntimeName: string;
  /** 建议跳过的重复孪生。 */
  skipCandidateIds: string[];
}

/** analyze_import_batch 的同名不同内容组：成员必须逐项显式处置。 */
export interface ImportBatchSameNameGroup {
  normalizedRuntimeName: string;
  candidateIds: string[];
}

/** 批内冲突分组与组成签名；组内 id 均指本次计划的候选。 */
export interface ImportBatchAnalysis {
  sameContentGroups: ImportBatchSameContentGroup[];
  sameNameGroups: ImportBatchSameNameGroup[];
  /** 组成签名：提交时携带，组成变化即被后端拒绝（batch_composition_changed）。 */
  signature: string;
}

/**
 * W3-1（FB-003）：prepare_import 随 prepared 结果返回的安全分级摘要视图。
 * 展示只消费这里的结构化事实（级别/数量/逐条发现的规则码与位置），
 * 不渲染 candidate id、finding 序号等内部标识；可读名称由界面映射。
 */
export interface ImportSecurityFindingView {
  code: string;
  productLevel: import("../../api/bindings").ProductLevel;
  file?: string | null;
  lineStart?: number | null;
}

export interface ImportSecuritySummaryView {
  level: import("../../api/bindings").ImportSecurityLevel;
  dangerCount: number;
  warningCount: number;
  findings: ImportSecurityFindingView[];
  /** prepare 的候选检查状态；缺省时徽标保持 not_checked。 */
  checkState?: import("../../api/bindings").ImportCandidateCheckState;
}

/** candidateId → 安全摘要；analyzeConflicts 阶段由 prepare_import 汇总。 */
export type ImportSecurityPlan = Record<string, ImportSecuritySummaryView>;

/** 后端安全分级（pass / warning / danger），候选行徽标与决策区共用。 */
export type ImportSecurityLevel = import("../../api/bindings").ImportSecurityLevel;

/**
 * W3-1：危险级候选的用户决策。proceed=仍然导入（导入后进入预警状态，
 * 处理前不可派发）；skip=不导入（后端按跳过落账，不落库）。
 */
export type ImportSecurityDecision = "proceed" | "skip";

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
  /** W2-2：批内冲突分组与组成签名；无批内分析（或环境不支持）时缺省。 */
  batchAnalysis?: ImportBatchAnalysis;
  /**
   * W3-1：candidateId → prepare 阶段的安全分级摘要。analyze 环境不支持
   * prepare（或准备失败）时缺省——处置环节不渲染安全区块，最终门禁仍由
   * 提交期后端错误码（import.security_decision_required）把守。
   */
  security?: ImportSecurityPlan;
}

/** OPT-20260914-08：导入成功时随结果返回的存证摘要（导入那一刻的事实）。 */
export interface ImportProvenanceSummary {
  agentClientId: string | null;
  originalPath: string;
  importedAt: string;
  /**
   * 任务 10：来源形态。在线来源（https/git）只展示服务/仓库地址，
   * 本地缓存路径绝不进入界面。
   */
  sourceKind?: "local" | "https" | "git";
  /** 在线来源的服务/仓库地址；本地来源缺省。 */
  sourceLocator?: string;
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

/** W2-2/W3-1：提交时随处置透传的数据；门面自行映射到 prepare/commit 字段。 */
export interface ImportCommitDispositions {
  /** candidateId → 独立导入的新名；仅动作为 independent 的项会被透传。 */
  runtimeNameOverrides?: Record<string, string>;
  /**
   * 提交期刷新的批次组成签名（native 门面在 begin_import_batch 后重跑
   * analyze_import_batch 取得）；与 analyze 阶段不一致即被后端拒绝。
   */
  batchSignature?: string | null;
  /**
   * W3-1：candidateId → 危险级候选的安全决策。skip=不导入（后端按跳过
   * 落账）；proceed=仍然导入（进入预警状态）。仅对做了决策的候选透传。
   */
  securityDecisions?: Record<string, ImportSecurityDecision>;
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
    /** W2-2：批内处置（独立改名 + 提交期签名）；无批内分析时缺省。 */
    dispositions?: ImportCommitDispositions,
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
  | "batch-conflicts"
  /** W3-1：危险级候选（需逐个安全决策）+ 警告级候选 + 放行级候选。 */
  | "security-danger"
  /** §24：同一 Skill 多来源的警告级候选——名单按身份去重与三档批量语义。 */
  | "security-warning-duplicates"
  | "cancelled";

export interface MockImportCalls {
  analyzedCandidates: string[][];
  cancelled: number;
  committedActions: Array<Record<string, ImportAction>>;
  /** W2-2：提交时携带的批内处置（未携带的调用不记录）。 */
  committedDispositions: ImportCommitDispositions[];
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
  /**
   * 第 24 节：把指定候选标记为危险级（其余候选放行级），用于在同一场景
   * 内同时覆盖安全决策与批内/库内处置的交互（如回退失效重验）。缺省时
   * 非 security-danger 场景的计划携带全放行的安全分级，与 native 门面
   * “prepare 成功即有分级”的同形语义一致。
   */
  dangerCandidateIds?: string[];
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
  if (scenario === "batch-conflicts") {
    // W2-2：两个同内容孪生（Notes Sync）+ 两个同名不同内容（Alpha），
    // relativeRoot 各不相同，覆盖批内分组的两种形态。
    return [
      {
        basicCheck: "passed" as const,
        id: "notes-a",
        name: "Notes Sync",
        ownership: "unknown" as const,
        path: `${source.displayTarget}/notes-sync`,
        relativeRoot: "notes-sync",
      },
      {
        basicCheck: "passed" as const,
        id: "notes-b",
        name: "Notes Sync",
        ownership: "unknown" as const,
        path: `${source.displayTarget}/backup/notes-sync`,
        relativeRoot: "backup/notes-sync",
      },
      {
        basicCheck: "passed" as const,
        id: "alpha-a",
        name: "Alpha",
        ownership: "unknown" as const,
        path: `${source.displayTarget}/codex/alpha`,
        relativeRoot: "codex/alpha",
      },
      {
        basicCheck: "passed" as const,
        id: "alpha-b",
        name: "Alpha",
        ownership: "unknown" as const,
        path: `${source.displayTarget}/claude/alpha`,
        relativeRoot: "claude/alpha",
      },
    ].map((candidate) => ({ ...candidate, source }));
  }

  if (scenario === "security-danger") {
    // W3-1：一个危险级候选（需逐个安全决策）、一个警告级候选（聚合
    // 提示）与一个放行级候选；check_state 随 prepare 语义据实标注。
    return [
      {
        basicCheck: "warning" as const,
        id: "risky-deploy",
        name: "Risky Deploy",
        ownership: "unknown" as const,
        path: `${source.displayTarget}/risky-deploy`,
      },
      {
        basicCheck: "warning" as const,
        id: "suspicious-fetch",
        name: "Suspicious Fetch",
        ownership: "unknown" as const,
        path: `${source.displayTarget}/suspicious-fetch`,
      },
      {
        basicCheck: "passed" as const,
        id: "safe-notes",
        name: "Safe Notes",
        ownership: "unknown" as const,
        path: `${source.displayTarget}/safe-notes`,
      },
    ].map((candidate) => ({ ...candidate, source }));
  }

  if (scenario === "security-warning-duplicates") {
    // §24（2026-10-06）：同一 Skill 的两个来源条目（同名候选）加一个放行
    // 级候选；候选按来源条目计会把同一 Skill 计两次，警告名单须按身份
    // 去重并显示来源数。
    return [
      {
        basicCheck: "warning" as const,
        id: "fetch-a",
        name: "Suspicious Fetch",
        ownership: "unknown" as const,
        path: `${source.displayTarget}/suspicious-fetch`,
        relativeRoot: "suspicious-fetch",
      },
      {
        basicCheck: "warning" as const,
        id: "fetch-b",
        name: "Suspicious Fetch",
        ownership: "unknown" as const,
        path: `${source.displayTarget}/backup/suspicious-fetch`,
        relativeRoot: "backup/suspicious-fetch",
      },
      {
        basicCheck: "passed" as const,
        id: "safe-notes",
        name: "Safe Notes",
        ownership: "unknown" as const,
        path: `${source.displayTarget}/safe-notes`,
        relativeRoot: "safe-notes",
      },
    ].map((candidate) => ({ ...candidate, source }));
  }

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
        summary: "技能库中已有同名 Skill",
      },
    ];
  }

  return [];
}

/** W2-2：batch-conflicts 场景的确定性批内分组（id 跟随实际候选）。 */
function fixtureBatchAnalysis(candidates: ImportCandidate[]): ImportBatchAnalysis {
  return {
    sameContentGroups: [
      {
        keepCandidateId: candidates[0].id,
        normalizedRuntimeName: "notes sync",
        skipCandidateIds: [candidates[1].id],
      },
    ],
    sameNameGroups: [
      {
        candidateIds: [candidates[2].id, candidates[3].id],
        normalizedRuntimeName: "alpha",
      },
    ],
    signature: "mock-batch-signature",
  };
}

/**
 * W3-1：security-danger / §24 security-warning-duplicates 场景的确定性
 * 安全分级（id 跟随实际候选）。字段结构与 bindings 的 ImportSecuritySummary
 * 一致（含 check_state），保证 mock 契约与真实门面同形。
 */
function fixtureSecurityPlan(
  scenario: MockImportScenario,
  candidates: ImportCandidate[],
): ImportSecurityPlan {
  if (scenario === "security-warning-duplicates") {
    const [fetchA, fetchB, safe] = candidates;
    const plan: ImportSecurityPlan = {};
    for (const candidate of [fetchA, fetchB]) {
      if (!candidate) continue;
      plan[candidate.id] = {
        checkState: "warning",
        dangerCount: 0,
        findings: [
          {
            code: "security.possible_plaintext_credential",
            file: "SKILL.md",
            lineStart: 18,
            productLevel: "warning",
          },
        ],
        level: "warning",
        warningCount: 1,
      };
    }
    if (safe) {
      plan[safe.id] = {
        checkState: "passed",
        dangerCount: 0,
        findings: [],
        level: "pass",
        warningCount: 0,
      };
    }
    return plan;
  }
  const [risky, warn, safe] = candidates;
  const plan: ImportSecurityPlan = {};
  if (risky) {
    plan[risky.id] = {
      checkState: "warning",
      dangerCount: 2,
      findings: [
        {
          code: "security.destructive_command",
          file: "scripts/deploy.sh",
          lineStart: 12,
          productLevel: "danger",
        },
        {
          code: "security.elevation",
          file: "scripts/deploy.sh",
          lineStart: 27,
          productLevel: "danger",
        },
      ],
      level: "danger",
      warningCount: 0,
    };
  }
  if (warn) {
    plan[warn.id] = {
      checkState: "warning",
      dangerCount: 0,
      findings: [
        {
          code: "security.possible_plaintext_credential",
          file: "SKILL.md",
          lineStart: 18,
          productLevel: "warning",
        },
      ],
      level: "warning",
      warningCount: 1,
    };
  }
  if (safe) {
    plan[safe.id] = {
      checkState: "passed",
      dangerCount: 0,
      findings: [],
      level: "pass",
      warningCount: 0,
    };
  }
  return plan;
}

/**
 * 第 24 节：其余场景的确定性安全分级——指定候选标记危险级（用于在同一
 * 场景内覆盖安全决策与其他处置的交互），其余候选全部放行级。native 门面
 * 的 prepare 成功即产出分级，mock 计划保持同形。
 */
function fixtureGradedSecurityPlan(
  candidates: ImportCandidate[],
  dangerCandidateIds: readonly string[] | undefined,
): ImportSecurityPlan {
  const dangerIds = new Set(dangerCandidateIds ?? []);
  const plan: ImportSecurityPlan = {};
  for (const candidate of candidates) {
    plan[candidate.id] = dangerIds.has(candidate.id)
      ? {
          checkState: "failed",
          dangerCount: 1,
          findings: [
            {
              code: "security.destructive_command",
              file: "scripts/run.sh",
              lineStart: 3,
              productLevel: "danger",
            },
          ],
          level: "danger",
          warningCount: 0,
        }
      : {
          checkState: "passed",
          dangerCount: 0,
          findings: [],
          level: "pass",
          warningCount: 0,
        };
  }
  return plan;
}

export function createMockImportFacade(
  options: MockImportOptions,
): MockImportFacade {
  const calls: MockImportCalls = {
    analyzedCandidates: [],
    acquiredSources: [],
    cancelled: 0,
    committedActions: [],
    committedDispositions: [],
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
        ...(options.scenario === "batch-conflicts"
          ? { batchAnalysis: fixtureBatchAnalysis(selected) }
          : {}),
        // §24（2026-10-06）：安全场景使用带场景差异的确定性 fixture（执行二）；
        // 其余场景给出一套放行级为主的分级摘要，保证回退候选步时徽标可见
        // （执行三）。
        ...(options.scenario === "security-danger" || options.scenario === "security-warning-duplicates"
          ? { security: fixtureSecurityPlan(options.scenario, selected) }
          : { security: fixtureGradedSecurityPlan(selected, options.dangerCandidateIds) }),
        ...(options.governance
          ? {
              governanceGroups: fixtureGovernanceGroups(selected),
            }
          : {}),
      };
      facade.fixtures.plan = clone(plan);
      return clone(plan);
    },
    async commitImport(plan, actions, _onProgress, _governanceDecision, dispositions) {
      calls.committedActions.push(clone(actions));
      if (dispositions !== undefined) {
        calls.committedDispositions.push(clone(dispositions));
      }
      const analysis = plan.batchAnalysis;
      // W2-2 提交期守卫（mock 与真实后端同口径；最终裁决仍由后端给出）：
      // 1) 签名门——携带的组成签名与计划不一致 → 整批失败，唯一出路重新分析。
      if (
        analysis &&
        dispositions?.batchSignature != null &&
        dispositions.batchSignature !== analysis.signature
      ) {
        const results = plan.candidates.map<ImportResult>((candidate) => ({
          action: actions[candidate.id] ?? "copy",
          candidateId: candidate.id,
          message: "importWorkflow.errors.batchCompositionChanged",
          reasonCode: "import.batch_composition_changed",
          status: "failed",
        }));
        facade.fixtures.results = clone(results);
        return clone({
          batch: { batchId: "batch-mock", manageableSourceCount: 0 },
          results,
        });
      }
      // 2) 处置门——同名不同内容组的成员必须逐项跳过或独立命名（新名非空
      //    且不等于组名），否则该行失败并给出补处置指引；其余行照常。
      const sameNameMembers = new Map(
        (analysis?.sameNameGroups ?? []).flatMap((group) =>
          group.candidateIds.map((id) => [id, group] as const),
        ),
      );
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
        // W3-1 提交期守卫（与后端 import.security_decision_required 同口径）：
        // security_decision=skip 对任何候选生效（后端按跳过落账，不落库，
        // §24 警告级"全部不导入"同走此路径）；危险级候选另须显式决策——
        // skip 或 proceed（仍要导入，进入预警状态），缺决策时该行失败，
        // 其余行照常。
        const securityDecision = dispositions?.securityDecisions?.[candidate.id];
        if (securityDecision === "skip") {
          return {
            action,
            candidateId: candidate.id,
            message: "importWorkflow.commitMessages.skippedBySecurityDecision",
            reasonCode: "import.skipped_by_security_decision",
            status: "skipped",
          };
        }
        if (plan.security?.[candidate.id]?.level === "danger" && !securityDecision) {
          return {
            action,
            candidateId: candidate.id,
            message: "importWorkflow.errors.securityDecisionRequired",
            reasonCode: "import.security_decision_required",
            status: "failed",
          };
        }
        const group = sameNameMembers.get(candidate.id);
        if (group) {
          const override = dispositions?.runtimeNameOverrides?.[candidate.id] ?? "";
          const normalized = override.trim().toLowerCase();
          if (
            action !== "independent" ||
            !normalized ||
            normalized === group.normalizedRuntimeName
          ) {
            return {
              action,
              candidateId: candidate.id,
              message: "importWorkflow.errors.sameNameDispositionRequired",
              reasonCode: "import.same_name_disposition_required",
              status: "failed",
            };
          }
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
