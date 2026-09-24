import type {
  RelationshipGraphEdgeKind,
  RelationshipGraphFactCounts,
  RelationshipGraphNodeKind,
  RelationshipGraphStatus,
  RelationshipType,
  SkillRelationshipEdge,
  SkillRelationshipGraphResult,
  SkillRelationshipNode,
  SourceCopyRelationFact,
} from "../../../api/bindings";

/**
 * 图谱投影（任务 6）：把任务 1 的单中心快照投影成固定坐标的分层布局。
 * 约束：只做一跳；上下文叶子永远不反向连到其他 Skill；筛选只隐藏展示，
 * 事实计数原样透传；被隐藏的节点折叠为带原因/数量的chip，绝不静默删节点。
 */

export const CANVAS_SIZE = { width: 960, height: 640 } as const;

/** 事实筛选：与 URL/query key 携带同一份筛选事实；空数组表示不筛选。 */
export interface GraphFactFilters {
  relationshipTypes: RelationshipType[];
  statuses: RelationshipGraphStatus[];
}

/** 显示设置：纯展示开关，不影响查询事实。 */
export interface GraphDisplaySettings {
  showSources: boolean;
  showAgentsProjects: boolean;
  showDirectories: boolean;
  showConflicts: boolean;
}

export const ALL_DISPLAY_ON: GraphDisplaySettings = {
  showSources: true,
  showAgentsProjects: true,
  showDirectories: true,
  showConflicts: true,
};

export type GraphNodeLayer = "center" | "related" | "context" | "collapsed";

export type GraphEdgeVisualState = "verified" | "inactive" | "unverified";

export type GraphEdgeLine = "solid" | "dashed" | "dotted";

export interface ProjectedNode {
  node: SkillRelationshipNode;
  layer: GraphNodeLayer;
  x: number;
  y: number;
}

export interface ProjectedEdge {
  edge: SkillRelationshipEdge;
  line: GraphEdgeLine;
  state: GraphEdgeVisualState;
  /**
   * 治理深链目标（任务 12B）：部署边自带 relation_id；来源边由当前
   * 来源副本台账按 latest_provenance_id 关联得出。null 表示只读事实，
   * 详情面板不得提供治理入口。
   */
  governanceRelationId: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 折叠/隐藏汇总：原因 + 类别 + 数量，UI 据此翻译文案。 */
export interface CollapsedGroup {
  kind: RelationshipGraphNodeKind;
  count: number;
  reason: "collapsed" | "filtered" | "displayOff";
}

export interface GraphProjection {
  centerSkillId: string;
  relationshipRevision: string;
  lastVerifiedAt: string | null;
  factCounts: RelationshipGraphFactCounts;
  nodes: ProjectedNode[];
  edges: ProjectedEdge[];
  collapsed: CollapsedGroup[];
  /** 被事实筛选隐藏的中心边数量（事实不变，只是不画）。 */
  hiddenEdgeCount: number;
}

const LAYER_PADDING = 70;
const RELATED_X = 150;
const CONTEXT_X = CANVAS_SIZE.width - 150;
const COLLAPSED_ROW_Y = CANVAS_SIZE.height - 44;

function edgeStatus(edge: SkillRelationshipEdge): RelationshipGraphStatus {
  if (edge.match_state !== null) {
    return edge.match_state;
  }
  return edge.active === false ? "released" : "active";
}

/** 边的事实状态标签键（节点/边详情共用）；字面量联合保证 i18n 键可查。 */
export type GraphStatusLabelKey = `relationships.graph.status.${RelationshipGraphStatus}`;

export function edgeStatusLabelKey(edge: SkillRelationshipEdge): GraphStatusLabelKey {
  return `relationships.graph.status.${edgeStatus(edge)}`;
}

/** 边的关系类型标签键；结构边（related_skill/conflict）退回按 kind 命名。 */
export type GraphEdgeLabelKey =
  | `relationships.graph.edgeType.${RelationshipType}`
  | `relationships.graph.edgeKind.${RelationshipGraphEdgeKind}`;

export function edgeTypeLabelKey(edge: SkillRelationshipEdge): GraphEdgeLabelKey {
  return edge.relationship !== null
    ? `relationships.graph.edgeType.${edge.relationship}`
    : `relationships.graph.edgeKind.${edge.kind}`;
}

/** 线型/颜色状态：实线=已验证，虚线=不可访问，点线=待校验（含 name_only/diverged）。 */
export function edgeVisual(edge: SkillRelationshipEdge): {
  line: GraphEdgeLine;
  state: GraphEdgeVisualState;
} {
  if (edge.active === false) {
    return { line: "dashed", state: "inactive" };
  }
  if (edge.match_state === "name_only" || edge.match_state === "diverged") {
    return { line: "dotted", state: "unverified" };
  }
  return { line: "solid", state: "verified" };
}

function edgeHiddenByFactFilters(
  edge: SkillRelationshipEdge,
  filters: GraphFactFilters,
): boolean {
  // 结构边（relationship 为 null，如冲突边）从不被事实筛选删除。
  if (edge.relationship !== null
    && filters.relationshipTypes.length > 0
    && !filters.relationshipTypes.includes(edge.relationship)) {
    return true;
  }
  if (filters.statuses.length > 0 && !filters.statuses.includes(edgeStatus(edge))) {
    return true;
  }
  return false;
}

function categoryShown(kind: RelationshipGraphNodeKind, display: GraphDisplaySettings): boolean {
  switch (kind) {
    case "source":
      return display.showSources;
    case "agent":
    case "project":
      return display.showAgentsProjects;
    case "directory":
      return display.showDirectories;
    case "conflict":
      return display.showConflicts;
    default:
      return true;
  }
}

function spreadY(count: number, index: number): number {
  if (count <= 0) return CANVAS_SIZE.height / 2;
  const usable = CANVAS_SIZE.height - 2 * LAYER_PADDING;
  return LAYER_PADDING + ((index + 0.5) * usable) / count;
}

/** 业务 locator 键（任务 12B）：同一在线来源/本地目录只合并为一个节点。 */
function sourceLocatorKey(source: NonNullable<SkillRelationshipNode["source"]>): string {
  // 生成的 SourceLocator 是互斥联合，这里按值判别而不是 kind 字段。
  const locator = source.locator as {
    local_path?: string;
    https_url?: string;
    git_url?: string;
  };
  if (locator.https_url) return `https:${locator.https_url}`;
  if (locator.git_url) return `git:${locator.git_url}`;
  if (locator.local_path) return `local:${locator.local_path}`;
  return `kind:${source.kind}`;
}

/**
 * 把快照投影为单中心、一跳、固定坐标的分层布局。
 * sourceCopies 是当前来源副本台账（任务 7/9）：来源边借此获得治理 relation
 * 深链；同一业务 locator 的多次 provenance 合并为一个展示节点。
 * 纯函数：不修改入参；事实计数与修订号原样透传。
 */
export function projectGraph(
  graph: SkillRelationshipGraphResult,
  filters: GraphFactFilters,
  display: GraphDisplaySettings,
  sourceCopies: readonly SourceCopyRelationFact[] = [],
): GraphProjection {
  const nodeById = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const center = nodeById.get(
    graph.nodes.find((node) => node.skill_id === graph.center_skill_id)?.node_id ?? "",
  );

  if (!center) {
    return {
      centerSkillId: graph.center_skill_id,
      relationshipRevision: graph.relationship_revision,
      lastVerifiedAt: graph.last_verified_at,
      factCounts: graph.fact_counts,
      nodes: [],
      edges: [],
      collapsed: [],
      hiddenEdgeCount: 0,
    };
  }

  // 任务 12B：来源节点按业务 locator 合并——同一 https/git URL 或本地目录的
  // 多次 provenance 事件共享一个展示节点（代表节点取 node_id 最小者，稳定）。
  const mergedNodeIdByRaw = new Map<string, string>();
  const mergedRepresentative = new Map<string, SkillRelationshipNode>();
  const sourceMembers = new Map<string, SkillRelationshipNode[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "source" || !node.source) continue;
    const key = sourceLocatorKey(node.source);
    const members = sourceMembers.get(key);
    if (members) {
      members.push(node);
    } else {
      sourceMembers.set(key, [node]);
    }
  }
  for (const [key, members] of sourceMembers) {
    members.sort((left, right) => left.node_id.localeCompare(right.node_id));
    const mergedId = `source-locator:${key}`;
    const representative = members[0];
    if (!representative) continue;
    mergedRepresentative.set(mergedId, { ...representative, node_id: mergedId });
    for (const member of members) {
      mergedNodeIdByRaw.set(member.node_id, mergedId);
    }
  }
  const displayNodeId = (rawId: string): string => mergedNodeIdByRaw.get(rawId) ?? rawId;

  // 边界：只保留恰好以中心为一端的边；上下文叶子/其他 Skill 之间的边一律丢弃。
  // 边端点同时改写为合并后的展示节点 id。
  const centerEdges: SkillRelationshipEdge[] = [];
  for (const candidate of graph.edges) {
    const from = nodeById.get(candidate.from_node_id);
    const to = nodeById.get(candidate.to_node_id);
    if (!from || !to) continue;
    if (
      (from.node_id === center.node_id && to.node_id !== center.node_id)
      || (to.node_id === center.node_id && from.node_id !== center.node_id)
    ) {
      const fromMerged = displayNodeId(candidate.from_node_id);
      const toMerged = displayNodeId(candidate.to_node_id);
      centerEdges.push(
        fromMerged === candidate.from_node_id && toMerged === candidate.to_node_id
          ? candidate
          : { ...candidate, from_node_id: fromMerged, to_node_id: toMerged },
      );
    }
  }

  const hiddenEdgeCount = centerEdges.filter((candidate) =>
    edgeHiddenByFactFilters(candidate, filters),
  ).length;

  const endpoints = new Map<string, SkillRelationshipNode>();
  for (const candidate of centerEdges) {
    const otherId = candidate.from_node_id === center.node_id
      ? candidate.to_node_id
      : candidate.from_node_id;
    const other = mergedRepresentative.get(otherId) ?? nodeById.get(otherId);
    if (other) {
      endpoints.set(otherId, other);
    }
  }

  const collapsedChips: CollapsedGroup[] = [];
  const filteredByKind = new Map<RelationshipGraphNodeKind, number>();
  const displayOffByKind = new Map<RelationshipGraphNodeKind, number>();
  const visibleNodeIds = new Set<string>([center.node_id]);

  for (const other of endpoints.values()) {
    if (other.kind === "collapsed") {
      continue;
    }
    const hasVisibleEdge = centerEdges.some((candidate) => {
      const otherId = candidate.from_node_id === center.node_id
        ? candidate.to_node_id
        : candidate.from_node_id;
      return otherId === other.node_id
        && !edgeHiddenByFactFilters(candidate, filters)
        && categoryShown(other.kind, display);
    });
    if (!hasVisibleEdge) {
      // 不静默删：折进带原因的chip。显示设置关闭优先于事实筛选计数。
      if (!categoryShown(other.kind, display)) {
        displayOffByKind.set(other.kind, (displayOffByKind.get(other.kind) ?? 0) + 1);
      } else {
        filteredByKind.set(other.kind, (filteredByKind.get(other.kind) ?? 0) + 1);
      }
      continue;
    }
    visibleNodeIds.add(other.node_id);
  }

  const projectedNodes: ProjectedNode[] = [
    { node: center, layer: "center", x: CANVAS_SIZE.width / 2, y: CANVAS_SIZE.height / 2 },
  ];

  // 同层按 node_id 排序：同一份数据永远得到同一布局（稳定分层）。
  const orderedEndpoints = [...endpoints.values()].sort((a, b) =>
    a.node_id.localeCompare(b.node_id),
  );
  const relatedNodes = orderedEndpoints.filter(
    (other) => other.kind === "skill" && visibleNodeIds.has(other.node_id),
  );
  relatedNodes.forEach((node, index) => {
    projectedNodes.push({ node, layer: "related", x: RELATED_X, y: spreadY(relatedNodes.length, index) });
  });

  const contextNodes = orderedEndpoints.filter(
    (other) => other.kind !== "skill" && other.kind !== "collapsed" && visibleNodeIds.has(other.node_id),
  );
  contextNodes.forEach((node, index) => {
    projectedNodes.push({ node, layer: "context", x: CONTEXT_X, y: spreadY(contextNodes.length, index) });
  });

  // 后端折叠节点：按折叠类别受显示设置约束，其余作为底部 chip 展示。
  const backendCollapsed = graph.nodes.filter((node) => node.kind === "collapsed");
  const collapsedRow: { label: string; x: number }[] = [];
  backendCollapsed.forEach((node) => {
    const kind = node.collapsed_kind ?? "skill";
    if (!categoryShown(kind, display)) {
      displayOffByKind.set(kind, (displayOffByKind.get(kind) ?? 0) + node.collapsed_count);
      return;
    }
    collapsedChips.push({ kind, count: node.collapsed_count, reason: "collapsed" });
    projectedNodes.push({ node, layer: "collapsed", x: 0, y: COLLAPSED_ROW_Y });
    collapsedRow.push({ label: node.node_id, x: 0 });
  });

  const positionCollapsedRow = () => {
    const row = projectedNodes.filter((node) => node.layer === "collapsed");
    row.forEach((node, index) => {
      node.x = spreadX(row.length, index);
    });
  };
  positionCollapsedRow();

  for (const [kind, count] of filteredByKind) {
    collapsedChips.push({ kind, count, reason: "filtered" });
  }
  for (const [kind, count] of displayOffByKind) {
    collapsedChips.push({ kind, count, reason: "displayOff" });
  }
  collapsedChips.sort((a, b) =>
    a.reason.localeCompare(b.reason) || a.kind.localeCompare(b.kind),
  );

  const projectedPosition = new Map(projectedNodes.map((node) => [node.node.node_id, node]));
  // 任务 12B：来源边的治理 relation 由当前来源副本台账按 provenance 关联。
  const relationByProvenance = new Map(
    sourceCopies.map((copy) => [copy.latest_provenance_id, copy.relation_id]),
  );
  const projectedEdges: ProjectedEdge[] = [];
  for (const candidate of centerEdges) {
    if (!edgeHiddenByFactFilters(candidate, filters)) {
      const from = projectedPosition.get(candidate.from_node_id);
      const to = projectedPosition.get(candidate.to_node_id);
      if (from && to) {
        const visual = edgeVisual(candidate);
        projectedEdges.push({
          edge: candidate,
          line: visual.line,
          state: visual.state,
          governanceRelationId: candidate.relation_id
            ?? (candidate.kind === "source" && candidate.provenance_id
              ? relationByProvenance.get(candidate.provenance_id) ?? null
              : null),
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
        });
      }
    }
  }

  return {
    centerSkillId: graph.center_skill_id,
    relationshipRevision: graph.relationship_revision,
    lastVerifiedAt: graph.last_verified_at,
    factCounts: graph.fact_counts,
    nodes: projectedNodes,
    edges: projectedEdges,
    collapsed: collapsedChips,
    hiddenEdgeCount,
  };
}

function spreadX(count: number, index: number): number {
  if (count <= 0) return CANVAS_SIZE.width / 2;
  const usable = CANVAS_SIZE.width - 2 * LAYER_PADDING;
  return LAYER_PADDING + ((index + 0.5) * usable) / count;
}
