import type { SkillRelationshipGraphResult } from "../../../api/bindings";
import type { RelationshipsFacade } from "../api";

const LONG_PATH_SAMPLE_ID = "skill-long-path-preview";
const LONG_SOURCE_PATH = "/Users/preview/Library/Application Support/SkillHub/agents/organization/skills/relationships/graph/verification/samples/a-path-that-is-deliberately-long-for-the-details-panel/SKILL.md";

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
  const includeLongPath = skillId === LONG_PATH_SAMPLE_ID;
  return {
    center_skill_id: skillId,
    collapsed_count: 0,
    edges: includeLongPath
      ? [{
          active: true,
          conflict_id: null,
          edge_id: "preview-long-path-edge",
          evidence_relation_ids: [],
          from_node_id: `preview-center-${skillId}`,
          governance: null,
          kind: "source",
          last_verified_at: "2026-09-10T08:00:00Z",
          match_state: null,
          provenance_id: "preview-long-path-source",
          relation_id: null,
          relationship: "observed_copy",
          relationship_kind: "import_origin",
          target_identity: null,
          to_node_id: "preview-long-path-source",
        }]
      : [],
    fact_counts: {
      conflict_cases: 0,
      deployment_relations: 0,
      source_relations: includeLongPath ? 1 : 0,
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
        display_name: candidate?.display_name ?? (includeLongPath ? "Long path preview" : skillId),
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
      ...(includeLongPath
        ? [{
            active: true,
            agent_client_id: null,
            collapsed_count: 0,
            collapsed_kind: null,
            conflict_id: null,
            directory_node_id: null,
            display_name: null,
            kind: "source" as const,
            last_verified_at: "2026-09-10T08:00:00Z",
            match_state: null,
            node_id: "preview-long-path-source",
            path: LONG_SOURCE_PATH,
            profile_id: null,
            provenance_id: "preview-long-path-source",
            reference_only: false,
            relation_id: null,
            relationship: null,
            role: null,
            skill_id: null,
            source: { kind: "local" as const, locator: { local_path: LONG_SOURCE_PATH } },
          }]
        : []),
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
    const longPathSample = typeof window !== "undefined"
      && new URLSearchParams(window.location.search).get("fixture") === "long-path"
      ? [{
          display_name: "Long path preview",
          last_verified_at: "2026-09-10T08:00:00Z",
          matched_alias: null,
          relationship_count: 1,
          relationship_revision: "preview-graph-v1",
          runtime_name: "long-path-preview",
          skill_id: LONG_PATH_SAMPLE_ID,
          tags: ["preview"],
        }]
      : [];
    return [...candidates, ...longPathSample].filter((candidate) =>
      (!query || candidate.display_name.toLowerCase().includes(query) || candidate.runtime_name.includes(query))
      && tags.every((tag) => candidate.tags.includes(tag)),
    );
  },
  listGovernance: async () => { throw new Error("not used by the graph preview"); },
};
