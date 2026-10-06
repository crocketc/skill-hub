import type { RelationGovernanceReason, RelationGovernanceRow } from "../../../api/bindings";
import { governanceReasonKeys } from "./api";

/**
 * FB-④（2026-10-06 §10）桶内细分：一类关系一桶，同桶同操作，支持整桶
 * 勾选批量。待处理按「尚未作决定 / 两边内容不同 / 原文件缺失 / 使用链接
 * 异常」等分类分桶；已完成按「正常受管链接 / 已保留独立副本」分桶。分类
 * 只从后端治理事实（健康原因、动作条件、决定）推导，前端不新增状态。
 */
export type GovernancePendingBucketKey =
  | "undecided"
  | "content_changed"
  | "source_missing"
  | "link_issue"
  | "needs_review"
  | "operation_failed"
  | "restricted";

export type GovernanceCompletedBucketKey = "managed_link" | "retained";

export type GovernanceBucketKey = GovernancePendingBucketKey | GovernanceCompletedBucketKey;

export interface GovernanceBucket {
  key: GovernanceBucketKey;
  rows: RelationGovernanceRow[];
}

export interface GovernanceBucketProjection {
  pending: GovernanceBucket[];
  completed: GovernanceBucket[];
}

/** 桶的展示顺序固定；空桶由投影直接省略。 */
export const GOVERNANCE_PENDING_BUCKETS: readonly GovernancePendingBucketKey[] = [
  "undecided",
  "content_changed",
  "source_missing",
  "link_issue",
  "needs_review",
  "operation_failed",
  "restricted",
];

export const GOVERNANCE_COMPLETED_BUCKETS: readonly GovernanceCompletedBucketKey[] = [
  "managed_link",
  "retained",
];

const SUBJECT_MISSING_REASONS: ReadonlySet<RelationGovernanceReason> = new Set([
  "subject_unavailable",
]);

const LINK_ISSUE_REASONS: ReadonlySet<RelationGovernanceReason> = new Set([
  "link_target_unavailable",
  "link_replaced",
]);

const CONTENT_CHANGED_REASONS: ReadonlySet<RelationGovernanceReason> = new Set([
  "content_changed",
]);

const REVIEW_REASONS: ReadonlySet<RelationGovernanceReason> = new Set([
  "verification_required",
  "target_identity_unconfirmed",
]);

const OPERATION_FAILED_REASONS: ReadonlySet<RelationGovernanceReason> = new Set([
  "operation_failed",
]);

const RESTRICTED_REASONS: ReadonlySet<RelationGovernanceReason> = new Set([
  "managed_entry_requires_verified_removal",
  "managed_target_occupied",
  "permission_limited",
  "relationship_not_convertible",
  "shared_impact_confirmation_required",
]);

/**
 * 待处理行的归类优先级与行内摘要徽标（presentGovernanceState）一致：
 * 原文件缺失 → 链接异常 → 内容不同 → 待核验 → 操作失败 → 权限受限。
 * 权限受限同时读健康原因与不可用动作的原因（如仅差共享影响确认）。
 */
export function pendingBucketKeyOf(row: RelationGovernanceRow): GovernancePendingBucketKey {
  const health = row.governance.health_reasons;
  const has = (reasons: ReadonlySet<RelationGovernanceReason>, keys: readonly RelationGovernanceReason[]) =>
    keys.some((reason) => reasons.has(reason));
  if (has(SUBJECT_MISSING_REASONS, health)) return "source_missing";
  if (has(LINK_ISSUE_REASONS, health)) return "link_issue";
  if (has(CONTENT_CHANGED_REASONS, health)) return "content_changed";
  if (has(REVIEW_REASONS, health)) return "needs_review";
  if (has(OPERATION_FAILED_REASONS, health)) return "operation_failed";
  if (has(RESTRICTED_REASONS, governanceReasonKeys(row))) return "restricted";
  return "undecided";
}

/** 已完成行：保留决定进「已保留独立副本」，其余受管链接进「正常受管链接」。 */
export function completedBucketKeyOf(row: RelationGovernanceRow): GovernanceCompletedBucketKey {
  return row.governance.decision === "retained_independent_copy" ? "retained" : "managed_link";
}

function projectBuckets<Key extends GovernanceBucketKey>(
  rows: readonly RelationGovernanceRow[],
  order: readonly Key[],
  keyOf: (row: RelationGovernanceRow) => Key,
): GovernanceBucket[] {
  const grouped = new Map<Key, RelationGovernanceRow[]>(
    order.map((key) => [key, [] as RelationGovernanceRow[]]),
  );
  for (const row of rows) {
    grouped.get(keyOf(row))!.push(row);
  }
  return order
    .filter((key) => grouped.get(key)!.length > 0)
    .map((key) => ({ key, rows: grouped.get(key)! }));
}

/** 把当前清单行投影成固定顺序、只含非空桶的细分桶列表。
 *  列归属仍由后端 governance_status 唯一决定；细分桶只在同列内部排序。 */
export function projectGovernanceBuckets(
  rows: readonly RelationGovernanceRow[],
): GovernanceBucketProjection {
  const pendingRows: RelationGovernanceRow[] = [];
  const completedRows: RelationGovernanceRow[] = [];
  for (const row of rows) {
    if (row.governance.governance_status === "completed") completedRows.push(row);
    else pendingRows.push(row);
  }
  return {
    pending: projectBuckets(pendingRows, GOVERNANCE_PENDING_BUCKETS, pendingBucketKeyOf),
    completed: projectBuckets(completedRows, GOVERNANCE_COMPLETED_BUCKETS, completedBucketKeyOf),
  };
}
