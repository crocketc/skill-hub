import { CANVAS_SIZE, type GraphProjection, type ProjectedNode } from "./graphProjection";

export interface NodePosition {
  x: number;
  y: number;
}

/** node_id → 画布坐标。 */
export type ForcePositions = Record<string, NodePosition>;

export interface GraphLayoutSize {
  width: number;
  height: number;
}

export interface ForceLayoutOptions {
  iterations?: number;
  overrides?: ForcePositions;
  /** 可用图谱区域的宽高；缺省为设计基准画布。 */
  width?: number;
  height?: number;
  /** 节点的估算尺寸，用于密度与碰撞约束，而非替代真实 DOM 尺寸。 */
  nodeWidth?: number;
  nodeHeight?: number;
}

const DEFAULT_NODE_WIDTH = 192;
const DEFAULT_NODE_HEIGHT = 48;
const NODE_GAP = 12;

function positiveDimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function fitToBounds(value: number, minimum: number, maximum: number): number {
  return clamp(value, Math.min(minimum, maximum), Math.max(minimum, maximum));
}

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
  options: ForceLayoutOptions = {},
): ForcePositions {
  const iterations = options.iterations ?? 160;
  const overrides = options.overrides ?? {};
  const width = positiveDimension(options.width, CANVAS_SIZE.width);
  const height = positiveDimension(options.height, CANVAS_SIZE.height);
  const nodeWidth = positiveDimension(options.nodeWidth, DEFAULT_NODE_WIDTH);
  const nodeHeight = positiveDimension(options.nodeHeight, DEFAULT_NODE_HEIGHT);
  const centerX = width / 2;
  const centerY = height / 2;
  const horizontalMargin = Math.min(width / 2, nodeWidth / 2 + NODE_GAP);
  const verticalMargin = Math.min(height / 2, nodeHeight / 2 + NODE_GAP);
  const scale = Math.sqrt((width * height) / (CANVAS_SIZE.width * CANVAS_SIZE.height));
  const density = Math.sqrt(Math.max(1, projection.nodes.length) / 6);
  const springLength = clamp(150 * scale / density, nodeWidth + NODE_GAP, Math.max(nodeWidth + NODE_GAP, Math.max(width, height) / 2));
  const minimumDistanceX = nodeWidth + NODE_GAP;
  const minimumDistanceY = nodeHeight + NODE_GAP;

  const nodes = projection.nodes.map((projected, index) => {
    const pinned = overrides[projected.node.node_id];
    const initialX = projected.x ?? centerX;
    const initialY = projected.y ?? centerY;
    return {
      id: projected.node.node_id,
      // 初始坐标：分层投影的位置（互不重叠、确定性）；缺省时按圆周铺开。
      x: pinned?.x ?? fitToBounds(
        (projected.x !== undefined
          ? (initialX / CANVAS_SIZE.width) * width
          : centerX + Math.cos((index / projection.nodes.length) * Math.PI * 2) * width * 0.22),
        horizontalMargin,
        width - horizontalMargin,
      ),
      y: pinned?.y ?? fitToBounds(
        (projected.y !== undefined
          ? (initialY / CANVAS_SIZE.height) * height
          : centerY + Math.sin((index / projection.nodes.length) * Math.PI * 2) * height * 0.22),
        verticalMargin,
        height - verticalMargin,
      ),
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

  const REPULSION = 26000 * Math.max(0.55, scale) / Math.max(1, density);
  const SPRING_LENGTH = springLength;
  const SPRING_STRENGTH = 0.02 * Math.max(0.75, Math.min(1.5, density));
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

        // 矩形碰撞约束：节点标签是主要阅读内容，不能只依靠点斥力避让。
        // 只在两个轴都重叠时施力，保留力导向布局的横向探索空间。
        const overlapX = minimumDistanceX - Math.abs(dx);
        const overlapY = minimumDistanceY - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX <= overlapY) {
            const direction = dx === 0 ? (a % 2 === 0 ? 1 : -1) : Math.sign(dx);
            const correction = overlapX * 0.18;
            forceX[a] += direction * correction;
            forceX[b] -= direction * correction;
          } else {
            const direction = dy === 0 ? (b % 2 === 0 ? 1 : -1) : Math.sign(dy);
            const correction = overlapY * 0.18;
            forceY[a] += direction * correction;
            forceY[b] -= direction * correction;
          }
        }
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
      positions[index].x = fitToBounds(
        positions[index].x,
        horizontalMargin,
        width - horizontalMargin,
      );
      positions[index].y = fitToBounds(
        positions[index].y,
        verticalMargin,
        height - verticalMargin,
      );
    }
  }

  // 力学迭代结束后做少量确定性的分离，避免冷却阶段留下半个节点的重叠。
  // 空间不足时允许重叠，后续 fit-view 会整体缩放；不移动用户钉住的节点。
  for (let pass = 0; pass < 64; pass += 1) {
    let changed = false;
    for (let a = 0; a < nodes.length; a += 1) {
      for (let b = a + 1; b < nodes.length; b += 1) {
        let dx = positions[a].x - positions[b].x;
        let dy = positions[a].y - positions[b].y;
        const overlapX = minimumDistanceX - Math.abs(dx);
        const overlapY = minimumDistanceY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        changed = true;
        const moveX = overlapX <= overlapY;
        const direction = moveX
          ? (dx === 0 ? (a % 2 === 0 ? 1 : -1) : Math.sign(dx))
          : (dy === 0 ? (b % 2 === 0 ? 1 : -1) : Math.sign(dy));
        const amount = (moveX ? overlapX : overlapY) + 0.5;
        const firstPinned = nodes[a].pinned;
        const secondPinned = nodes[b].pinned;
        if (firstPinned && secondPinned) continue;
        const firstShare = firstPinned ? 0 : secondPinned ? 1 : 0.5;
        const secondShare = secondPinned ? 0 : firstPinned ? 1 : 0.5;
        if (moveX) {
          positions[a].x += direction * amount * firstShare;
          positions[b].x -= direction * amount * secondShare;
          positions[a].x = firstPinned ? positions[a].x : fitToBounds(positions[a].x, horizontalMargin, width - horizontalMargin);
          positions[b].x = secondPinned ? positions[b].x : fitToBounds(positions[b].x, horizontalMargin, width - horizontalMargin);
        } else {
          positions[a].y += direction * amount * firstShare;
          positions[b].y -= direction * amount * secondShare;
          positions[a].y = firstPinned ? positions[a].y : fitToBounds(positions[a].y, verticalMargin, height - verticalMargin);
          positions[b].y = secondPinned ? positions[b].y : fitToBounds(positions[b].y, verticalMargin, height - verticalMargin);
        }
        dx = positions[a].x - positions[b].x;
        dy = positions[a].y - positions[b].y;
      }
    }
    if (!changed) break;
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
