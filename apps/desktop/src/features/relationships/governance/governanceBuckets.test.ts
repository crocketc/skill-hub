import { describe, expect, it } from "vitest";
import type {
  RelationGovernanceActionCondition,
  RelationGovernanceRow,
  RelationGovernanceState,
} from "../../../api/bindings";
import { rowIsBatchExecutable, rowIsNaturallyExecutable, rowNeedsSharedImpactConfirmation } from "./api";
import {
  GOVERNANCE_COMPLETED_BUCKETS,
  GOVERNANCE_PENDING_BUCKETS,
  completedBucketKeyOf,
  pendingBucketKeyOf,
  projectGovernanceBuckets,
} from "./governanceBuckets";

function row(
  relationId: string,
  governance: Partial<RelationGovernanceState> & Pick<RelationGovernanceState, "governance_status">,
): RelationGovernanceRow {
  return {
    relation: {
      kind: "deployment",
      fact: { relation_id: relationId },
    } as unknown as RelationGovernanceRow["relation"],
    skill_display_name: "Skill",
    status: "needs_validation",
    readiness: "needs_validation",
    primary_action: "revalidate",
    blockers: [],
    impact: {
      other_consumer_agent_ids: [],
      other_skill_paths: [],
      backup_required: false,
      rollback_available: false,
    },
    governance: {
      management_status: "not_taken_over",
      decision: "undecided",
      management_confirmed_at: null,
      health_reasons: [],
      action_conditions: [] as RelationGovernanceActionCondition[],
      ...governance,
    },
    target_identity: null,
    source_read_only: false,
    evidence_relation_ids: [relationId],
  };
}

describe("pendingBucketKeyOf（FB-④ §10 待处理细分桶）", () => {
  it("assigns each pending row to exactly one category by the documented priority", () => {
    // 原文件缺失优先于链接异常；链接异常优先于内容不同。
    expect(pendingBucketKeyOf(row("a", {
      governance_status: "pending",
      health_reasons: ["subject_unavailable", "link_replaced", "content_changed"],
    }))).toBe("source_missing");
    expect(pendingBucketKeyOf(row("b", {
      governance_status: "pending",
      health_reasons: ["link_target_unavailable", "content_changed"],
    }))).toBe("link_issue");
    expect(pendingBucketKeyOf(row("c", {
      governance_status: "pending",
      health_reasons: ["content_changed", "verification_required"],
    }))).toBe("content_changed");
    expect(pendingBucketKeyOf(row("d", {
      governance_status: "pending",
      health_reasons: ["verification_required"],
    }))).toBe("needs_review");
    expect(pendingBucketKeyOf(row("e", {
      governance_status: "pending",
      health_reasons: ["operation_failed"],
    }))).toBe("operation_failed");
    expect(pendingBucketKeyOf(row("f", {
      governance_status: "pending",
      health_reasons: ["permission_limited"],
    }))).toBe("restricted");
    expect(pendingBucketKeyOf(row("g", { governance_status: "pending" }))).toBe("undecided");
  });

  it("treats shared-impact confirmation as restricted even when health is clean", () => {
    // 共享影响确认只出现在动作条件里时同样归入权限受限桶。
    expect(pendingBucketKeyOf(row("h", {
      governance_status: "pending",
      action_conditions: [{
        action: "centralize_management",
        available: false,
        reasons: ["shared_impact_confirmation_required"],
      }],
    }))).toBe("restricted");
  });
});

describe("completedBucketKeyOf（FB-④ §10 已完成细分桶）", () => {
  it("splits retained independent copies from managed links", () => {
    expect(completedBucketKeyOf(row("i", {
      governance_status: "completed",
      decision: "retained_independent_copy",
    }))).toBe("retained");
    expect(completedBucketKeyOf(row("j", {
      governance_status: "completed",
      management_status: "taken_over",
    }))).toBe("managed_link");
  });
});

describe("projectGovernanceBuckets（FB-④ §10 细分桶投影）", () => {
  it("returns non-empty buckets in the fixed documented order and keeps row order", () => {
    const undecided = row("undecided-1", { governance_status: "pending" });
    const changed = row("changed-1", {
      governance_status: "pending",
      health_reasons: ["content_changed"],
    });
    const managed = row("managed-1", {
      governance_status: "completed",
      management_status: "taken_over",
    });
    const retained = row("retained-1", {
      governance_status: "completed",
      decision: "retained_independent_copy",
    });

    const projection = projectGovernanceBuckets([managed, undecided, retained, changed]);

    expect(projection.pending.map((bucket) => bucket.key)).toEqual([
      "undecided",
      "content_changed",
    ]);
    expect(projection.pending[0]!.rows).toEqual([undecided]);
    expect(projection.completed.map((bucket) => bucket.key)).toEqual([
      "managed_link",
      "retained",
    ]);
    // 空桶不出现；桶序固定不随数量变化。
    expect(GOVERNANCE_PENDING_BUCKETS).toContain("undecided");
    expect(GOVERNANCE_COMPLETED_BUCKETS).toEqual(["managed_link", "retained"]);
    expect(projection.pending.some((bucket) => bucket.key === "restricted")).toBe(false);
  });
});

describe("行可执行性仍由动作条件裁定（原 governanceProjection 契约）", () => {
  function legacyRow(
    relationId: string,
    governance: RelationGovernanceState,
    legacy: Pick<RelationGovernanceRow, "readiness" | "status" | "primary_action">,
  ): RelationGovernanceRow {
    return {
      ...row(relationId, { governance_status: governance.governance_status }),
      readiness: legacy.readiness,
      status: legacy.status,
      primary_action: legacy.primary_action,
      governance,
    };
  }

  function state(
    governance_status: RelationGovernanceState["governance_status"],
    management_status: RelationGovernanceState["management_status"],
    decision: RelationGovernanceState["decision"] = "undecided",
    health_reasons: RelationGovernanceState["health_reasons"] = [],
    action_conditions: RelationGovernanceActionCondition[] = [],
  ): RelationGovernanceState {
    return {
      governance_status,
      management_status,
      decision,
      management_confirmed_at: null,
      health_reasons,
      action_conditions,
    };
  }

  it("uses action conditions instead of legacy readiness for row and batch availability", () => {
    const allowed = legacyRow(
      "allowed-by-contract",
      state("pending", "not_taken_over", "undecided", [], [
        { action: "centralize_management", available: true, reasons: [] },
      ]),
      { readiness: "blocked", status: "blocked", primary_action: "none" },
    );
    const restricted = legacyRow(
      "restricted-by-contract",
      state("pending", "not_taken_over", "undecided", [], [
        { action: "centralize_management", available: false, reasons: ["permission_limited"] },
      ]),
      { readiness: "eligible_to_centralize", status: "normal", primary_action: "centralize_management" },
    );
    const confirmationOnly = legacyRow(
      "confirmation-by-contract",
      state("pending", "not_taken_over", "undecided", [], [
        {
          action: "centralize_management",
          available: false,
          reasons: ["shared_impact_confirmation_required"],
        },
      ]),
      { readiness: "already_centralized", status: "blocked", primary_action: "none" },
    );

    expect(rowIsBatchExecutable(allowed)).toBe(true);
    expect(rowIsNaturallyExecutable(allowed)).toBe(true);
    expect(rowIsBatchExecutable(restricted)).toBe(false);
    expect(rowIsNaturallyExecutable(restricted)).toBe(false);
    expect(rowNeedsSharedImpactConfirmation(confirmationOnly)).toBe(true);
  });
});
