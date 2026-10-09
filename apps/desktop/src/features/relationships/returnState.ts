import { useCallback, useMemo } from "react";
import { useLocation } from "react-router-dom";
import type { EnvironmentProblemAnalysis, EnvironmentProblemView } from "../../api/bindings";

/** URL context for reopening a current environment problem in governance. */
export interface UsageGovernanceContext {
  agent_id: string;
  project_id?: string;
  problem_id?: string;
  relation_id?: string;
  skill_id?: string;
  return_to?: string;
}

function safeLocalReturnTarget(value: string | null | undefined): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return undefined;
  }
  try {
    const target = new URL(value, "https://skillhub.invalid");
    return target.origin === "https://skillhub.invalid" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isPendingReturnTarget(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value, "https://skillhub.invalid").pathname === "/pending";
  } catch {
    return false;
  }
}

/** Build the governance URL shape used by pending issue entries. */
export function buildUsageGovernanceHref(context: UsageGovernanceContext): string | null {
  if (!context.agent_id.trim()) return null;
  const returnTo = safeLocalReturnTarget(context.return_to);
  if (isPendingReturnTarget(returnTo) && !context.problem_id?.trim()) return null;
  const params = new URLSearchParams();
  params.set("agent_id", context.agent_id);
  for (const key of ["project_id", "problem_id", "relation_id", "skill_id"] as const) {
    const value = context[key];
    if (value?.trim()) params.set(key, value);
  }
  if (returnTo) params.set("return_to", returnTo);
  return `/relationships/governance?${params}`;
}

/** Parse the same URL context; malformed required identity is not navigable. */
export function parseUsageGovernanceContext(
  searchParams: URLSearchParams,
): UsageGovernanceContext | null {
  const agentId = searchParams.get("agent_id");
  if (!agentId?.trim()) return null;
  const problemId = searchParams.get("problem_id");
  if (searchParams.has("problem_id") && !problemId?.trim()) return null;
  const returnTo = safeLocalReturnTarget(searchParams.get("return_to"));
  if (isPendingReturnTarget(returnTo) && !problemId?.trim()) return null;
  const context: UsageGovernanceContext = { agent_id: agentId };
  for (const key of ["project_id", "problem_id", "relation_id", "skill_id"] as const) {
    const value = searchParams.get(key);
    if (value?.trim()) context[key] = value;
  }
  if (returnTo) context.return_to = returnTo;
  return context;
}

export type UsageGovernanceProblemResolution =
  | { status: "stale" }
  | { status: "scope_changed" }
  | { status: "active"; problem: EnvironmentProblemView };

/** Resolve a deep link against the freshly loaded issue and its exact anchor scope. */
export function resolveUsageGovernanceProblem(
  context: UsageGovernanceContext,
  analysis: EnvironmentProblemAnalysis,
): UsageGovernanceProblemResolution {
  if (!context.problem_id) return { status: "stale" };
  const problem = analysis.problems.find((candidate) => candidate.problem_id === context.problem_id);
  if (!problem || problem.closed) return { status: "stale" };
  const matchesAnchor = (environment: { agent_client_id: string; project_id: string | null }) =>
    environment.agent_client_id === context.agent_id
    && (environment.project_id ?? undefined) === context.project_id;
  const belongsToAnchor = problem.consumers.some(matchesAnchor)
    || problem.environment_results.some((result) => !result.closed && matchesAnchor(result.environment));
  return belongsToAnchor
    ? { status: "active", problem }
    : { status: "scope_changed" };
}

/**
 * 关系页回退状态（任务 5）：仅滚动、画布坐标等非 URL 状态走 session 存储，
 * 且必须按来源（scope）与历史条目双重隔离；可复现状态（skillId、筛选、
 * 类别、冲突 ID）一律由 URL 查询参数承载，不进入这里。
 */
export type RelationshipsReturnStateScope = "graph" | "decisions" | "governance";

export interface RelationshipsReturnState {
  filters?: Record<string, string>;
  /** 画布视口（平移/缩放）；仅图谱 scope 使用。 */
  viewport?: { x: number; y: number; zoom: number };
  /** 每个 Skill 图谱的用户拖拽节点坐标。 */
  dragPositions?: Record<string, { x: number; y: number }>;
  /** 图谱的纯展示开关；仅 graph scope 使用。字段可选以兼容已有会话快照。 */
  display?: {
    showSources?: boolean;
    showAgentsProjects?: boolean;
    showDirectories?: boolean;
    showConflicts?: boolean;
  };
  /** 列表滚动位置；仅治理/冲突 scope 使用。 */
  scrollY?: number;
  /** 选中的行/边 ID；仅治理 scope 使用。 */
  selectedId?: string;
  /** 批量勾选的关系边 ID（任务 8）；仅治理 scope 使用。 */
  selectedIds?: string[];
}

const STORAGE_PREFIX = "skillhub:relationships:return-state";

export function relationshipsReturnStateStorageKey(
  scope: RelationshipsReturnStateScope,
  entryKey: string,
): string {
  return `${STORAGE_PREFIX}:${scope}:${entryKey}`;
}

/** 图谱偏好属于 Skill；其它关系页仍按历史条目隔离。 */
export function relationshipsReturnStateEntryKey(
  scope: RelationshipsReturnStateScope,
  locationEntryKey: string,
  stableSkillId?: string | null,
): string {
  return scope === "graph" && stableSkillId?.trim()
    ? `skill:${stableSkillId.trim()}`
    : locationEntryKey;
}

function readStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // 某些嵌入环境禁用 session 存储：回退状态静默退化为“不恢复”。
    return null;
  }
}

export function saveRelationshipsReturnState(
  scope: RelationshipsReturnStateScope,
  entryKey: string,
  state: RelationshipsReturnState,
): void {
  const store = readStore();
  store?.setItem(relationshipsReturnStateStorageKey(scope, entryKey), JSON.stringify(state));
}

export function readRelationshipsReturnState(
  scope: RelationshipsReturnStateScope,
  entryKey: string,
): RelationshipsReturnState | null {
  const store = readStore();
  const raw = store?.getItem(relationshipsReturnStateStorageKey(scope, entryKey));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as RelationshipsReturnState;
  } catch {
    return null;
  }
}

export function clearRelationshipsReturnState(
  scope: RelationshipsReturnStateScope,
  entryKey: string,
): void {
  readStore()?.removeItem(relationshipsReturnStateStorageKey(scope, entryKey));
}

export interface RelationshipsReturnStateControl {
  /** 当前历史条目键；保存/恢复都以它为隔离维度。 */
  entryKey: string;
  /** 挂载时可用的已保存状态（同一条目回退时非空）。 */
  initialState: RelationshipsReturnState | null;
  saveState: (state: RelationshipsReturnState) => void;
  clearState: () => void;
}

/** 页面级 hook：图谱/治理/冲突页用它保存与恢复各自的非 URL 视图状态。 */
export function useRelationshipsReturnState(
  scope: RelationshipsReturnStateScope,
  stableSkillId?: string | null,
): RelationshipsReturnStateControl {
  const location = useLocation();
  const entryKey = relationshipsReturnStateEntryKey(scope, location.key, stableSkillId);
  const initialState = useMemo(
    () => readRelationshipsReturnState(scope, entryKey),
    [scope, entryKey],
  );
  const saveState = useCallback(
    (state: RelationshipsReturnState) => saveRelationshipsReturnState(scope, entryKey, state),
    [scope, entryKey],
  );
  const clearState = useCallback(
    () => clearRelationshipsReturnState(scope, entryKey),
    [scope, entryKey],
  );
  return { entryKey, initialState, saveState, clearState };
}
