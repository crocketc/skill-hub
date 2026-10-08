import { describe, expect, it } from "vitest";
import type {
  RelationGovernanceActionCondition,
  RelationGovernanceRow,
  RelationGovernanceState,
  UsageHealthReason,
  UsageRelationView,
} from "../../../api/bindings";
import { projectUsageGovernanceRows } from "../../relationshipGovernance/relationshipGovernance";
import { rowIsBatchExecutable, rowIsNaturallyExecutable, rowNeedsSharedImpactConfirmation } from "./api";
import {
  GOVERNANCE_NO_ACTION_BUCKETS,
  GOVERNANCE_PENDING_BUCKETS,
  completedBucketKeyOf,
  pendingBucketKeyOf,
  projectGovernanceBuckets,
} from "./governanceBuckets";

function usageView(overrides: Partial<UsageRelationView> = {}): UsageRelationView {
  return {
    relation_id: "usage-1",
    skill_id: "skill-1",
    target: {
      kind: "agent",
      directory_id: "directory-1",
      agent_client_id: "codex-cli",
      directory_role: "agent_user",
      recognition: "supported",
    },
    entry_key: { directory_id: "directory-1", relative_entry_path: "skill-a" },
    form: "full_copy",
    management: "unmanaged",
    health_reasons: ["normal"],
    decision: null,
    decision_history_ids: [],
    active: true,
    file_representation: "directory",
    link_target_path: null,
    link_target_path_key: null,
    link_target_directory_id: null,
    physical_source_ids_evidence: [],
    evidence_relation_ids: [],
    ...overrides,
  };
}

function projected(view: UsageRelationView) {
  return projectUsageGovernanceRows([view], []);
}

describe("统一使用关系治理桶", () => {
  it("normal_unmanaged_requires_action", () => {
    const normalUnmanaged = projected(usageView())[0]!;
    const projection = projectGovernanceBuckets([normalUnmanaged]);

    expect(pendingBucketKeyOf(normalUnmanaged)).toBe("unmanaged");
    expect(projection.pending.flatMap((bucket) => bucket.rows)).toContain(normalUnmanaged);
    expect(projection.noAction).toEqual([]);
  });

  it("healthy_builtin_needs_no_action", () => {
    const builtin = projected(usageView({
      target: { ...usageView().target, directory_role: "builtin" },
    }))[0]!;
    const projection = projectGovernanceBuckets([builtin]);

    expect(completedBucketKeyOf(builtin)).toBe("builtin_original");
    expect(projection.noAction.flatMap((bucket) => bucket.rows)).toContain(builtin);
    expect(builtin.usage.decision).not.toBe("retained_independent_copy");
  });

  it("released_copy_is_history_only", () => {
    const released = usageView({ active: false, decision: "released" });
    const retained = usageView({ relation_id: "retained", active: false, decision: "retained_independent_copy" });
    const rows = projectUsageGovernanceRows([released, retained], []);
    const projection = projectGovernanceBuckets(rows);

    expect(rows).toEqual([]);
    expect(projection.pending).toEqual([]);
    expect(projection.noAction).toEqual([]);
  });

  it("maps every health cause to a pending bucket without dropping the full health list", () => {
    const reasons: UsageHealthReason[] = [
      "file_missing",
      "link_abnormal",
      "content_changed",
      "needs_sync",
      "sync_failed",
      "unable_to_verify",
      "user_confirmation",
    ];
    for (const reason of reasons) {
      const row = projected(usageView({ health_reasons: [reason] }))[0]!;
      expect(pendingBucketKeyOf(row)).toBe(reason);
    }
    const multiple = usageView({ health_reasons: ["file_missing", "needs_sync"] });
    const [row] = projected(multiple);
    expect(pendingBucketKeyOf(row!)).toBe("file_missing");
    expect(row!.usage.health_reasons).toEqual(["file_missing", "needs_sync"]);
  });

  it("returns non-empty buckets in fixed order", () => {
    const unmanaged = projected(usageView({ relation_id: "unmanaged" }))[0]!;
    const missing = projected(usageView({ relation_id: "missing", health_reasons: ["file_missing"] }))[0]!;
    const managed = projected(usageView({
      relation_id: "managed",
      management: "managed",
    }))[0]!;
    const projection = projectGovernanceBuckets([managed, unmanaged, missing]);

    expect(projection.pending.map((bucket) => bucket.key)).toEqual(["unmanaged", "file_missing"]);
    expect(projection.noAction.map((bucket) => bucket.key)).toEqual(["managed_usage"]);
    expect(GOVERNANCE_PENDING_BUCKETS).toContain("user_confirmation");
    expect(GOVERNANCE_NO_ACTION_BUCKETS).toEqual(["managed_usage", "builtin_original"]);
  });
});

describe("旧 action condition 仍只决定旧动作是否可用", () => {
  function row(relationId: string, governance: RelationGovernanceState): RelationGovernanceRow {
    return {
      relation: { kind: "deployment", fact: { relation_id: relationId } } as unknown as RelationGovernanceRow["relation"],
      skill_display_name: "Skill",
      status: "needs_validation",
      readiness: "needs_validation",
      primary_action: "none",
      blockers: [],
      impact: { other_consumer_agent_ids: [], other_skill_paths: [], backup_required: false, rollback_available: false },
      governance,
      target_identity: null,
      source_read_only: false,
      evidence_relation_ids: [relationId],
    };
  }

  function state(
    governance_status: RelationGovernanceState["governance_status"],
    management_status: RelationGovernanceState["management_status"],
    health_reasons: RelationGovernanceState["health_reasons"] = [],
    action_conditions: RelationGovernanceActionCondition[] = [],
  ): RelationGovernanceState {
    return {
      governance_status,
      management_status,
      decision: "undecided",
      management_confirmed_at: null,
      health_reasons,
      action_conditions,
    };
  }

  it("uses action conditions instead of legacy readiness for row and batch availability", () => {
    const allowed = row("allowed", state("pending", "not_taken_over", [], [
      { action: "centralize_management", available: true, reasons: [] },
    ]));
    const restricted = row("restricted", state("pending", "not_taken_over", [], [
      { action: "centralize_management", available: false, reasons: ["permission_limited"] },
    ]));
    const confirmationOnly = row("confirm", state("pending", "not_taken_over", [], [
      { action: "centralize_management", available: false, reasons: ["shared_impact_confirmation_required"] },
    ]));

    expect(rowIsBatchExecutable(allowed)).toBe(true);
    expect(rowIsNaturallyExecutable(allowed)).toBe(true);
    expect(rowIsBatchExecutable(restricted)).toBe(false);
    expect(rowIsNaturallyExecutable(restricted)).toBe(false);
    expect(rowNeedsSharedImpactConfirmation(confirmationOnly)).toBe(true);
  });
});
