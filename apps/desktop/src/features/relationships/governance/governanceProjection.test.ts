import { describe, expect, it } from "vitest";
import type {
  RelationGovernanceActionCondition,
  RelationGovernanceRow,
  RelationGovernanceState,
} from "../../../api/bindings";
import { rowIsBatchExecutable, rowIsNaturallyExecutable, rowNeedsSharedImpactConfirmation } from "./api";
import { governanceBoardColumnOf, projectGovernanceBoard } from "./governanceProjection";

function row(
  relationId: string,
  governance: RelationGovernanceState,
  legacy: Pick<RelationGovernanceRow, "readiness" | "status" | "primary_action">,
): RelationGovernanceRow {
  return {
    relation: {
      kind: "deployment",
      fact: { relation_id: relationId },
    } as unknown as RelationGovernanceRow["relation"],
    skill_display_name: "Skill",
    status: legacy.status,
    readiness: legacy.readiness,
    primary_action: legacy.primary_action,
    blockers: [],
    impact: {
      other_consumer_agent_ids: [],
      other_skill_paths: [],
      backup_required: false,
      rollback_available: false,
    },
    governance,
    target_identity: null,
    source_read_only: false,
    evidence_relation_ids: [relationId],
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

describe("projectGovernanceBoard", () => {
  it("uses authoritative governance classification instead of readiness or legacy status", () => {
    const pending = row(
      "pending-unmanaged",
      state("pending", "not_taken_over"),
      { readiness: "already_centralized", status: "normal", primary_action: "none" },
    );
    const pendingBrokenManaged = row(
      "pending-broken-managed",
      state("pending", "taken_over", "undecided", ["link_replaced"]),
      { readiness: "eligible_to_centralize", status: "normal", primary_action: "none" },
    );
    const completedRetained = row(
      "completed-retained",
      state("completed", "not_taken_over", "retained_independent_copy"),
      { readiness: "blocked", status: "blocked", primary_action: "none" },
    );
    const completedManaged = row(
      "completed-managed",
      state("completed", "taken_over"),
      { readiness: "blocked", status: "blocked", primary_action: "none" },
    );

    const projection = projectGovernanceBoard([
      pending,
      pendingBrokenManaged,
      completedRetained,
      completedManaged,
    ]);

    expect(projection.pending).toEqual([pending, pendingBrokenManaged]);
    expect(projection.completed).toEqual([completedRetained, completedManaged]);
    expect(Object.values(projection).flat()).toHaveLength(4);
    expect(new Set(Object.values(projection).flat()).size).toBe(4);
  });

  it("keeps long-term retained copies completed while management remains untaken", () => {
    const retained = row(
      "retained",
      state("completed", "not_taken_over", "retained_independent_copy"),
      { readiness: "needs_validation", status: "needs_validation", primary_action: "revalidate" },
    );

    expect(governanceBoardColumnOf(retained)).toBe("completed");
  });

  it("uses action conditions instead of legacy readiness for row and batch availability", () => {
    const allowed = row(
      "allowed-by-contract",
      state("pending", "not_taken_over", "undecided", [], [
        { action: "centralize_management", available: true, reasons: [] },
      ]),
      { readiness: "blocked", status: "blocked", primary_action: "none" },
    );
    const restricted = row(
      "restricted-by-contract",
      state("pending", "not_taken_over", "undecided", [], [
        { action: "centralize_management", available: false, reasons: ["permission_limited"] },
      ]),
      { readiness: "eligible_to_centralize", status: "normal", primary_action: "centralize_management" },
    );
    const confirmationOnly = row(
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
