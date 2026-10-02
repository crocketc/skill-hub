import { describe, expect, it } from "vitest";
import type { RelationGovernanceRow } from "../../../api/bindings";
import { projectGovernanceBoard } from "./governanceProjection";

function row(
  relationId: string,
  readiness: RelationGovernanceRow["readiness"],
  status: RelationGovernanceRow["status"],
): RelationGovernanceRow {
  return {
    relation: {
      kind: "deployment",
      fact: { relation_id: relationId },
    } as unknown as RelationGovernanceRow["relation"],
    skill_display_name: "Skill",
    status,
    readiness,
    primary_action: "none",
    blockers: [],
    impact: {
      other_consumer_agent_ids: [],
      other_skill_paths: [],
      backup_required: false,
      rollback_available: false,
    },
  };
}

describe("projectGovernanceBoard", () => {
  it("places every relationship edge in exactly one readiness column with safety states taking priority", () => {
    const rows = [
      row("blocked-status", "eligible_to_centralize", "blocked"),
      row("blocked-readiness", "blocked", "normal"),
      row("needs-validation-readiness", "needs_validation", "normal"),
      row("needs-validation-status", "already_centralized", "needs_validation"),
      row("needs-attention", "already_centralized", "needs_attention"),
      row("manageable", "eligible_to_centralize", "normal"),
      row("settled-normal", "already_centralized", "normal"),
      row("settled-retained", "already_centralized", "retained"),
    ];

    const projection = projectGovernanceBoard(rows);

    expect(projection.blocked).toEqual([rows[0], rows[1]]);
    expect(projection.needsValidation).toEqual([rows[2], rows[3], rows[4]]);
    expect(projection.manageable).toEqual([rows[5]]);
    expect(projection.settled).toEqual([rows[6], rows[7]]);
    expect(Object.values(projection).flat()).toHaveLength(rows.length);
    expect(new Set(Object.values(projection).flat()).size).toBe(rows.length);
  });

  it("keeps attention and validation states out of the settled column", () => {
    const attention = row("changed-source", "already_centralized", "needs_attention");
    const staleLink = row("stale-link", "already_centralized", "needs_validation");

    const projection = projectGovernanceBoard([attention, staleLink]);

    expect(projection.settled).toEqual([]);
    expect(projection.needsValidation).toEqual([attention, staleLink]);
  });
});
