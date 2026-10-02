import { describe, expect, it } from "vitest";
import type { RelationGovernanceRow } from "../../../api/bindings";
import { presentGovernanceRow } from "./governancePresenter";

function row(overrides: Partial<RelationGovernanceRow["governance"]>): RelationGovernanceRow {
  return {
    relation: { kind: "deployment", fact: { relation_id: "rel" } } as unknown as RelationGovernanceRow["relation"],
    status: "normal",
    skill_display_name: "Skill",
    readiness: "already_centralized",
    primary_action: "none",
    blockers: [],
    impact: {
      other_consumer_agent_ids: [],
      other_skill_paths: [],
      backup_required: false,
      rollback_available: false,
    },
    governance: {
      governance_status: "pending",
      management_status: "not_taken_over",
      decision: "undecided",
      management_confirmed_at: null,
      health_reasons: [],
      action_conditions: [],
      ...overrides,
    },
    target_identity: null,
    evidence_relation_ids: ["rel"],
  };
}

describe("presentGovernanceRow", () => {
  it("keeps completed retained copies separate from management and old readiness", () => {
    const presentation = presentGovernanceRow(row({
      governance_status: "completed",
      management_status: "not_taken_over",
      decision: "retained_independent_copy",
    }));

    expect(presentation.classificationKey).toBe("relationships.governance.classification.completed");
    expect(presentation.managementKey).toBe("relationships.governance.management.not_taken_over");
    expect(presentation.decisionKey).toBe("relationships.governance.decision.retained_independent_copy");
    expect(presentation.summaryKey).toBe("relationships.governance.shortName.retained");
    expect(presentation.reasonKeys).toEqual([]);
  });

  it("prioritizes a real link exception and unions unavailable action reasons", () => {
    const presentation = presentGovernanceRow(row({
      governance_status: "pending",
      management_status: "taken_over",
      health_reasons: ["link_replaced"],
      action_conditions: [
        { action: "undeploy", available: false, reasons: ["permission_limited"] },
        { action: "revalidate", available: true, reasons: [] },
      ],
    }));

    expect(presentation.classificationKey).toBe("relationships.governance.classification.pending");
    expect(presentation.managementKey).toBe("relationships.governance.management.taken_over");
    expect(presentation.summaryKey).toBe("relationships.governance.shortName.link_issue");
    expect(presentation.tone).toBe("danger");
    expect(presentation.reasonKeys).toEqual(["link_replaced", "permission_limited"]);
  });

  it("does not promote a healthy but undecided relation because legacy fields look ready", () => {
    const presentation = presentGovernanceRow(row({
      governance_status: "pending",
      management_status: "not_taken_over",
      decision: "undecided",
    }));

    expect(presentation.summaryKey).toBe("relationships.governance.shortName.not_taken_over");
    expect(presentation.descriptionKey).toBe("relationships.governance.shortName.not_taken_overDescription");
  });
});
