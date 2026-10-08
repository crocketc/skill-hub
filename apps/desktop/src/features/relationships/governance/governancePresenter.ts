import type {
  RelationGovernanceReason,
  RelationGovernanceRow,
  UsageHealthReason,
  UsageRelationView,
} from "../../../api/bindings";
import { classifyUsageRelation } from "../../relationshipGovernance/relationshipGovernance";

export type GovernancePresentationTone = "success" | "warning" | "danger";

export interface GovernanceRowPresentation {
  classificationKey: string;
  managementKey: string;
  decisionKey: string | null;
  summaryKey: string;
  descriptionKey: string;
  reasonKeys: Array<RelationGovernanceReason | UsageHealthReason>;
  formKey?: string | null;
  tone: GovernancePresentationTone;
}

export interface LegacyGovernanceRowPresentation extends Omit<GovernanceRowPresentation, "reasonKeys"> {
  reasonKeys: RelationGovernanceReason[];
}

const LINK_ISSUES = new Set<RelationGovernanceReason>([
  "link_target_unavailable",
  "link_replaced",
  "subject_unavailable",
]);

const REVIEW_REASONS = new Set<RelationGovernanceReason>([
  "verification_required",
  "target_identity_unconfirmed",
]);

const RESTRICTED_REASONS = new Set<RelationGovernanceReason>([
  "permission_limited",
  "managed_target_occupied",
  "relationship_not_convertible",
  "shared_impact_confirmation_required",
  "managed_entry_requires_verified_removal",
]);

/**
 * Converts the backend's three-layer fact into user language shared by the
 * governance board, table and relationship graph.
 */
export function presentGovernanceRow(view: UsageRelationView): GovernanceRowPresentation {
  const reasonKeys = view.health_reasons.length > 0
    ? view.health_reasons
    : ["unable_to_verify" as const];
  const summary = usageSummary(view, reasonKeys);
  const tone = usageTone(summary);
  const classification = classifyUsageRelation(view) ?? "pending";
  return {
    classificationKey: `relationships.governance.classification.${classification}`,
    managementKey: `relationships.governance.usageManagement.${view.management}`,
    decisionKey: null,
    summaryKey: `relationships.governance.shortName.${summary}`,
    descriptionKey: `relationships.governance.shortName.${summary}Description`,
    reasonKeys,
    formKey: view.form ? `relationships.governance.form.${view.form}` : null,
    tone,
  };
}

export function presentGovernanceState(
  governance: RelationGovernanceRow["governance"],
  reasonKeys: RelationGovernanceReason[] = governance.health_reasons,
): LegacyGovernanceRowPresentation {
  const healthReasons = governance.health_reasons;
  let summary: string;
  let tone: GovernancePresentationTone;

  if (healthReasons.some((reason) => LINK_ISSUES.has(reason))) {
    summary = "link_issue";
    tone = "danger";
  } else if (healthReasons.includes("content_changed")) {
    summary = "content_changed";
    tone = "warning";
  } else if (healthReasons.some((reason) => REVIEW_REASONS.has(reason))) {
    summary = "needs_review";
    tone = "warning";
  } else if (healthReasons.includes("operation_failed")) {
    summary = "operation_failed";
    tone = "danger";
  } else if (healthReasons.some((reason) => RESTRICTED_REASONS.has(reason))) {
    summary = "restricted";
    tone = "warning";
  } else if (
    governance.governance_status === "completed"
    && governance.decision === "retained_independent_copy"
  ) {
    summary = "retained";
    tone = "success";
  } else if (governance.management_status === "taken_over") {
    summary = "taken_over";
    tone = "success";
  } else if (governance.governance_status === "pending") {
    summary = "not_taken_over";
    tone = "warning";
  } else {
    summary = "completed";
    tone = "success";
  }

  return {
    classificationKey: `relationships.governance.classification.${governance.governance_status}`,
    managementKey: `relationships.governance.management.${governance.management_status}`,
    decisionKey: governance.decision === "retained_independent_copy"
      ? "relationships.governance.decision.retained_independent_copy"
      : null,
    summaryKey: `relationships.governance.shortName.${summary}`,
    descriptionKey: `relationships.governance.shortName.${summary}Description`,
    reasonKeys,
    tone,
  };
}

function usageSummary(
  view: UsageRelationView,
  reasons: readonly UsageHealthReason[],
): string {
  if (
    classifyUsageRelation(view) === "no_action"
    && view.target.directory_role === "builtin"
  ) return "builtin_original";
  const priority: readonly UsageHealthReason[] = [
    "user_confirmation",
    "link_abnormal",
    "file_missing",
    "content_changed",
    "sync_failed",
    "needs_sync",
    "unable_to_verify",
  ];
  const issue = priority.find((reason) => reasons.includes(reason));
  if (issue) return issue;
  if (view.management === "unmanaged") return "unmanaged";
  return "healthy";
}

function usageTone(summary: string): GovernancePresentationTone {
  if (["link_abnormal", "file_missing", "sync_failed"].includes(summary)) return "danger";
  if (summary === "healthy") return "success";
  return "warning";
}

export function governanceReasonLabelKey(reason: RelationGovernanceReason): string {
  return `relationships.governance.reasonMessages.${reason}`;
}

export function usageHealthLabelKey(reason: UsageHealthReason): string {
  return `relationships.governance.healthMessages.${reason}`;
}
