import type {
  GovernanceHistoryPage,
  RelationGovernanceBatchAction,
  RelationGovernanceBatchItem,
  RelationGovernanceBatchOutcome,
  RelationGovernanceBlocker,
  RelationGovernanceBucket,
  RelationGovernanceLedger,
  RelationGovernanceRow,
  RelationshipCheckLevel,
  RelationshipCheckReport,
  RemovalImpactFact,
  RemovalResult,
  SourceCopyRelationFact,
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
  "import",
  "graph",
  "conflict",
  "agent",
  "project",
] as const;

/** 深链来源：治理页据此提供返回入口与初始筛选（?from=…）。 */
export type GovernanceSourceParam = (typeof GOVERNANCE_SOURCES)[number];

/**
 * 行类别过滤（计划 9.5）：scope=source_copy 只看来源副本行，
 * scope=deployment 只看部署边；未知值回退为不过滤。
 */
const GOVERNANCE_SCOPES = ["all", "source_copy", "deployment"] as const;
export type GovernanceScopeParam = (typeof GOVERNANCE_SCOPES)[number];

/** 行状态过滤候选（与 GovernableRelationStatus 词表对齐）。 */
const GOVERNANCE_STATUSES = [
  "normal",
  "retained",
  "needs_validation",
  "needs_attention",
  "blocked",
] as const;

/** 共享影响确认令牌：后端只校验非空；事实校验仍由四段安全链路负责。 */
export const SHARED_IMPACT_CONFIRMATION_TOKEN = "shared_impact_confirmed";

/**
 * 批次动作（计划 8.16）：部署转换沿用 centralize_management；来源副本
 * 批次用 retain_source_copy / clean_source_copy，后端按 action 分派到
 * 各自的单条状态机。
 */
export type RelationGovernanceBatchActionParam = RelationGovernanceBatchAction;

/** 单条批命令编排：一条关系也是一个批次。 */
export interface RelationGovernanceBatchRequest {
  /** 批次动作决定逐行走哪条单条状态机；前端不自行编排文件系统操作。 */
  action: RelationGovernanceBatchActionParam;
  relationIds: string[];
  /** relation_id → 非空确认令牌；共享影响确认与来源清理确认都走这里。 */
  confirmations: Record<string, string>;
}

/** 单条「从 Agent/项目移除」的准备结果（deployment 命名空间）。 */
export interface RelationUndeployPreparation {
  relationId: string;
  deploymentId: string;
  operationId: string;
}

/**
 * 行类别（计划 9.9）：scope 判定只能读生成 DTO 的 kind 字段，
 * 绝不通过 relation_id 前缀猜测。
 */
export type GovernableRelation = import("../../../api/bindings").GovernableRelationFact;

/** 行身份：两类关系各自 DTO 里的 relation_id（计划 9.9 统一收窄入口）。 */
export function relationIdOf(relation: GovernableRelation): string {
  return relation.fact.relation_id;
}

/** 行的目标路径：部署边是部署路径，来源副本是来源目录。 */
export function relationPathOf(relation: GovernableRelation): string {
  return relation.kind === "deployment" ? relation.fact.path : relation.fact.source_path;
}

/** 行的 Skill；来源副本恒有，部署边可能为空。 */
export function relationSkillIdOf(relation: GovernableRelation): string | null {
  return relation.fact.skill_id;
}

/** 行的 Agent：来源副本可能没有单一 Agent（共享目录等）。 */
export function relationAgentIdOf(relation: GovernableRelation): string | null {
  return relation.kind === "deployment" ? relation.fact.agent_client_id : relation.fact.agent_client_id;
}

/** 关系展示键：部署边用 relationship 词表；来源副本统一为 source_copy。 */
export function relationshipKeyOf(relation: GovernableRelation): string {
  return relation.kind === "deployment" ? relation.fact.relationship : "source_copy";
}

/** 来源词表键：部署边用 origin；来源副本用 source_class。 */
export function relationSourceKeyOf(relation: GovernableRelation): string {
  return relation.kind === "deployment" ? relation.fact.origin : relation.fact.source_class;
}

/** 核验词表键：部署边用 match_state；来源副本用 health。 */
export function relationVerificationKeyOf(relation: GovernableRelation): string {
  return relation.kind === "deployment" ? relation.fact.match_state : relation.fact.health;
}

/** 是否为可执行「从 Agent/项目移除」的部署边（DTO 判定，非前缀猜测）。 */
export function isUndeployableDeployment(relation: GovernableRelation): boolean {
  return relation.kind === "deployment";
}

/** 治理历史分页查询参数（独立只读查询；驼峰命名，native 层转生成契约）。 */
export interface GovernanceHistoryParams {
  page?: number;
  pageSize?: number;
  relationId?: string | null;
  skillId?: string | null;
  agentClientId?: string | null;
  projectId?: string | null;
  result?: string | null;
}

/**
 * 关系治理页面门面（任务 8）：读取任务 3 的清单 query 与编排命令。
 * 页面绝不越过门面直接触碰文件系统；所有执行经 runTrackedOperation 走桥。
 */
export interface RelationGovernanceFacade {
  listGovernance(params?: RelationshipGovernanceParams): Promise<RelationGovernanceLedger>;
  /** 计划 9.4：重校验走 RunRelationshipCheck 命令，而不是再查一次清单。 */
  revalidate(
    relationIds: string[],
    level?: RelationshipCheckLevel,
  ): Promise<RelationshipCheckReport>;
  /** 计划 9.4：治理历史是独立分页查询，只读写入时固化的显示快照。 */
  listHistory(params: GovernanceHistoryParams): Promise<GovernanceHistoryPage>;
  /** 计划 8.15：保留来源副本——只改决策并记历史，绝不触碰来源目录。 */
  retainSourceCopy(relationId: string): Promise<SourceCopyRelationFact>;
  /**
   * 计划 8.8/8.15：重关联——ExternalRemoved 关系指向用户经目录 picker
   * 授权的新目录；身份/内容校验与槽位冲突判定都在后端。
   */
  relinkSourceCopy(relationId: string, newSourcePath: string): Promise<SourceCopyRelationFact>;
  getRelationshipRemovalImpact(relationId: string): Promise<RemovalImpactFact>;
  prepareGovernanceBatch(request: RelationGovernanceBatchRequest): Promise<RelationGovernanceBatchOutcome>;
  commitGovernanceBatch(batchId: string, relationIds: string[]): Promise<RelationGovernanceBatchOutcome>;
  rollbackGovernanceBatch(batchId: string, relationIds: string[]): Promise<RelationGovernanceBatchOutcome>;
  prepareRelationUndeploy(relation: GovernableRelation): Promise<RelationUndeployPreparation>;
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
  /** 行类别过滤（计划 9.5）：source_copy / deployment / all。 */
  scope: GovernanceScopeParam;
  /** 行状态过滤（计划 9.5）：五状态词表之外的值忽略。 */
  status: (typeof GOVERNANCE_STATUSES)[number] | null;
  /** 导入批次过滤（计划 9.5）：只显示该批次映射的关系。 */
  batchId: string | null;
}

const SHARED_IMPACT_BLOCKER: RelationGovernanceBlocker = "shared_impact_confirmation_required";

/**
 * 行过滤参数只透传已提交的事实；未知来源/桶/scope/状态回退为“不过滤”，
 * 不让恶意或过期的 URL 制造查询错误。
 */
export function parseGovernanceSearchParams(searchParams: URLSearchParams): GovernanceDeepLink {
  const bucketParam = searchParams.get("bucket");
  const fromParam = searchParams.get("from");
  const scopeParam = searchParams.get("scope");
  const statusParam = searchParams.get("status");
  return {
    from: GOVERNANCE_SOURCES.find((candidate) => candidate === fromParam) ?? null,
    bucket: GOVERNANCE_BUCKETS.find((candidate) => candidate === bucketParam) ?? "all",
    text: searchParams.get("text") ?? "",
    skillId: searchParams.get("skillId"),
    agentClientId: searchParams.get("agent"),
    projectId: searchParams.get("project"),
    conflictId: searchParams.get("conflictId"),
    relationId: searchParams.get("relationId"),
    scope: GOVERNANCE_SCOPES.find((candidate) => candidate === scopeParam) ?? "all",
    status: GOVERNANCE_STATUSES.find((candidate) => candidate === statusParam) ?? null,
    batchId: searchParams.get("batch"),
  };
}

/** 仅差显式共享影响确认即可纳入集中库管理的行。 */
export function rowNeedsSharedImpactConfirmation(row: RelationGovernanceRow): boolean {
  return row.readiness === "needs_validation"
    && row.blockers.length > 0
    && row.blockers.every((blocker) => blocker === SHARED_IMPACT_BLOCKER);
}

/** 来源副本动作的可用性：hidden 不出按钮，disabled 出但先校验。 */
export type SourceCopyActionAvailability = "enabled" | "disabled" | "hidden";

function sourceCopyEdgeAvailability(row: RelationGovernanceRow): SourceCopyActionAvailability {
  if (row.relation.kind !== "source_copy") return "hidden";
  // 受阻行只展示原因，不提供危险提交（任务 11.7）。
  if (row.status === "blocked") return "hidden";
  // 存证不是指纹一致：先重新检查，再清理/保留。
  return row.relation.fact.health === "normal" ? "enabled" : "disabled";
}

/** 清理来源副本：pending 与 retained 都可清理。 */
export function sourceCopyCleanAvailability(row: RelationGovernanceRow): SourceCopyActionAvailability {
  return sourceCopyEdgeAvailability(row);
}

/** 保留来源副本：仅 pending 提供；retained 已是保留态，不再重复出卡。 */
export function sourceCopyRetainAvailability(row: RelationGovernanceRow): SourceCopyActionAvailability {
  if (row.relation.kind !== "source_copy") return "hidden";
  if (row.relation.fact.decision === "retained" || row.status === "retained") return "hidden";
  return sourceCopyEdgeAvailability(row);
}

/** 一个批次只处理一类关系边、只执行一个动作（任务 11.10/11.15）。 */
export type BatchSelectionSummary =
  | { kind: "empty"; action: null }
  | { kind: "mixed"; action: null }
  | { kind: "source_copy"; action: "clean_source_copy" }
  | { kind: "deployment"; action: "centralize_management" };

export function summarizeBatchSelection(
  rows: readonly RelationGovernanceRow[],
): BatchSelectionSummary {
  const kinds = new Set(rows.map((row) => row.relation.kind));
  if (kinds.size === 0) return { kind: "empty", action: null };
  if (kinds.size > 1) return { kind: "mixed", action: null };
  return kinds.has("source_copy")
    ? { kind: "source_copy", action: "clean_source_copy" }
    : { kind: "deployment", action: "centralize_management" };
}

/** 行在当前批次动作下的可执行性：部署沿用既有判定，来源副本要求健康。 */
export function rowIsBatchExecutableFor(
  row: RelationGovernanceRow,
  kind: BatchSelectionSummary["kind"],
): boolean {
  if (kind === "source_copy") {
    return rowIsNaturallyExecutable(row);
  }
  return rowIsBatchExecutable(row);
}

/** 行按自身类别可执行：部署走 centralize 判定，来源副本要求健康可清理。 */
export function rowIsNaturallyExecutable(row: RelationGovernanceRow): boolean {
  return row.relation.kind === "source_copy"
    ? row.status !== "blocked" && row.relation.fact.health === "normal"
    : rowIsBatchExecutable(row);
}

/** 该行是否可被批量纳入集中库管理（与后端 batch_row_is_executable 对齐）。 */
export function rowIsBatchExecutable(row: RelationGovernanceRow): boolean {
  return row.readiness === "eligible_to_centralize" || rowNeedsSharedImpactConfirmation(row);
}

/** 行列表的批量摘要：可执行与受阻分开统计，任何受阻项都不计入可执行。
 *  可执行性按行自身类别判定（任务 11.15：来源副本要求健康可清理）。 */
export function summarizeRowExecutability(rows: readonly RelationGovernanceRow[]): {
  executable: number;
  blocked: number;
} {
  let executable = 0;
  let blocked = 0;
  for (const row of rows) {
    if (rowIsNaturallyExecutable(row)) executable += 1;
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
