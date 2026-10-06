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
        governance: null,
        target_identity: null,
        evidence_relation_ids: [],
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
        governance: null,
        target_identity: null,
        evidence_relation_ids: [],
      },
    ],
    fact_counts: { deployment_relations: 0, source_relations: 0, conflict_cases: 0, usage_relations: 0 },
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
            selectedEdgeId={null}
            selectedNodeId="dir"
          />
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.getByRole("heading", { name: "C:\\skills\\pdf" })).toBeVisible();
    expect(screen.queryByText(/\\\\\?\\/)).not.toBeInTheDocument();
  });

  it("labels a shared directory without exposing its internal node ID when the path is missing", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    const graph = fixture();
    graph.nodes[1] = {
      ...graph.nodes[1],
      directory_node_id: "directory-internal-42",
      path: null,
      role: "shared_directory",
    };
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
            selectedEdgeId={null}
            selectedNodeId={"dir"}
          />
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.getByRole("heading", { name: "Shared directory" })).toBeVisible();
    expect(screen.queryByText("directory-internal-42")).not.toBeInTheDocument();
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
            resolveSkillName={(skillId) => skillId === "notes-reader" ? "Notes Reader" : undefined}
            selectedEdgeId={null}
            selectedNodeId="related-skill"
          />
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.getByRole("heading", { name: "Notes Reader" })).toBeVisible();
  });

  it("uses a readable kind label when a selected Skill name cannot be resolved", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    const graph = fixture();
    graph.nodes.push({
      ...graph.nodes[0]!,
      node_id: "skill-node-internal-42",
      skill_id: "skill-id-internal-42",
    });
    graph.edges.push({
      ...graph.edges[0]!,
      edge_id: "edge-skill-internal-42",
      to_node_id: "skill-node-internal-42",
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
            selectedEdgeId={null}
            selectedNodeId="skill-node-internal-42"
          />
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.getByRole("heading", { name: "Skill" })).toBeVisible();
    expect(screen.queryByText("skill-id-internal-42")).not.toBeInTheDocument();
    expect(screen.queryByText("skill-node-internal-42")).not.toBeInTheDocument();
  });

  it("uses a readable conflict label instead of exposing the conflict identifier", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    const graph = fixture();
    graph.nodes.push({
      ...graph.nodes[0]!,
      node_id: "conflict-node-internal-9",
      kind: "conflict",
      skill_id: null,
      conflict_id: "conflict-case-opaque-42",
    });
    graph.edges.push({
      ...graph.edges[0]!,
      edge_id: "edge-conflict-internal-1",
      to_node_id: "conflict-node-internal-9",
      kind: "conflict",
      relationship: null,
      relation_id: null,
      conflict_id: "conflict-case-opaque-42",
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
            selectedEdgeId={null}
            selectedNodeId="conflict-node-internal-9"
          />
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.getByRole("heading", { name: "Conflict" })).toBeVisible();
    expect(screen.queryByText("conflict-case-opaque-42")).not.toBeInTheDocument();
    expect(screen.queryByText("conflict-node-internal-9")).not.toBeInTheDocument();
  });

  it("uses a readable kind label when a node has no user-facing name", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    const graph = fixture();
    graph.nodes[2] = {
      ...graph.nodes[2]!,
      node_id: "source-node-internal-77",
      path: null,
      source: null,
    };
    graph.edges[1] = { ...graph.edges[1]!, to_node_id: "source-node-internal-77" };
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
            selectedEdgeId={null}
            selectedNodeId="source-node-internal-77"
          />
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.getByRole("heading", { name: "Source" })).toBeVisible();
    expect(screen.queryByText("source-node-internal-77")).not.toBeInTheDocument();
  });

  it("does not display an internal relationship revision in the details panel", async () => {
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
            selectedEdgeId={null}
            selectedNodeId={null}
          />
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.queryByText("internal-revision-r1")).not.toBeInTheDocument();
  });
});

// —— 来源保持生命周期入口；只有后端明确投影的使用边进入治理 ——

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
      governance: null,
      target_identity: null,
      evidence_relation_ids: [],
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
      governance: null,
      target_identity: null,
      evidence_relation_ids: [],
    },
  );
  return graph;
}

async function renderSelection(options: {
  selectedEdgeId?: string | null;
  selectNodeId?: (projection: ReturnType<typeof projectGraph>) => string | null;
  graph?: SkillRelationshipGraphResult;
  language?: string;
}) {
  const i18n = await createSkillHubI18n([options.language ?? "en-US"]);
  const projection = projectGraph(
    options.graph ?? governanceFixture(),
    { relationshipTypes: [], statuses: [], governance: [], management: [] },
    ALL_DISPLAY_ON,
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
          selectedEdgeId={options.selectedEdgeId ?? null}
          selectedNodeId={selectedNodeId}
        />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe("GraphDetailsPanel governance entries", () => {
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

  it("routes a source edge to the Skill lifecycle and does not misclassify it as governance", async () => {
    await renderSelection({
      selectedEdgeId: "e-src-local",
    });

    expect(screen.getByRole("link", { name: "View source lifecycle" })).toHaveAttribute(
      "href", "/library/pdf-reader#review-versions",
    );
    expect(screen.queryByRole("link", { name: "Manage in relationship governance" })).not
      .toBeInTheDocument();
  });

  it("keeps the online source edge read-only when no current source copy exists", async () => {
    await renderSelection({ selectedEdgeId: "e-src-online" });

    expect(screen.getByRole("link", { name: "View source lifecycle" })).toHaveAttribute(
      "href", "/library/pdf-reader#review-versions",
    );
  });

  it("shows governance classification and management independently of a verified graph match", async () => {
    const graph = governanceFixture();
    graph.edges[0] = {
      ...graph.edges[0]!,
      relation_id: "relation-private-42",
      match_state: "content_verified",
      active: true,
      governance: {
        governance_status: "pending",
        management_status: "not_taken_over",
        decision: "undecided",
        management_confirmed_at: null,
        health_reasons: ["verification_required"],
        action_conditions: [
          { action: "revalidate", available: true, reasons: [] },
          { action: "centralize_management", available: false, reasons: ["verification_required"] },
        ],
      },
      target_identity: {
        skill_id: "pdf-reader",
        target_kind: "agent",
        directory_node_id: "dir",
        entry_path_key: "private-path-key",
      },
      evidence_relation_ids: ["relation-private-42", "relation-private-43"],
    };
    graph.edges.push({
      ...graph.edges[0]!,
      edge_id: "e-use",
      kind: "deployment",
      relation_id: "relation-private-42",
    });
    graph.edges[0] = { ...graph.edges[0]!, governance: null };
    await renderSelection({ graph, language: "zh-CN", selectedEdgeId: "e-use" });

    expect(screen.getByTestId("graph-governance-classification")).toHaveTextContent("待处理");
    expect(screen.getByTestId("graph-governance-management")).toHaveTextContent("待集中管理");
    expect(screen.getByTestId("graph-governance-reasons")).toHaveTextContent("当前验证结果不足，请重新检查目标。");
    expect(screen.getByRole("link", { name: "在关系治理中处理" })).toHaveAttribute(
      "href",
      "/relationships/governance?from=graph&relationId=relation-private-42",
    );
    expect(screen.queryByText(/relation-private-|private-path-key/)).not.toBeInTheDocument();
  });
});
