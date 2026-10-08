import type { UsageHealthReason } from "../../../api/bindings";
import {
  classifyUsageRelation,
  type UsageGovernanceRow,
} from "../../relationshipGovernance/relationshipGovernance";

export type GovernancePendingBucketKey =
  | "unmanaged"
  | "file_missing"
  | "link_abnormal"
  | "content_changed"
  | "needs_sync"
  | "sync_failed"
  | "unable_to_verify"
  | "user_confirmation"
  | "restricted";

export type GovernanceNoActionBucketKey = "managed_usage" | "builtin_original";
/** Kept as an export alias for existing consumers during the terminology transition. */
export type GovernanceCompletedBucketKey = GovernanceNoActionBucketKey;
export type GovernanceBucketKey = GovernancePendingBucketKey | GovernanceNoActionBucketKey;

export interface GovernanceBucket {
  key: GovernanceBucketKey;
  rows: UsageGovernanceRow[];
}

export interface GovernanceBucketProjection {
  pending: GovernanceBucket[];
  noAction: GovernanceBucket[];
}

export const GOVERNANCE_PENDING_BUCKETS: readonly GovernancePendingBucketKey[] = [
  "unmanaged",
  "file_missing",
  "link_abnormal",
  "content_changed",
  "needs_sync",
  "sync_failed",
  "unable_to_verify",
  "user_confirmation",
  "restricted",
];

export const GOVERNANCE_NO_ACTION_BUCKETS: readonly GovernanceNoActionBucketKey[] = [
  "managed_usage",
  "builtin_original",
];
/** Kept as an export alias; these buckets now contain healthy active usage only. */
export const GOVERNANCE_COMPLETED_BUCKETS = GOVERNANCE_NO_ACTION_BUCKETS;

const HEALTH_PRIORITY: readonly Exclude<UsageHealthReason, "normal">[] = [
  "user_confirmation",
  "file_missing",
  "link_abnormal",
  "content_changed",
  "sync_failed",
  "needs_sync",
  "unable_to_verify",
];

export function pendingBucketKeyOf(row: UsageGovernanceRow): GovernancePendingBucketKey {
  const { usage } = row;
  const healthIssue = HEALTH_PRIORITY.find((reason) => usage.health_reasons.includes(reason));
  if (healthIssue) return healthIssue;
  if (usage.management === "unmanaged" && usage.target.directory_role !== "builtin") return "unmanaged";
  if (row.actionRestriction !== null) return "restricted";
  return "restricted";
}

/** Historical decisions are never projected into this active no-action bucket. */
export function completedBucketKeyOf(row: UsageGovernanceRow): GovernanceNoActionBucketKey {
  return row.usage.target.directory_role === "builtin" ? "builtin_original" : "managed_usage";
}

function projectBuckets<Key extends GovernanceBucketKey>(
  rows: readonly UsageGovernanceRow[],
  order: readonly Key[],
  keyOf: (row: UsageGovernanceRow) => Key,
): GovernanceBucket[] {
  const grouped = new Map<Key, UsageGovernanceRow[]>(
    order.map((key) => [key, [] as UsageGovernanceRow[]]),
  );
  for (const row of rows) grouped.get(keyOf(row))!.push(row);
  return order
    .filter((key) => grouped.get(key)!.length > 0)
    .map((key) => ({ key, rows: grouped.get(key)! }));
}

/** One unified active usage fact appears once; released and independent copies stay in history. */
export function projectGovernanceBuckets(
  rows: readonly UsageGovernanceRow[],
): GovernanceBucketProjection {
  const pendingRows: UsageGovernanceRow[] = [];
  const noActionRows: UsageGovernanceRow[] = [];
  for (const row of rows) {
    const classification = classifyUsageRelation(row.usage);
    if (classification === "pending") pendingRows.push(row);
    else if (classification === "no_action") noActionRows.push(row);
  }
  return {
    pending: projectBuckets(pendingRows, GOVERNANCE_PENDING_BUCKETS, pendingBucketKeyOf),
    noAction: projectBuckets(noActionRows, GOVERNANCE_NO_ACTION_BUCKETS, completedBucketKeyOf),
  };
}
