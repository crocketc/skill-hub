import { describe, expect, it } from "vitest";
import type { RelationshipType, RelationGovernanceRow } from "../../api/bindings";
import { projectDisplayName, usageDestinationCards } from "./usageDestinations";

function deploymentRow(overrides: {
  relationId: string;
  path?: string;
  agentClientId?: string;
  relationship?: RelationshipType;
  targetKind?: "agent" | "project" | "shared_directory";
  takenOver?: boolean;
  unhealthy?: boolean;
}): RelationGovernanceRow {
  const path = overrides.path ?? "C:/agents/codex/skills/pdf-reader";
  const targetKind = overrides.targetKind ?? "agent";
  return {
    relation: {
      kind: "deployment",
      fact: {
        relation_id: overrides.relationId,
        skill_id: "skill-pdf",
        agent_client_id: overrides.agentClientId ?? "codex",
        path,
        path_key: path.toLowerCase(),
        directory_node_id: null,
        relationship: overrides.relationship ?? "managed_copy",
        file_representation: "copy",
        ownership: "skillhub_managed",
        link_target_path: null,
        link_target_path_key: null,
        link_target_directory_id: null,
        content_fingerprint: "sha256:x",
        origin: "import",
        match_state: "content_verified",
        health_reasons: overrides.unhealthy ? ["target_entry_missing"] : [],
        active: true,
        observed_at: "0",
        released_at: null,
      },
    },
    skill_display_name: "PDF Reader",
    status: "normal",
    readiness: "eligible_to_centralize",
    primary_action: "centralize_management",
    blockers: [],
    impact: { other_consumer_agent_ids: [], other_skill_paths: [], backup_required: true, rollback_available: true },
    governance: {
      governance_status: overrides.takenOver ? "completed" : "pending",
      management_status: overrides.takenOver ? "taken_over" : "not_taken_over",
      decision: "undecided",
      management_confirmed_at: null,
      health_reasons: overrides.unhealthy ? ["link_target_unavailable"] : [],
      action_conditions: [],
    },
    target_identity: targetKind === "agent"
      ? null
      : { skill_id: "skill-pdf", target_kind: targetKind, directory_node_id: "node-x", entry_path_key: path.toLowerCase() },
    source_read_only: false,
    evidence_relation_ids: [overrides.relationId],
  };
}

function sourceCopyRow(relationId: string): RelationGovernanceRow {
  return {
    relation: {
      kind: "source_copy",
      fact: {
        relation_id: relationId,
        skill_id: "skill-pdf",
        latest_provenance_id: "prov-1",
        source_class: "user_local",
        source_path: "C:/library/originals/pdf-reader",
        source_path_key: "c:/library/originals/pdf-reader",
        physical_source_id: "phys-src-1",
        source_container_id: null,
        directory_node_id: null,
        agent_client_id: null,
        expected_fingerprint: "sha256:x",
        current_fingerprint: "sha256:x",
        decision: "pending",
        health: "normal",
        health_reasons: [],
        active: true,
        last_verified_at: null,
        archived_at: null,
        archive_reason: null,
      },
    },
    skill_display_name: "PDF Reader",
    status: "normal",
    readiness: "eligible_to_centralize",
    primary_action: "keep_independent_copy",
    blockers: [],
    impact: { other_consumer_agent_ids: [], other_skill_paths: [], backup_required: false, rollback_available: false },
    governance: {
      governance_status: "pending",
      management_status: "not_taken_over",
      decision: "undecided",
      management_confirmed_at: null,
      health_reasons: [],
      action_conditions: [],
    },
    target_identity: null,
    source_read_only: false,
    evidence_relation_ids: [relationId],
  };
}

describe("usageDestinationCards", () => {
  it("maps deployment ledger rows to cards and excludes source copies", () => {
    const cards = usageDestinationCards([
      sourceCopyRow("src-1"),
      deploymentRow({ relationId: "rel:codex", takenOver: true }),
    ]);
    expect(cards).toEqual([{
      relationId: "rel:codex",
      path: "C:/agents/codex/skills/pdf-reader",
      targetKind: "agent",
      agentClientIds: ["codex"],
      takenOver: true,
      unhealthy: false,
    }]);
  });

  it("collects every consumer brand that shares one physical path key for shared directories", () => {
    const cards = usageDestinationCards([
      deploymentRow({
        relationId: "rel:shared-codex",
        path: "C:/agents/shared/skills/pdf-reader",
        agentClientId: "codex",
        relationship: "shared_directory_read",
        targetKind: "shared_directory",
        takenOver: true,
      }),
      deploymentRow({
        relationId: "rel:shared-codebuddy",
        path: "C:/agents/shared/skills/pdf-reader",
        agentClientId: "codebuddy",
        relationship: "shared_directory_reference",
        targetKind: "shared_directory",
        takenOver: true,
      }),
    ]);
    expect(cards.map((card) => card.agentClientIds)).toEqual([["codex", "codebuddy"], ["codex", "codebuddy"]]);
    expect(cards.every((card) => card.targetKind === "shared_directory")).toBe(true);
  });

  it("keeps health evidence visible on the card model", () => {
    const cards = usageDestinationCards([
      deploymentRow({ relationId: "rel:broken", unhealthy: true, takenOver: true }),
    ]);
    expect(cards[0]?.unhealthy).toBe(true);
    expect(cards[0]?.takenOver).toBe(true);
  });
});

describe("projectDisplayName", () => {
  it("derives the project name from the segment before skills/<skill>", () => {
    expect(projectDisplayName("C:/Projects/docs/skills/pdf-reader")).toBe("docs");
    expect(projectDisplayName("~/Projects/文档协作/skills/pdf-reader")).toBe("文档协作");
  });
  it("returns null instead of fabricating a name for unexpected shapes", () => {
    expect(projectDisplayName("C:/random/pdf-reader")).toBeNull();
  });
});
