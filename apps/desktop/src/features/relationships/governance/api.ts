import type {
  RelationGovernanceBatchItem,
  RelationGovernanceBatchOutcome,
  RelationGovernanceBlocker,
  RelationGovernanceBucket,
  RelationGovernanceLedger,
  RelationGovernanceRow,
  RemovalImpactFact,
  RemovalResult,
} from "../../../api/bindings";
import type { RelationshipGovernanceParams } from "../api";

/**
 * 关系治理四桶（任务 3 契约）：all / eligible-to-centralize / needs-validation /
 * blocked 是同一份清单的快捷筛选，不是四个页面。
 */
export const GOVERNANCE_BUCKETS: RelationGovernanceBucket[] = [
  "all",
  "eligible_to_centralize",
  "needs_validation",
  "blocked",
];

const GOVERNANCE_SOURCES = [
  "library",
  "graph",
  "conflict",
  "agent",
  "project",
] as const;

/** 深链来源：治理页据此提供返回入口与初始筛选（?from=…）。 */
export type GovernanceSourceParam = (typeof GOVERNANCE_SOURCES)[number];

/** 共享影响确认令牌：后端只校验非空；事实校验仍由四段安全链路负责。 */
export const SHARED_IMPACT_CONFIRMATION_TOKEN = "shared_impact_confirmed";

/** 单条「纳入集中库管理」复用批命令编排：一条关系也是一个批次。 */
export interface RelationGovernanceBatchRequest {
  relationIds: string[];
  /** relation_id → 非空确认令牌；仅共享影响需要显式确认的行需要。 */
  confirmations: Record<string, string>;
}

/** 单条「从 Agent/项目移除」的准备结果（deployment 命名空间）。 */
export interface RelationUndeployPreparation {
  relationId: string;
  deploymentId: string;
  operationId: string;
}

/**
 * 关系治理页面门面（任务 8）：读取任务 3 的清单 query 与编排命令。
 * 页面绝不越过门面直接触碰文件系统；所有执行经 runTrackedOperation 走桥。
 */
export interface RelationGovernanceFacade {
  listGovernance(params?: RelationshipGovernanceParams): Promise<RelationGovernanceLedger>;
  getRelationshipRemovalImpact(relationId: string): Promise<RemovalImpactFact>;
  prepareGovernanceBatch(request: RelationGovernanceBatchRequest): Promise<RelationGovernanceBatchOutcome>;
  commitGovernanceBatch(batchId: string, relationIds: string[]): Promise<RelationGovernanceBatchOutcome>;
  rollbackGovernanceBatch(batchId: string, relationIds: string[]): Promise<RelationGovernanceBatchOutcome>;
  prepareRelationUndeploy(relationId: string): Promise<RelationUndeployPreparation>;
  commitRelationUndeploy(operationId: string): Promise<RemovalResult>;
}

/** URL 是可复现状态的唯一载体：来源、桶、搜索与对象过滤都进查询参数。 */
export interface GovernanceDeepLink {
  from: GovernanceSourceParam | null;
  bucket: RelationGovernanceBucket;
  text: string;
  skillId: string | null;
  agentClientId: string | null;
  projectId: string | null;
  conflictId: string | null;
  relationId: string | null;
}

const SHARED_IMPACT_BLOCKER: RelationGovernanceBlocker = "shared_impact_confirmation_required";

/**
 * 行过滤参数只透传已提交的事实；未知来源/桶回退为“不过滤”，
 * 不让恶意或过期的 URL 制造查询错误。
 */
export function parseGovernanceSearchParams(searchParams: URLSearchParams): GovernanceDeepLink {
  const bucketParam = searchParams.get("bucket");
  const fromParam = searchParams.get("from");
  return {
    from: GOVERNANCE_SOURCES.find((candidate) => candidate === fromParam) ?? null,
    bucket: GOVERNANCE_BUCKETS.find((candidate) => candidate === bucketParam) ?? "all",
    text: searchParams.get("text") ?? "",
    skillId: searchParams.get("skillId"),
    agentClientId: searchParams.get("agent"),
    projectId: searchParams.get("project"),
    conflictId: searchParams.get("conflictId"),
    relationId: searchParams.get("relationId"),
  };
}

/** 仅差显式共享影响确认即可纳入集中库管理的行。 */
export function rowNeedsSharedImpactConfirmation(row: RelationGovernanceRow): boolean {
  return row.readiness === "needs_validation"
    && row.blockers.length > 0
    && row.blockers.every((blocker) => blocker === SHARED_IMPACT_BLOCKER);
}

/** 该行是否可被批量纳入集中库管理（与后端 batch_row_is_executable 对齐）。 */
export function rowIsBatchExecutable(row: RelationGovernanceRow): boolean {
  return row.readiness === "eligible_to_centralize" || rowNeedsSharedImpactConfirmation(row);
}

/** 行列表的批量摘要：可执行与受阻分开统计，任何受阻项都不计入可执行。 */
export function summarizeRowExecutability(rows: readonly RelationGovernanceRow[]): {
  executable: number;
  blocked: number;
} {
  let executable = 0;
  let blocked = 0;
  for (const row of rows) {
    if (rowIsBatchExecutable(row)) executable += 1;
    else blocked += 1;
  }
  return { executable, blocked };
}

/**
 * 批次结果的逐项文案 key（与 RelationGovernanceBatchItemState 对齐）。
 * rolled_back 单列：回退成功不是“已取消”，更不是“成功”。
 */
export function batchItemStateLabelKey(
  state: RelationGovernanceBatchItem["state"],
): string {
  switch (state) {
    case "committed":
      return "relationships.governance.batch.itemCommitted";
    case "failed":
      return "relationships.governance.batch.itemFailed";
    case "blocked":
      return "relationships.governance.batch.itemBlocked";
    case "rolled_back":
      return "relationships.governance.batch.itemRolledBack";
    case "prepared":
    case "cancelled":
    default:
      return "relationships.governance.batch.itemCancelled";
  }
}

/** 批次整体终态标题：partial/failed/cancelled 都不允许被汇总成成功。 */
export function batchResultTitleKey(state: RelationGovernanceBatchOutcome["state"]): string {
  switch (state) {
    case "committed":
      return "relationships.governance.batch.resultAll";
    case "partially_committed":
      return "relationships.governance.batch.resultPartial";
    case "cancelled":
      return "relationships.governance.batch.resultCancelled";
    case "failed":
    default:
      return "relationships.governance.batch.resultNone";
  }
}

/**
 * 把一次单项重跑（prepare+commit）的结果原位合并回批次结果：
 * 计数与终态都按合并后的事实重算，成功/失败/取消绝不互相冒充。
 */
export function mergeBatchItemOutcome(
  current: RelationGovernanceBatchOutcome,
  relationId: string,
  run: RelationGovernanceBatchOutcome,
): RelationGovernanceBatchOutcome {
  const replaced = run.items.find((item) => item.relation_id === relationId);
  if (!replaced) return current;
  const items = current.items.map(
    (item) => item.relation_id === relationId ? replaced : item,
  );
  const countBy = (state: RelationGovernanceBatchItem["state"]) =>
    items.filter((item) => item.state === state).length;
  const committed = countBy("committed");
  const failed = countBy("failed");
  // rolled_back 与 cancelled 一样“没有产生新的成功”，但逐项标签各自如实。
  const settled = items.filter(
    (item) => item.state === "cancelled" || item.state === "rolled_back",
  ).length;
  const state = failed > 0
    ? (committed > 0 ? "partially_committed" : "failed")
    : committed > 0
      ? "committed"
      : settled > 0 ? "cancelled" : current.state;
  return {
    ...current,
    items,
    committed_count: committed,
    failed_count: failed,
    cancelled_count: settled,
    state,
    relationship_revision: run.relationship_revision || current.relationship_revision,
  };
}
