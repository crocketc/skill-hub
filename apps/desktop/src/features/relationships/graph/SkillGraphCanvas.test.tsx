import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../../i18n";
import {
  ALL_DISPLAY_ON,
  CANVAS_SIZE,
  type GraphFactFilters,
  type GraphProjection,
  type ProjectedEdge,
  projectGraph,
} from "./graphProjection";
import { computeEdgeLabelPlacements, SkillGraphCanvas, type GraphViewport } from "./SkillGraphCanvas";
import type { GraphLayoutSize } from "./forceLayout";
import type { SkillRelationshipGraphResult } from "../api";

const LAST_VERIFIED = "2026-09-01T08:00:00Z";

function node(overrides: Partial<SkillRelationshipGraphResult["nodes"][number]>): SkillRelationshipGraphResult["nodes"][number] {
  return {
    node_id: "n",
    kind: "skill",
    skill_id: null,
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
    last_verified_at: null,
    ...overrides,
  };
}

function graphFixture(): SkillRelationshipGraphResult {
  return {
    center_skill_id: "pdf-reader",
    nodes: [
      node({ node_id: "n-center", kind: "skill", skill_id: "pdf-reader", last_verified_at: LAST_VERIFIED }),
      node({ node_id: "n-rel-1", kind: "skill", skill_id: "doc-reader" }),
      node({ node_id: "n-agent-1", kind: "agent", agent_client_id: "claude-code" }),
      node({ node_id: "n-dir-1", kind: "directory", directory_node_id: "dir-central" }),
      node({
        node_id: "n-conflict-1",
        kind: "conflict",
        conflict_id: "case-9",
      }),
      node({
        node_id: "n-collapsed",
        kind: "collapsed",
        collapsed_kind: "agent",
        collapsed_count: 2,
      }),
    ],
    edges: [
      {
        edge_id: "e1",
        from_node_id: "n-center",
        to_node_id: "n-rel-1",
        kind: "related_skill",
        relationship: "managed_copy",
        relation_id: "rel-1",
        provenance_id: null,
        conflict_id: null,
        match_state: "content_verified",
        active: true,
        last_verified_at: LAST_VERIFIED,
        governance: null,
        target_identity: null,
        evidence_relation_ids: [],
      },
      {
        edge_id: "e2",
        from_node_id: "n-center",
        to_node_id: "n-agent-1",
        kind: "deployment",
        relationship: "managed_link",
        relation_id: "rel-2",
        provenance_id: null,
        conflict_id: null,
        match_state: null,
        active: true,
        last_verified_at: LAST_VERIFIED,
        governance: null,
        target_identity: null,
        evidence_relation_ids: [],
      },
      {
        edge_id: "e3",
        from_node_id: "n-center",
        to_node_id: "n-dir-1",
        kind: "located_in",
        relationship: "shared_directory_read",
        relation_id: null,
        provenance_id: null,
        conflict_id: null,
        match_state: null,
        active: false,
        last_verified_at: null,
        governance: null,
        target_identity: null,
        evidence_relation_ids: [],
      },
      {
        edge_id: "e4",
        from_node_id: "n-center",
        to_node_id: "n-conflict-1",
        kind: "conflict",
        relationship: null,
        relation_id: null,
        provenance_id: null,
        conflict_id: "case-9",
        match_state: null,
        active: null,
        last_verified_at: null,
        governance: null,
        target_identity: null,
        evidence_relation_ids: [],
      },
    ],
    fact_counts: { deployment_relations: 1, source_relations: 0, conflict_cases: 1, usage_relations: 1 },
    collapsed_count: 2,
    relationship_revision: "r42",
    last_verified_at: LAST_VERIFIED,
  };
}

function sparseProjection(): GraphProjection {
  const graph = graphFixture();
  const nodes = graph.nodes.filter((candidate) =>
    ["n-center", "n-agent-1", "n-dir-1"].includes(candidate.node_id),
  );
  const edges = graph.edges.filter((candidate) => ["e2", "e3"].includes(candidate.edge_id));
  return projectGraph({ ...graph, nodes, edges }, NO_FILTERS, ALL_DISPLAY_ON);
}

const NO_FILTERS: GraphFactFilters = { relationshipTypes: [], statuses: [], governance: [], management: [] };

async function renderCanvas(options: {
  onBeforeJump?: () => void;
  onFocusSkill?: (skillId: string) => void;
  onSelectEdge?: (edgeId: string | null) => void;
  onSelectNode?: (nodeId: string | null) => void;
  onViewportChange?: (viewport: GraphViewport) => void;
  onNodeDrag?: (nodeId: string, x: number, y: number) => void;
  onNodeDragStart?: (nodeId: string) => void;
  onNodeDragEnd?: (nodeId: string) => void;
  resolveSkillName?: (skillId: string) => string | undefined;
  layoutSize?: GraphLayoutSize;
  projection?: GraphProjection;
  selectedEdgeId?: string | null;
  selectedNodeId?: string | null;
  viewport?: GraphViewport;
}) {
  const i18n = await createSkillHubI18n(["en-US"]);
  const projection = options.projection ?? projectGraph(graphFixture(), NO_FILTERS, ALL_DISPLAY_ON);
  const viewport = options.viewport ?? { x: 0, y: 0, zoom: 1 };
  render(
    <I18nextProvider i18n={i18n}>
      <SkillGraphCanvas
        onBeforeJump={options.onBeforeJump}
        onFocusSkill={options.onFocusSkill ?? (() => {})}
        onSelectEdge={options.onSelectEdge ?? (() => {})}
        onSelectNode={options.onSelectNode ?? (() => {})}
        onViewportChange={options.onViewportChange ?? (() => {})}
        onNodeDrag={options.onNodeDrag}
        onNodeDragStart={options.onNodeDragStart}
        onNodeDragEnd={options.onNodeDragEnd}
        layoutSize={options.layoutSize}
        projection={projection}
        selectedEdgeId={options.selectedEdgeId ?? null}
        selectedNodeId={options.selectedNodeId ?? null}
        viewport={viewport}
        resolveSkillName={options.resolveSkillName ?? ((skillId) => ({
          "pdf-reader": "PDF Reader",
          "doc-reader": "Document Reader",
        }[skillId]))}
      />
    </I18nextProvider>,
  );
  return projection;
}

function ControlledCanvas({ initialViewport }: { initialViewport: GraphViewport }) {
  const [viewport, setViewport] = useState(initialViewport);
  const projection = projectGraph(graphFixture(), NO_FILTERS, ALL_DISPLAY_ON);
  return (
    <SkillGraphCanvas
      onFocusSkill={() => {}}
      onSelectEdge={() => {}}
      onSelectNode={() => {}}
      onViewportChange={setViewport}
      projection={projection}
      selectedEdgeId={null}
      selectedNodeId={null}
      viewport={viewport}
    />
  );
}

describe("SkillGraphCanvas interaction", () => {
  it("keeps internal conflict and fallback node IDs out of canvas labels", async () => {
    const graph = graphFixture();
    graph.nodes = [
      graph.nodes[0]!,
      node({
        node_id: "conflict-node-internal-9",
        kind: "conflict",
        conflict_id: "conflict-case-opaque-42",
      }),
      node({ node_id: "source-node-internal-77", kind: "source" }),
    ];
    graph.edges = [
      {
        ...graph.edges[3]!,
        edge_id: "edge-conflict-internal-1",
        from_node_id: "n-center",
        to_node_id: "conflict-node-internal-9",
        conflict_id: "conflict-case-opaque-42",
      },
      {
        ...graph.edges[0]!,
        edge_id: "edge-source-internal-1",
        from_node_id: "n-center",
        to_node_id: "source-node-internal-77",
        kind: "source",
        relationship: null,
        relation_id: null,
        match_state: null,
      },
    ];
    const projection = projectGraph(graph, NO_FILTERS, ALL_DISPLAY_ON);
    await renderCanvas({ projection });

    expect(screen.getByRole("button", { name: /Conflict/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Source/ })).toBeVisible();
    expect(screen.queryByText("conflict-case-opaque-42")).not.toBeInTheDocument();
    expect(screen.queryByText("conflict-node-internal-9")).not.toBeInTheDocument();
    expect(screen.queryByText("source-node-internal-77")).not.toBeInTheDocument();
  });

  it("does not fall back to an internal Skill ID when a display name is unavailable", async () => {
    const graph = graphFixture();
    graph.center_skill_id = "skill-id-internal-42";
    graph.nodes = [
      node({ node_id: "skill-node-internal-42", kind: "skill", skill_id: "skill-id-internal-42" }),
    ];
    graph.edges = [];
    const projection = projectGraph(graph, NO_FILTERS, ALL_DISPLAY_ON);
    expect(projection.nodes).toHaveLength(1);
    await renderCanvas({ projection, resolveSkillName: () => undefined });

    expect(screen.getByRole("button", { name: "Skill" })).toBeVisible();
    expect(screen.queryByText("skill-id-internal-42")).not.toBeInTheDocument();
    expect(screen.queryByText("skill-node-internal-42")).not.toBeInTheDocument();
  });

  it("labels shared directory nodes without exposing IDs and keeps the intermediate topology", async () => {
    const graph = graphFixture();
    graph.nodes = [
      graph.nodes[0]!,
      node({ node_id: "n-shared-internal", kind: "directory", directory_node_id: "directory-internal-42", role: "shared_directory" }),
      node({ node_id: "n-agent-codex", kind: "agent", agent_client_id: "openai.codex-cli" }),
      node({ node_id: "n-agent-claude", kind: "agent", agent_client_id: "claude-code" }),
    ];
    graph.edges = [
      { ...graph.edges[2]!, edge_id: "e-skill-shared", kind: "shared", to_node_id: "n-shared-internal" },
      { ...graph.edges[2]!, edge_id: "e-shared-codex", kind: "shared", from_node_id: "n-shared-internal", to_node_id: "n-agent-codex", relationship: null, relation_id: null, match_state: null, active: null },
      { ...graph.edges[2]!, edge_id: "e-shared-claude", kind: "shared", from_node_id: "n-shared-internal", to_node_id: "n-agent-claude", relationship: null, relation_id: null, match_state: null, active: null },
    ];
    const projection = projectGraph(graph, NO_FILTERS, ALL_DISPLAY_ON);
    await renderCanvas({ projection });

    expect(screen.getByRole("button", { name: /Shared directory/ })).toBeVisible();
    expect(screen.queryByText("directory-internal-42")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OpenAI.*Terminal/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Claude.*Terminal/ })).toBeVisible();
    expect(screen.getByTestId("skill-graph-surface").querySelectorAll(".sh-graph-edge__line")).toHaveLength(3);
  });

  it("marks sparse graphs for compact node presentation", async () => {
    await renderCanvas({ projection: sparseProjection() });

    expect(screen.getByTestId("skill-graph-surface")).toHaveClass(
      "sh-graph-canvas__surface--sparse",
    );
  });

  it("exposes a stable node-drag lifecycle and prevents text selection", async () => {
    const onNodeDrag = vi.fn();
    const onNodeDragStart = vi.fn();
    const onNodeDragEnd = vi.fn();
    await renderCanvas({ onNodeDrag, onNodeDragStart, onNodeDragEnd });

    const node = screen.getByRole("button", { name: /PDF Reader/ });
    fireEvent.pointerDown(node, { pointerId: 3, clientX: 100, clientY: 100 });
    expect(onNodeDragStart).toHaveBeenCalledWith("n-center");
    expect(screen.getByTestId("skill-graph-surface")).toHaveClass("is-dragging");

    fireEvent.pointerMove(node, { pointerId: 3, clientX: 130, clientY: 120 });
    expect(onNodeDrag).toHaveBeenCalled();
    fireEvent.pointerUp(node, { pointerId: 3, clientX: 130, clientY: 120 });
    expect(onNodeDragEnd).toHaveBeenCalledWith("n-center");
    expect(screen.getByTestId("skill-graph-surface")).not.toHaveClass("is-dragging");
  });

  it("applies control clicks to the rendered viewport transform", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <ControlledCanvas initialViewport={{ x: 10, y: 20, zoom: 1 }} />
      </I18nextProvider>,
    );

    const layer = screen.getByTestId("skill-graph-surface").querySelector<HTMLElement>(".sh-graph-canvas__layer");
    expect(layer?.style.transform).toBe("translate(10px, 20px) scale(1)");

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(layer?.style.transform).toBe("translate(10px, 20px) scale(1.2)");

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(layer?.style.transform).toBe("translate(10px, 20px) scale(1)");

    const surface = screen.getByTestId("skill-graph-surface");
    Object.defineProperty(surface, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(surface, "clientHeight", { configurable: true, value: 600 });
    fireEvent.click(screen.getByRole("button", { name: "Fit content (center all)" }));

    expect(layer?.style.transform).not.toBe("translate(10px, 20px) scale(1)");
  });

  it("does not replace a restored non-default viewport during the initial fit", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <ControlledCanvas initialViewport={{ x: 123, y: 45, zoom: 1.4 }} />
      </I18nextProvider>,
    );

    const layer = screen.getByTestId("skill-graph-surface").querySelector<HTMLElement>(".sh-graph-canvas__layer");
    expect(layer?.style.transform).toBe("translate(123px, 45px) scale(1.4)");
  });

  it("refocuses the graph when a related Skill is clicked", async () => {
    const onFocusSkill = vi.fn();
    const onSelectNode = vi.fn();
    await renderCanvas({ onFocusSkill, onSelectNode });

    fireEvent.click(screen.getByRole("button", { name: /Document Reader/ }));

    expect(onFocusSkill).toHaveBeenCalledTimes(1);
    expect(onFocusSkill).toHaveBeenCalledWith("doc-reader");
    expect(onSelectNode).not.toHaveBeenCalled();
  });

  it("only opens details for context leaves instead of refocusing", async () => {
    const onFocusSkill = vi.fn();
    const onSelectNode = vi.fn();
    await renderCanvas({ onFocusSkill, onSelectNode });

    fireEvent.click(screen.getByRole("button", { name: /Claude/ }));
    expect(onSelectNode).toHaveBeenCalledWith("n-agent-1");
    expect(onFocusSkill).not.toHaveBeenCalled();

    onFocusSkill.mockClear();
    onSelectNode.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Directory" }));
    expect(onSelectNode).toHaveBeenCalledWith("n-dir-1");
    expect(onFocusSkill).not.toHaveBeenCalled();
  });

  it("exposes every control as a keyboard-operable button", async () => {
    const onViewportChange = vi.fn();
    await renderCanvas({
      onViewportChange,
      viewport: { x: 10, y: 20, zoom: 1.5 },
    });

    for (const name of ["Zoom in", "Zoom out", "Fit content (center all)"]) {
      const control = screen.getByRole("button", { name });
      expect(control.tagName).toBe("BUTTON");
      expect(control.closest('[data-testid="skill-graph-surface"]')).not.toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(onViewportChange).toHaveBeenLastCalledWith({ x: 10, y: 20, zoom: 1.8 });

    // DEV-24：重置语义升级为 fit-view（内容整体居中）：以画布尺寸计算视口。
    Object.defineProperty(screen.getByRole("button", { name: "Fit content (center all)" }).closest(".sh-graph-canvas")?.querySelector(".sh-graph-canvas__surface"), "clientWidth", { value: 800 });
    Object.defineProperty(
      screen.getByRole("button", { name: "Fit content (center all)" }).closest(".sh-graph-canvas")?.querySelector(".sh-graph-canvas__surface"),
      "clientHeight",
      { value: 600 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Fit content (center all)" }));
    expect(onViewportChange).toHaveBeenCalled();
  });

  it("does not promise keyboard canvas drag or zoom", async () => {
    await renderCanvas({});

    // 画布表面不可聚焦、不绑定键盘拖拽/缩放：键鼠承诺只落在控件按钮上。
    const surface = screen.getByTestId("skill-graph-surface");
    expect(surface.getAttribute("tabindex")).toBeNull();
  });

  it("uses the adaptive layout size for the SVG drawing surface", async () => {
    await renderCanvas({ layoutSize: { width: 720, height: 420 } });

    const surface = screen.getByTestId("skill-graph-surface");
    const layer = surface.querySelector<HTMLElement>(".sh-graph-canvas__layer");
    const svg = surface.querySelector<SVGSVGElement>(".sh-graph-canvas__edges");
    expect(layer?.style.width).toBe("720px");
    expect(layer?.style.height).toBe("420px");
    expect(svg?.getAttribute("width")).toBe("720");
    expect(svg?.getAttribute("height")).toBe("420");
  });

  it("selects an edge through its widened hit line", async () => {
    const onSelectEdge = vi.fn();
    const projection = await renderCanvas({ onSelectEdge });

    const projectedEdge = projection.edges.find(
      (candidate) => candidate.edge.edge_id === "e1",
    );
    expect(projectedEdge).toBeDefined();
    fireEvent.click(screen.getByTestId("edge-hit-e1"));

    expect(onSelectEdge).toHaveBeenCalledWith("e1");
    expect(CANVAS_SIZE.width).toBeGreaterThan(0);
  });

  it("pans when the pointer starts on the blank graph layer", async () => {
    const onViewportChange = vi.fn();
    await renderCanvas({ onViewportChange, viewport: { x: 10, y: 20, zoom: 1 } });

    const layer = screen.getByTestId("skill-graph-surface").querySelector<HTMLElement>(".sh-graph-canvas__layer");
    if (!layer) throw new Error("Expected the graph layer");
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 120 });
    Object.defineProperty(pointerDown, "pointerId", { value: 7 });
    fireEvent(layer, pointerDown);
    const pointerMove = new MouseEvent("pointermove", { bubbles: true, clientX: 140, clientY: 155 });
    Object.defineProperty(pointerMove, "pointerId", { value: 7 });
    fireEvent(screen.getByTestId("skill-graph-surface"), pointerMove);

    expect(onViewportChange).toHaveBeenLastCalledWith({ x: 50, y: 55, zoom: 1 });
  });

  it("elides graph path prefixes while keeping the normalized full path on the focused node", async () => {
    const graph = graphFixture();
    const longPath = "\\\\?\\C:\\Users\\profile\\AppData\\Local\\SkillHub\\agents\\codex\\skills\\pdf-reader";
    graph.nodes = graph.nodes.map((candidate) => candidate.node_id === "n-dir-1"
      ? { ...candidate, path: longPath }
      : candidate);
    const projection = projectGraph(graph, NO_FILTERS, ALL_DISPLAY_ON);
    await renderCanvas({ projection, selectedNodeId: "n-dir-1" });

    const normalized = "C:\\Users\\profile\\AppData\\Local\\SkillHub\\agents\\codex\\skills\\pdf-reader";
    const node = screen.getByRole("button", { name: `Directory: ${normalized}` });
    expect(node).toHaveAttribute("title", normalized);
    expect(node).toHaveTextContent("…\\codex\\skills\\pdf-reader");
  });
});

function projectedEdge(
  edgeId: string,
  coordinates: Pick<ProjectedEdge, "x1" | "y1" | "x2" | "y2">,
  pair?: { from: string; to: string },
): ProjectedEdge {
  return {
    edge: {
      edge_id: edgeId,
      from_node_id: pair?.from ?? "a",
      to_node_id: pair?.to ?? "b",
      kind: "related_skill",
      relationship: "managed_copy",
      relation_id: `rel-${edgeId}`,
      provenance_id: null,
      conflict_id: null,
      match_state: "content_verified",
      active: true,
      last_verified_at: null,
      governance: null,
      target_identity: null,
      evidence_relation_ids: [],
    },
    line: "solid",
    state: "verified",
    governanceRelationId: `rel-${edgeId}`,
    ...coordinates,
  };
}

describe("edge label placement (FB-③/D6-①)", () => {
  it("rotates labels along steep edges and keeps leftward edges readable", () => {
    const placements = computeEdgeLabelPlacements([
      projectedEdge("e-right", { x1: 0, y1: 0, x2: 200, y2: 0 }, { from: "a", to: "b" }),
      projectedEdge("e-steep", { x1: 0, y1: 0, x2: 0, y2: 200 }, { from: "c", to: "d" }),
      projectedEdge("e-left", { x1: 200, y1: 0, x2: 0, y2: 0 }, { from: "e", to: "f" }),
    ]);

    expect(placements.get("e-right")).toEqual({ angle: 0, x: 100, y: 0 });
    expect(placements.get("e-steep")?.angle).toBe(90);
    // 左右向的边翻转 180°：文字仍从左往右读，不会倒置。
    expect(placements.get("e-left")).toEqual({ angle: 0, x: 100, y: 0 });
  });

  it("spreads labels of parallel edges between the same node pair", () => {
    const placements = computeEdgeLabelPlacements([
      projectedEdge("e-1", { x1: 0, y1: 0, x2: 200, y2: 0 }, { from: "a", to: "b" }),
      projectedEdge("e-2", { x1: 0, y1: 0, x2: 200, y2: 0 }, { from: "b", to: "a" }),
      projectedEdge("e-3", { x1: 0, y1: 0, x2: 0, y2: 100 }, { from: "c", to: "d" }),
      projectedEdge("e-4", { x1: 0, y1: 0, x2: 100, y2: 100 }, { from: "e", to: "f" }),
    ]);

    const first = placements.get("e-1");
    const second = placements.get("e-2");
    expect(first?.x).toBe(second?.x);
    // 同源多边沿垂直方向错开一个固定步长（14px），互不压叠。
    expect(Math.abs((second?.y ?? 0) - (first?.y ?? 0))).toBe(14);
    // 不同节点对互不影响：单边标签仍在中点。
    expect(placements.get("e-3")).toEqual({ angle: 90, x: 0, y: 50 });
    expect(placements.get("e-4")).toEqual({ angle: 45, x: 50, y: 50 });
  });

  it("renders edge labels with rotated per-edge placement", async () => {
    await renderCanvas({});

    const labels = document.querySelectorAll("text[data-testid^='edge-label-']");
    expect(labels.length).toBeGreaterThan(0);
    labels.forEach((label) => {
      expect(label.getAttribute("transform")).toMatch(/rotate\(/);
    });
  });
});
