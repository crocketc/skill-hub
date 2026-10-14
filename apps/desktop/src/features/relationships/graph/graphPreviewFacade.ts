import type { SkillRelationshipGraphResult } from "../../../api/bindings";
import type { RelationshipsFacade } from "../api";

const candidates = [
  {
    display_name: "PDF Reader",
    last_verified_at: "2026-09-10T08:00:00Z",
    matched_alias: null,
    relationship_count: 1,
    relationship_revision: "preview-graph-v1",
    runtime_name: "pdf-reader",
    skill_id: "skill-pdf",
    tags: ["documents", "pdf"],
  },
  {
    display_name: "Browser Test",
    last_verified_at: "2026-09-10T08:00:00Z",
    matched_alias: null,
    relationship_count: 1,
    relationship_revision: "preview-graph-v1",
    runtime_name: "agent-browser-test",
    skill_id: "skill-browser",
    tags: ["automation"],
  },
];

function graphFor(skillId: string): SkillRelationshipGraphResult {
  const candidate = candidates.find((item) => item.skill_id === skillId);
  return {
    center_skill_id: skillId,
    collapsed_count: 0,
    edges: [],
    fact_counts: {
      conflict_cases: 0,
      deployment_relations: 0,
      source_relations: 0,
      usage_relations: 0,
    },
    last_verified_at: candidate?.last_verified_at ?? null,
    nodes: [
      {
        active: null,
        agent_client_id: null,
        collapsed_count: 0,
        collapsed_kind: null,
        conflict_id: null,
        directory_node_id: null,
        display_name: candidate?.display_name ?? skillId,
        kind: "skill",
        last_verified_at: candidate?.last_verified_at ?? null,
        match_state: null,
        node_id: `preview-center-${skillId}`,
        path: null,
        profile_id: null,
        provenance_id: null,
        reference_only: false,
        relation_id: null,
        relationship: null,
        role: null,
        skill_id: skillId,
        source: null,
      },
    ],
    relationship_revision: "preview-graph-v1",
  };
}

/** Deterministic in-memory graph data used only by the development browser preview. */
export const graphPreviewFacade: RelationshipsFacade = {
  getConflictWorkspace: async () => { throw new Error("not used by the graph preview"); },
  getGraph: async ({ skillId }) => graphFor(skillId),
  listCandidates: async ({ tags = [], text = "" } = {}) => {
    const query = text.trim().toLowerCase();
    return candidates.filter((candidate) =>
      (!query || candidate.display_name.toLowerCase().includes(query) || candidate.runtime_name.includes(query))
      && tags.every((tag) => candidate.tags.includes(tag)),
    );
  },
  listGovernance: async () => { throw new Error("not used by the graph preview"); },
};
