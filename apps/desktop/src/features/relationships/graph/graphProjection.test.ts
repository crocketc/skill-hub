import { describe, expect, it } from "vitest";
import type {
  RelationshipGraphFactCounts,
  SkillRelationshipEdge,
  SkillRelationshipGraphResult,
  SkillRelationshipNode,
} from "../../../api/bindings";
import {
  CANVAS_SIZE,
  edgeStatusLabelKey,
  edgeTypeLabelKey,
  edgeVisual,
  projectGraph,
  type GraphDisplaySettings,
  type GraphFactFilters,
} from "./graphProjection";

const LAST_VERIFIED = "2026-09-01T08:00:00Z";

function centerNode(): SkillRelationshipNode {
  return {
    node_id: "n-center",
    kind: "skill",
    skill_id: "pdf-reader",
    relation_id: null,
    provenance_id: null,
    conflict_id: null,
    agent_client_id: null,
    directory_node_id: null,
    path: null,
    role: null,
    profile_id: null,
    collapsed_kind: null,
    relationship: null,
    match_state: null,
    active: null,
    source: null,
    collapsed_count: 0,
    last_verified_at: LAST_VERIFIED,
  };
}

function skillNode(nodeId: string, skillId: string): SkillRelationshipNode {
  return { ...centerNode(), node_id: nodeId, skill_id: skillId };
}

function contextNode(overrides: Partial<SkillRelationshipNode>): SkillRelationshipNode {
  return {
    ...centerNode(),
    node_id: "n-context",
    kind: "agent",
    skill_id: null,
    ...overrides,
  };
}

function edge(overrides: Partial<SkillRelationshipEdge>): SkillRelationshipEdge {
  return {
    edge_id: "e",
    from_node_id: "n-center",
    to_node_id: "n-other",
    kind: "related_skill",
    relationship: null,
    relation_id: null,
    provenance_id: null,
    conflict_id: null,
    match_state: null,
    active: null,
    last_verified_at: null,
    ...overrides,
  };
}

function baseNodes(): SkillRelationshipNode[] {
  return [
    centerNode(),
    skillNode("n-rel-1", "doc-reader"),
    skillNode("n-rel-2", "md-reader"),
    contextNode({ node_id: "n-agent-1", kind: "agent", agent_client_id: "claude" }),
    contextNode({ node_id: "n-dir-1", kind: "directory", directory_node_id: "dir-1" }),
    contextNode({ node_id: "n-src-1", kind: "source", provenance_id: "prov-1" }),
    contextNode({ node_id: "n-conflict-1", kind: "conflict", conflict_id: "c-1" }),
  ];
}

function baseEdges(): SkillRelationshipEdge[] {
  return [
    edge({
      edge_id: "e1",
      to_node_id: "n-rel-1",
      relationship: "managed_copy",
      match_state: "content_verified",
      active: true,
      last_verified_at: LAST_VERIFIED,
    }),
    edge({
      edge_id: "e2",
      to_node_id: "n-rel-2",
      relationship: "import_copy",
      match_state: "name_only",
      last_verified_at: null,
    }),
    edge({
      edge_id: "e3",
      to_node_id: "n-agent-1",
      kind: "deployment",
      relationship: "managed_link",
      active: true,
      last_verified_at: LAST_VERIFIED,
    }),
    edge({
      edge_id: "e4",
      to_node_id: "n-dir-1",
      kind: "located_in",
      relationship: "shared_directory_read",
      active: false,
      last_verified_at: LAST_VERIFIED,
    }),
    edge({
      edge_id: "e5",
      to_node_id: "n-src-1",
      kind: "source",
      relationship: "observed_copy",
      last_verified_at: LAST_VERIFIED,
    }),
    edge({ edge_id: "e6", to_node_id: "n-conflict-1", kind: "conflict" }),
  ];
}

function baseGraph(): SkillRelationshipGraphResult {
  const factCounts: RelationshipGraphFactCounts = {
    deployment_relations: 1,
    source_relations: 1,
    conflict_cases: 1,
  };
  return {
    center_skill_id: "pdf-reader",
    nodes: baseNodes(),
    edges: baseEdges(),
    fact_counts: factCounts,
    collapsed_count: 0,
    relationship_revision: "r42",
    last_verified_at: LAST_VERIFIED,
  };
}

const NO_FILTERS: GraphFactFilters = { relationshipTypes: [], statuses: [] };
const ALL_DISPLAY_ON: GraphDisplaySettings = {
  showSources: true,
  showAgentsProjects: true,
  showDirectories: true,
  showConflicts: true,
};

function frozen<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("projectGraph layer boundaries", () => {
  it("places the center alone, one-hop skills beside it and context leaves on the other side", () => {
    const projection = projectGraph(baseGraph(), NO_FILTERS, ALL_DISPLAY_ON);

    const center = projection.nodes.find((node) => node.node.node_id === "n-center");
    expect(center?.layer).toBe("center");
    expect(projection.nodes.filter((node) => node.layer === "center")).toHaveLength(1);

    const relatedIds = projection.nodes
      .filter((node) => node.layer === "related")
      .map((node) => node.node.node_id)
      .sort();
    expect(relatedIds).toEqual(["n-rel-1", "n-rel-2"]);

    const contextIds = projection.nodes
      .filter((node) => node.layer === "context")
      .map((node) => node.node.node_id)
      .sort();
    expect(contextIds).toEqual(["n-agent-1", "n-conflict-1", "n-dir-1", "n-src-1"]);

    for (const node of projection.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
    const related = projection.nodes.filter((node) => node.layer === "related");
    const context = projection.nodes.filter((node) => node.layer === "context");
    expect(related.every((node) => node.x < (center?.x ?? 0))).toBe(true);
    expect(context.every((node) => node.x > (center?.x ?? 0))).toBe(true);
  });

  it("drops edges that would link context leaves to other skills or bypass the center", () => {
    const graph = baseGraph();
    graph.edges = [
      ...graph.edges,
      edge({
        edge_id: "e-bad-context",
        from_node_id: "n-agent-1",
        to_node_id: "n-rel-1",
        kind: "shared",
        relationship: "shared_directory_read",
      }),
      edge({
        edge_id: "e-bad-depth",
        from_node_id: "n-rel-1",
        to_node_id: "n-rel-2",
        kind: "related_skill",
        relationship: "managed_copy",
      }),
    ];

    const projection = projectGraph(graph, NO_FILTERS, ALL_DISPLAY_ON);
    const edgeIds = projection.edges.map((projected) => projected.edge.edge_id);
    expect(edgeIds).not.toContain("e-bad-context");
    expect(edgeIds).not.toContain("e-bad-depth");
    // 保留的事实边恰好是中心出发的六条。
    expect(edgeIds.sort()).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
  });

  it("keeps every projected node anchored to the center by an edge or by an explicit collapse", () => {
    const graph = baseGraph();
    graph.nodes.push(
      contextNode({ node_id: "n-orphan", kind: "project", profile_id: "proj-9" }),
    );

    const projection = projectGraph(graph, NO_FILTERS, ALL_DISPLAY_ON);
    const nodeIds = projection.nodes.map((node) => node.node.node_id);
    expect(nodeIds).not.toContain("n-orphan");
  });
});

describe("edge display states", () => {
  it("derives label keys from the relationship or from the structural kind", () => {
    expect(edgeTypeLabelKey({ ...edge({}), relationship: "managed_copy" })).toBe(
      "relationships.graph.edgeType.managed_copy",
    );
    expect(edgeTypeLabelKey({ ...edge({}), relationship: null, kind: "conflict" })).toBe(
      "relationships.graph.edgeKind.conflict",
    );
  });

  it("maps fact states to solid/verified, dashed/inaccessible and dotted/needs-validation visuals", () => {
    const verified = edgeVisual(
      edge({ relationship: "managed_copy", match_state: "content_verified", active: true }),
    );
    expect(verified).toEqual({ line: "solid", state: "verified" });

    const activeWithoutMatch = edgeVisual(edge({ relationship: "managed_link", active: true }));
    expect(activeWithoutMatch).toEqual({ line: "solid", state: "verified" });

    const inactive = edgeVisual(
      edge({ relationship: "shared_directory_read", active: false }),
    );
    expect(inactive).toEqual({ line: "dashed", state: "inactive" });

    const nameOnly = edgeVisual(edge({ relationship: "import_copy", match_state: "name_only" }));
    expect(nameOnly).toEqual({ line: "dotted", state: "unverified" });

    const diverged = edgeVisual(edge({ relationship: "managed_copy", match_state: "diverged" }));
    expect(diverged).toEqual({ line: "dotted", state: "unverified" });

    expect(edgeStatusLabelKey(edge({ active: false }))).toBe("relationships.graph.status.released");
    expect(edgeStatusLabelKey(edge({ match_state: "name_only" }))).toBe(
      "relationships.graph.status.name_only",
    );
    expect(edgeStatusLabelKey(edge({ match_state: "content_verified", active: true }))).toBe(
      "relationships.graph.status.content_verified",
    );
  });
});

describe("collapse and hidden counts", () => {
  it("surfaces backend-collapsed nodes as chips with their kind and count", () => {
    const graph = baseGraph();
    graph.nodes.push(
      contextNode({
        node_id: "n-collapsed",
        kind: "collapsed",
        collapsed_kind: "agent",
        collapsed_count: 3,
      }),
    );

    const projection = projectGraph(graph, NO_FILTERS, ALL_DISPLAY_ON);
    const backendChip = projection.collapsed.find((chip) => chip.reason === "collapsed");
    expect(backendChip).toEqual({ kind: "agent", count: 3, reason: "collapsed" });
    const collapsedLayer = projection.nodes.filter((node) => node.layer === "collapsed");
    expect(collapsedLayer.map((node) => node.node.node_id)).toContain("n-collapsed");
  });

  it("counts edges and nodes hidden by fact filters instead of silently deleting them", () => {
    const projection = projectGraph(
      baseGraph(),
      { relationshipTypes: ["managed_copy"], statuses: [] },
      ALL_DISPLAY_ON,
    );

    // e2 (import_copy), e3 (managed_link), e4 (shared_directory_read), e5 (observed_copy) 被筛选隐藏。
    expect(projection.hiddenEdgeCount).toBe(4);
    // 结构边 e1、e6 永远不被事实筛选删除。
    const visibleEdgeIds = projection.edges.map((projected) => projected.edge.edge_id);
    expect(visibleEdgeIds.sort()).toEqual(["e1", "e6"]);

    const filteredChips = projection.collapsed.filter((chip) => chip.reason === "filtered");
    const byKind = new Map(filteredChips.map((chip) => [chip.kind, chip.count]));
    expect(byKind.get("skill")).toBe(1);
    expect(byKind.get("agent")).toBe(1);
    expect(byKind.get("directory")).toBe(1);
    expect(byKind.get("source")).toBe(1);
  });

  it("keeps a context node visible when at least one of its edges survives the filters", () => {
    const graph = baseGraph();
    graph.edges.push(
      edge({
        edge_id: "e7",
        to_node_id: "n-agent-1",
        kind: "deployment",
        relationship: "managed_link",
        active: true,
      }),
    );

    const projection = projectGraph(
      graph,
      { relationshipTypes: ["managed_link"], statuses: [] },
      ALL_DISPLAY_ON,
    );
    const visibleIds = projection.edges.map((projected) => projected.edge.edge_id);
    expect(visibleIds.sort()).toEqual(["e3", "e6", "e7"]);
    const agent = projection.nodes.find((node) => node.node.node_id === "n-agent-1");
    expect(agent?.layer).toBe("context");
    expect(projection.collapsed.filter((chip) => chip.kind === "agent" && chip.reason === "filtered")).toEqual([]);
  });

  it("hides context categories via display settings only, and still reports the hidden counts", () => {
    const projection = projectGraph(baseGraph(), NO_FILTERS, {
      ...ALL_DISPLAY_ON,
      showAgentsProjects: false,
      showSources: false,
    });

    const contextIds = projection.nodes
      .filter((node) => node.layer === "context")
      .map((node) => node.node.node_id);
    expect(contextIds).toEqual(["n-conflict-1", "n-dir-1"]);
    const hiddenChips = projection.collapsed.filter((chip) => chip.reason === "displayOff");
    const byKind = new Map(hiddenChips.map((chip) => [chip.kind, chip.count]));
    expect(byKind.get("agent")).toBe(1);
    expect(byKind.get("source")).toBe(1);
  });
});

describe("filter purity", () => {
  it("never mutates the query result and never changes the reported facts", () => {
    const graph = frozen(baseGraph());
    const snapshot = frozen(graph);

    const projection = projectGraph(
      graph,
      { relationshipTypes: ["managed_copy"], statuses: ["content_verified"] },
      ALL_DISPLAY_ON,
    );

    expect(graph).toEqual(snapshot);
    expect(projection.factCounts).toEqual(snapshot.fact_counts);
    expect(projection.relationshipRevision).toBe("r42");
    expect(projection.centerSkillId).toBe("pdf-reader");
  });

  it("falls back to the raw graph when the center node is missing instead of throwing", () => {
    const graph = baseGraph();
    graph.nodes = graph.nodes.filter((node) => node.node_id !== "n-center");

    const projection = projectGraph(graph, NO_FILTERS, ALL_DISPLAY_ON);
    expect(projection.nodes).toHaveLength(0);
    expect(projection.edges).toHaveLength(0);
    expect(projection.centerSkillId).toBe("pdf-reader");
  });

  it("exposes the fixed canvas coordinate space for the renderer", () => {
    expect(CANVAS_SIZE.width).toBeGreaterThan(0);
    expect(CANVAS_SIZE.height).toBeGreaterThan(0);
  });
});
