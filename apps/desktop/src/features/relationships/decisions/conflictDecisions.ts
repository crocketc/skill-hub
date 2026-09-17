import type {
  AnalyzeConflictScope,
  ConflictClassification,
  ConflictDecision,
  ConflictKind,
} from "../../../api/bindings";

/**
 * 冲突处理工作台的纯视图助手（任务 7）。只重排/映射任务 2 的 DTO 事实，
 * 不推断、不请求、不写任何东西；文案落点统一在 relationships.decisions.*。
 */

/** 「纳入集中库管理」的治理预览意图：冻结格式，绝不携带决定本身。 */
export function conflictGovernanceHref(handoff: {
  conflictId: string;
  /** 仅在确实知道关系边时携带；未知时省略，绝不伪造（DTO 契约注释）。 */
  relationId?: string | null;
}): string {
  // 冒号是后端 id 的分隔符且在 query 中合法，保留原样以维持冻结的可读格式；
  // 其余保留 encodeURIComponent 的转义（& = 空格等仍安全）。
  const encode = (value: string) => encodeURIComponent(value).replace(/%3A/gi, ":");
  const parts = ["from=conflict", `conflictId=${encode(handoff.conflictId)}`];
  if (handoff.relationId) {
    parts.push(`relationId=${encode(handoff.relationId)}`);
  }
  return `/relationships/governance?${parts.join("&")}`;
}

/** 冲突处理工作台深链：旧面板据此跳转，不再自建 AI 冲突入口。 */
export function conflictWorkspaceHref(conflictId?: string | null): string {
  if (!conflictId) return "/relationships/decisions";
  const encoded = encodeURIComponent(conflictId).replace(/%3A/gi, ":");
  return `/relationships/decisions?conflictId=${encoded}`;
}

/** 三个 AI 分析范围（设计 §3.4：全部/分类/冲突组）。 */
export function allConflictScope(): AnalyzeConflictScope {
  return { type: "all" };
}

export function categoryConflictScope(
  classification: ConflictClassification,
): AnalyzeConflictScope {
  return { type: "category", value: { classification } };
}

export function caseConflictScope(conflictId: string): AnalyzeConflictScope {
  return { type: "case", value: { conflict_id: conflictId } };
}

/** 队列条目的最小结构视图：助手只消费 conflict_id/kind 两个事实。 */
export interface ConflictQueueEntryLike {
  case: { conflict_id: string; kind?: ConflictKind };
}

/** 冲突类别组：kind 缺省按「其他冲突」归组，不冒充分类事实。 */
export function conflictKindGroup(entry: ConflictQueueEntryLike): ConflictKind {
  return entry.case.kind ?? "unknown";
}

/** 队列里当前类别的全部 kind 值（按首次出现顺序，供类别 chip 渲染）。 */
export function queueKindValues(cases: readonly ConflictQueueEntryLike[]): ConflictKind[] {
  const seen: ConflictKind[] = [];
  for (const entry of cases) {
    const kind = conflictKindGroup(entry);
    if (!seen.includes(kind)) seen.push(kind);
  }
  return seen;
}

export type ConflictQueueDirection = "prev" | "next";

/** 在给定队列内前后移动；越界返回 null（按钮据此禁用）。 */
export function nextConflictId(
  queue: readonly ConflictQueueEntryLike[],
  currentId: string | null,
  direction: ConflictQueueDirection,
): string | null {
  if (queue.length === 0) return null;
  const index = currentId ? queue.findIndex((entry) => entry.case.conflict_id === currentId) : -1;
  const nextIndex = direction === "next"
    ? (index < 0 ? 0 : index + 1)
    : (index < 0 ? -1 : index - 1);
  if (nextIndex < 0 || nextIndex >= queue.length) return null;
  return queue[nextIndex].case.conflict_id;
}

/** 决定的用户层文案键（历史记录与「按建议」共用一套词汇）。 */
export function conflictDecisionLabelKey(decision: ConflictDecision): string {
  return `relationships.decisions.decision.${decision}`;
}
