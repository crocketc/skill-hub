import { describe, expect, it } from "vitest";
import { CANVAS_SIZE, type GraphProjection } from "./graphProjection";
import { applyPositions, computeForceLayout } from "./forceLayout";

function projectionFixture(nodeCount: number): GraphProjection {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    node: {
      node_id: `node-${index}`,
      kind: "skill" as const,
      skill_id: `skill-${index}`,
      relation_id: null,
      provenance_id: null,
      conflict_id: null,
      agent_client_id: null,
      directory_node_id: null,
      path: null,
      role: null,
      profile_id: null,
      collapsed_kind: null,
      last_verified_at: null,
      collapsed_count: null,
    },
    layer: "center" as const,
    x: 120 + index * 30,
    y: 200,
  }));
  const edges = nodes.slice(1).map((node, index) => ({
    edge: {
      edge_id: `edge-${index}`,
      from_node_id: nodes[index].node.node_id,
      to_node_id: node.node.node_id,
      kind: "related" as const,
      relationship: null,
      relation_id: null,
      provenance_id: null,
      conflict_id: null,
      active: true,
    },
    line: "structural" as const,
    state: "verified" as const,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
  }));
  return {
    centerSkillId: "skill-0",
    relationshipRevision: "r1",
    lastVerifiedAt: null,
    factCounts: { deployment_relations: 0, source_relations: 0, conflict_cases: 0 },
    nodes,
    edges,
    collapsed: [],
    hiddenEdgeCount: 0,
  } as unknown as GraphProjection;
}

describe("computeForceLayout (DEV-24)", () => {
  it("is deterministic for the same input", () => {
    const projection = projectionFixture(6);
    const first = computeForceLayout(projection);
    const second = computeForceLayout(projection);
    expect(first).toEqual(second);
  });

  it("keeps connected nodes closer than disconnected ones (force-directed)", () => {
    const projection = projectionFixture(5);
    const positions = computeForceLayout(projection);
    const distance = (a: string, b: string) =>
      Math.hypot(positions[a].x - positions[b].x, positions[a].y - positions[b].y);
    const linked = distance("node-0", "node-1");
    const unlinked = distance("node-0", "node-4");
    expect(linked).toBeLessThan(unlinked);
  });

  it("respects dragged (pinned) overrides", () => {
    const projection = projectionFixture(4);
    const positions = computeForceLayout(projection, {
      overrides: { "node-2": { x: 10, y: 20 } },
    });
    expect(positions["node-2"]).toEqual({ x: 10, y: 20 });
  });

  it("adapts the layout to the available canvas and node density", () => {
    const projection = projectionFixture(6);
    const compact = computeForceLayout(projection, {
      width: 480,
      height: 320,
      nodeWidth: 96,
      nodeHeight: 32,
    });
    const roomy = computeForceLayout(projection, {
      width: 1280,
      height: 760,
      nodeWidth: 160,
      nodeHeight: 48,
    });

    expect(compact).not.toEqual(roomy);
    for (const position of Object.values(compact)) {
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.x).toBeLessThanOrEqual(480);
      expect(position.y).toBeGreaterThanOrEqual(0);
      expect(position.y).toBeLessThanOrEqual(320);
    }
  });

  it("keeps estimated node boxes from overlapping when the canvas has room", () => {
    const projection = projectionFixture(8);
    const positions = computeForceLayout(projection, {
      width: 1280,
      height: 760,
      nodeWidth: 160,
      nodeHeight: 48,
    });
    const nodes = Object.values(positions);
    for (let index = 0; index < nodes.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < nodes.length; otherIndex += 1) {
        const first = nodes[index];
        const second = nodes[otherIndex];
        const separatedOnAxis =
          Math.abs(first.x - second.x) >= 172 || Math.abs(first.y - second.y) >= 60;
        expect(separatedOnAxis).toBe(true);
      }
    }
  });

  it("applies positions onto the projection including edge endpoints", () => {
    const projection = projectionFixture(3);
    const positions = computeForceLayout(projection);
    const laid = applyPositions(projection, positions);
    for (const projected of laid.nodes) {
      const position = positions[projected.node.node_id];
      expect(projected.x).toBe(position.x);
      expect(projected.y).toBe(position.y);
    }
    const firstEdge = laid.edges[0];
    expect(firstEdge.x1).toBe(positions[firstEdge.edge.from_node_id].x);
    expect(firstEdge.y2).toBe(positions[firstEdge.edge.to_node_id].y);
    // 坐标保持在画布边界内。
    for (const projected of laid.nodes) {
      expect(projected.x).toBeGreaterThanOrEqual(0);
      expect(projected.x).toBeLessThanOrEqual(CANVAS_SIZE.width);
      expect(projected.y).toBeGreaterThanOrEqual(0);
      expect(projected.y).toBeLessThanOrEqual(CANVAS_SIZE.height);
    }
  });
});
