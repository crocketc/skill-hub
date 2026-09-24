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

  it("uses the resolved Skill name for selected Skill nodes", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    const graph = fixture();
    graph.nodes.push({
      ...graph.nodes[0],
      node_id: "related-skill",
      skill_id: "notes-reader",
    });
    graph.edges.push({
      ...graph.edges[0],
      edge_id: "e-related",
      to_node_id: "related-skill",
    });
    const projection = projectGraph(graph, { relationshipTypes: [], statuses: [] }, ALL_DISPLAY_ON);
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
            resolveSkillName={(skillId) => skillId === "notes-reader" ? "Notes Reader" : undefined}
            selectedEdgeId={null}
            selectedNodeId="related-skill"
          />
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.getByRole("heading", { name: "Notes Reader" })).toBeVisible();
  });
});

// —— 任务 12B：在线来源展示 URL 且无治理按钮；来源边按台账关联治理深链 ——

function governanceFixture(): SkillRelationshipGraphResult {
  const graph = fixture();
  graph.nodes = graph.nodes.filter((candidate) => candidate.node_id !== "source");
  graph.edges = graph.edges.filter((candidate) => candidate.edge_id !== "e-source");
  graph.nodes.push(
    {
      node_id: "src-local",
      kind: "source",
      skill_id: null,
      relation_id: null,
      provenance_id: "prov-1",
      conflict_id: null,
      agent_client_id: null,
      directory_node_id: null,
      path: "C:/agents/claude/skills/pdf-reader",
      role: null,
      profile_id: null,
      collapsed_kind: null,
      relationship: null,
      match_state: null,
      active: null,
      source: { kind: "local", locator: { local_path: "C:/agents/claude/skills/pdf-reader" } },
      collapsed_count: 0,
      last_verified_at: null,
    },
    {
      node_id: "src-online",
      kind: "source",
      skill_id: null,
      relation_id: null,
      provenance_id: "prov-online-1",
      conflict_id: null,
      agent_client_id: null,
      directory_node_id: null,
      path: "C:/cache/online/anthropics-skills/pdf-reader",
      role: null,
      profile_id: null,
      collapsed_kind: null,
      relationship: null,
      match_state: null,
      active: null,
      source: {
        kind: "https",
        locator: { https_url: "https://github.com/anthropics/skills" },
      },
      collapsed_count: 0,
      last_verified_at: null,
    },
  );
  graph.edges.push(
    {
      edge_id: "e-src-local",
      from_node_id: "center",
      to_node_id: "src-local",
      kind: "source",
      relationship: "observed_copy",
      relation_id: null,
      provenance_id: "prov-1",
      conflict_id: null,
      match_state: null,
      active: true,
      last_verified_at: null,
    },
    {
      edge_id: "e-src-online",
      from_node_id: "center",
      to_node_id: "src-online",
      kind: "source",
      relationship: "observed_copy",
      relation_id: null,
      provenance_id: "prov-online-1",
      conflict_id: null,
      match_state: null,
      active: true,
      last_verified_at: null,
    },
  );
  return graph;
}

async function renderSelection(options: {
  selectedEdgeId?: string | null;
  selectNodeId?: (projection: ReturnType<typeof projectGraph>) => string | null;
  sourceCopies?: Parameters<typeof projectGraph>[3];
}) {
  const i18n = await createSkillHubI18n(["en-US"]);
  const projection = projectGraph(
    governanceFixture(),
    { relationshipTypes: [], statuses: [] },
    ALL_DISPLAY_ON,
    options.sourceCopies,
  );
  const selectedNodeId = options.selectNodeId?.(projection) ?? null;
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
          selectedEdgeId={options.selectedEdgeId ?? null}
          selectedNodeId={selectedNodeId}
        />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe("GraphDetailsPanel governance entries (12B)", () => {
  it("shows the readable online URL for an online source node with no governance button", async () => {
    await renderSelection({
      // 画布选中的是合并后的展示节点（任务 12B 的 locator 合并 id）。
      selectNodeId: (projection) =>
        projection.nodes.find(
          (node) => node.node.kind === "source" && node.node.source?.kind === "https",
        )?.node.node_id ?? null,
    });

    expect(
      screen.getByRole("heading", { name: "https://github.com/anthropics/skills" }),
    ).toBeVisible();
    // 在线来源节点只有来源详情，绝不出现治理入口（缓存路径也不出现）。
    expect(screen.queryByRole("link", { name: "Manage in relationship governance" })).not
      .toBeInTheDocument();
    expect(screen.queryByText(/C:[/\\]cache[/\\]online/)).not.toBeInTheDocument();
  });

  it("deep-links a source edge to its current source-copy relation from the ledger", async () => {
    await renderSelection({
      selectedEdgeId: "e-src-local",
      sourceCopies: [{
        relation_id: "rel-local-9",
        skill_id: "pdf-reader",
        latest_provenance_id: "prov-1",
        source_class: "agent_local",
        source_path: "C:/agents/claude/skills/pdf-reader",
        source_path_key: "c-agents-claude-skills-pdf-reader",
        physical_source_id: "phys-1",
        source_container_id: null,
        directory_node_id: null,
        agent_client_id: "claude",
        expected_fingerprint: "fp-1",
        current_fingerprint: "fp-1",
        decision: "pending",
        health: "normal",
        active: true,
        last_verified_at: null,
        archived_at: null,
        archive_reason: null,
      }],
    });

    const govern = screen.getByRole("link", { name: "Manage in relationship governance" });
    expect(govern).toHaveAttribute(
      "href",
      "/relationships/governance?from=graph&relationId=rel-local-9",
    );
  });

  it("keeps the online source edge read-only when no current source copy exists", async () => {
    await renderSelection({ selectedEdgeId: "e-src-online" });

    expect(
      screen.queryByRole("link", { name: "Manage in relationship governance" }),
    ).not.toBeInTheDocument();
  });
});
