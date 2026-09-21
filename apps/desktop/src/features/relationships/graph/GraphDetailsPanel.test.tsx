import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../../i18n";
import type { SkillRelationshipGraphResult } from "../api";
import { ALL_DISPLAY_ON, projectGraph } from "./graphProjection";
import { GraphDetailsPanel } from "./GraphDetailsPanel";

function fixture(): SkillRelationshipGraphResult {
  const node = (node_id: string, kind: SkillRelationshipGraphResult["nodes"][number]["kind"], path: string | null) => ({
    node_id,
    kind,
    skill_id: null,
    relation_id: null,
    provenance_id: null,
    conflict_id: null,
    agent_client_id: null,
    directory_node_id: kind === "directory" ? node_id : null,
    path,
    role: null,
    profile_id: null,
    collapsed_kind: null,
    relationship: null,
    match_state: null,
    active: null,
    source: null,
    collapsed_count: 0,
    last_verified_at: null,
  });
  return {
    center_skill_id: "pdf-reader",
    nodes: [
      { ...node("center", "skill", null), skill_id: "pdf-reader" },
      node("dir", "directory", "\\\\?\\C:\\skills\\pdf"),
      node("source", "source", "\\??\\C:\\sources\\pdf"),
    ],
    edges: [
      {
        edge_id: "e-dir",
        from_node_id: "center",
        to_node_id: "dir",
        kind: "located_in",
        relationship: "shared_directory_read",
        relation_id: null,
        provenance_id: null,
        conflict_id: null,
        match_state: null,
        active: true,
        last_verified_at: null,
      },
      {
        edge_id: "e-source",
        from_node_id: "center",
        to_node_id: "source",
        kind: "source",
        relationship: null,
        relation_id: null,
        provenance_id: null,
        conflict_id: null,
        match_state: null,
        active: true,
        last_verified_at: null,
      },
    ],
    fact_counts: { deployment_relations: 0, source_relations: 0, conflict_cases: 0 },
    collapsed_count: 0,
    relationship_revision: "r1",
    last_verified_at: null,
  };
}

describe("GraphDetailsPanel path presentation", () => {
  it("removes Windows internal prefixes from directory and source details", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    const projection = projectGraph(fixture(), { relationshipTypes: [], statuses: [] }, ALL_DISPLAY_ON);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <GraphDetailsPanel
            centerSkillId="pdf-reader"
            displayName="PDF Reader"
            factCounts={projection.factCounts}
            lastVerifiedAt={null}
            onBeforeNavigate={() => undefined}
            projection={projection}
            relationshipRevision="r1"
            selectedEdgeId={null}
            selectedNodeId="dir"
          />
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.getByRole("heading", { name: "C:\\skills\\pdf" })).toBeVisible();
    expect(screen.queryByText(/\\\\\?\\/)).not.toBeInTheDocument();
  });
});
