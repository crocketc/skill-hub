import { CANVAS_SIZE, type GraphProjection, type ProjectedNode } from "./graphProjection";

export interface NodePosition {
  x: number;
  y: number;
}

/** node_id → 画布坐标。 */
export type ForcePositions = Record<string, NodePosition>;

/**
 * DEV-24 技能图谱力导向布局。
 *
 * 选型对比（2026-09-20 记录，四份文档同步）：
 * - sigma.js v3 + graphology：WebGL 渲染，受益规模在数千节点以上；本项目
 *   量级（当前 ≤ 数百节点）用不上，且引入两个运行时依赖与一套渲染循环。
 * - d3-force：力导向算法参考实现；算法本身简单（斥力 + 弹簧 + 向心力）。
 * - 本实现：按 d3-force 同一族力学（库仑斥力 + 胡克弹簧 + 向心力）在仓库内
 *   实现一个**确定性**子集——固定迭代次数、种子化抖动为零（初始坐标取自
 *   原分层投影，互不重叠，无需随机扰动），保证 E2E/单测可复现，零新增依赖。
 *   节点量级跨过数百后如需 WebGPU/Canvas 加速，再迁移 sigma.js。
 *
 * 交互契约：结果只影响坐标；节点拖拽把 `fx/fy` 语义落为 overrides（见
 * SkillGraphPage），关系事实刷新时以 overrides 为起点继续松弛。
 */
export function computeForceLayout(
  projection: GraphProjection,
  options: { iterations?: number; overrides?: ForcePositions } = {},
): ForcePositions {
  const iterations = options.iterations ?? 160;
  const overrides = options.overrides ?? {};
  const centerX = CANVAS_SIZE.width / 2;
  const centerY = CANVAS_SIZE.height / 2;

  const nodes = projection.nodes.map((projected, index) => {
    const pinned = overrides[projected.node.node_id];
    return {
      id: projected.node.node_id,
      // 初始坐标：分层投影的位置（互不重叠、确定性）；缺省时按圆周铺开。
      x: pinned?.x ?? projected.x ?? centerX + Math.cos((index / projection.nodes.length) * Math.PI * 2) * 220,
      y: pinned?.y ?? projected.y ?? centerY + Math.sin((index / projection.nodes.length) * Math.PI * 2) * 150,
      pinned: Boolean(pinned),
    };
  });
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));

  const links = projection.edges
    .map((projected) => {
      const from = indexById.get(projected.edge.from_node_id);
      const to = indexById.get(projected.edge.to_node_id);
      return from !== undefined && to !== undefined ? { from, to } : null;
    })
    .filter((link): link is { from: number; to: number } => link !== null);

  const REPULSION = 26000;
  const SPRING_LENGTH = 150;
  const SPRING_STRENGTH = 0.02;
  const GRAVITY = 0.03;
  const MAX_STEP = 18;

  const positions = nodes.map((node) => ({ x: node.x, y: node.y }));

  for (let step = 0; step < iterations; step += 1) {
    // 冷却：从粗调到精调，收敛后静止（确定性）。
    const alpha = 1 - step / iterations;
    const forceX = new Array<number>(nodes.length).fill(0);
    const forceY = new Array<number>(nodes.length).fill(0);

    // 库仑斥力（全对全）。
    for (let a = 0; a < nodes.length; a += 1) {
      for (let b = a + 1; b < nodes.length; b += 1) {
        let dx = positions[a].x - positions[b].x;
        let dy = positions[a].y - positions[b].y;
        let distance = Math.hypot(dx, dy);
        if (distance < 1e-3) {
          // 完全重合时给一个固定方向（确定性，避免随机抖动）。
          dx = 1;
          dy = 1;
          distance = Math.SQRT2;
        }
        const strength = REPULSION / (distance * distance);
        const fx = (dx / distance) * strength;
        const fy = (dy / distance) * strength;
        forceX[a] += fx;
        forceY[a] += fy;
        forceX[b] -= fx;
        forceY[b] -= fy;
      }
    }

    // 胡克弹簧：相连节点彼此拉近到理想边长。
    for (const link of links) {
      const dx = positions[link.to].x - positions[link.from].x;
      const dy = positions[link.to].y - positions[link.from].y;
      const distance = Math.hypot(dx, dy) || 1e-3;
      const strength = SPRING_STRENGTH * (distance - SPRING_LENGTH);
      const fx = (dx / distance) * strength;
      const fy = (dy / distance) * strength;
      forceX[link.from] += fx;
      forceY[link.from] += fy;
      forceX[link.to] -= fx;
      forceY[link.to] -= fy;
    }

    // 向心力 + 限步积分；拖拽钉住的节点不参与积分。
    for (let index = 0; index < nodes.length; index += 1) {
      if (nodes[index].pinned) continue;
      forceX[index] += (centerX - positions[index].x) * GRAVITY;
      forceY[index] += (centerY - positions[index].y) * GRAVITY;
      const magnitude = Math.hypot(forceX[index], forceY[index]) || 1e-6;
      const scale = Math.min(1, MAX_STEP * alpha / magnitude);
      positions[index].x += forceX[index] * scale;
      positions[index].y += forceY[index] * scale;
      positions[index].x = Math.max(40, Math.min(CANVAS_SIZE.width - 40, positions[index].x));
      positions[index].y = Math.max(30, Math.min(CANVAS_SIZE.height - 30, positions[index].y));
    }
  }

  const result: ForcePositions = {};
  for (let index = 0; index < nodes.length; index += 1) {
    result[nodes[index].id] = { x: positions[index].x, y: positions[index].y };
  }
  return result;
}


/** 用力学结果重写投影坐标（节点 x/y 与边端点），返回新的投影对象。 */
export function applyPositions(
  projection: GraphProjection,
  positions: ForcePositions,
): GraphProjection {
  const fallback = (projected: ProjectedNode) => ({
    x: positions[projected.node.node_id]?.x ?? projected.x,
    y: positions[projected.node.node_id]?.y ?? projected.y,
  });
  const nodes = projection.nodes.map((projected) => {
    const { x, y } = fallback(projected);
    return { ...projected, x, y };
  });
  const edges = projection.edges.map((projected) => {
    const from = positions[projected.edge.from_node_id];
    const to = positions[projected.edge.to_node_id];
    if (!from || !to) return projected;
    return { ...projected, x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  });
  return { ...projection, nodes, edges };
}
