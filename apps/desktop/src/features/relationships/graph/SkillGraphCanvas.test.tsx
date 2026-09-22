import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../../i18n";
import {
  ALL_DISPLAY_ON,
  CANVAS_SIZE,
  type GraphFactFilters,
  projectGraph,
} from "./graphProjection";
import { SkillGraphCanvas, type GraphViewport } from "./SkillGraphCanvas";
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
      },
    ],
    fact_counts: { deployment_relations: 1, source_relations: 0, conflict_cases: 1 },
    collapsed_count: 2,
    relationship_revision: "r42",
    last_verified_at: LAST_VERIFIED,
  };
}

const NO_FILTERS: GraphFactFilters = { relationshipTypes: [], statuses: [] };

async function renderCanvas(options: {
  onBeforeJump?: () => void;
  onFocusSkill?: (skillId: string) => void;
  onSelectEdge?: (edgeId: string | null) => void;
  onSelectNode?: (nodeId: string | null) => void;
  onViewportChange?: (viewport: GraphViewport) => void;
  layoutSize?: GraphLayoutSize;
  selectedEdgeId?: string | null;
  selectedNodeId?: string | null;
  viewport?: GraphViewport;
}) {
  const i18n = await createSkillHubI18n(["en-US"]);
  const projection = projectGraph(graphFixture(), NO_FILTERS, ALL_DISPLAY_ON);
  const viewport = options.viewport ?? { x: 0, y: 0, zoom: 1 };
  render(
    <I18nextProvider i18n={i18n}>
      <SkillGraphCanvas
        onBeforeJump={options.onBeforeJump}
        onFocusSkill={options.onFocusSkill ?? (() => {})}
        onSelectEdge={options.onSelectEdge ?? (() => {})}
        onSelectNode={options.onSelectNode ?? (() => {})}
        onViewportChange={options.onViewportChange ?? (() => {})}
        layoutSize={options.layoutSize}
        projection={projection}
        selectedEdgeId={options.selectedEdgeId ?? null}
        selectedNodeId={options.selectedNodeId ?? null}
        viewport={viewport}
      />
    </I18nextProvider>,
  );
  return projection;
}

describe("SkillGraphCanvas interaction", () => {
  it("refocuses the graph when a related Skill is clicked", async () => {
    const onFocusSkill = vi.fn();
    const onSelectNode = vi.fn();
    await renderCanvas({ onFocusSkill, onSelectNode });

    fireEvent.click(screen.getByRole("button", { name: "doc-reader" }));

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
    fireEvent.click(screen.getByRole("button", { name: "dir-central" }));
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
});
