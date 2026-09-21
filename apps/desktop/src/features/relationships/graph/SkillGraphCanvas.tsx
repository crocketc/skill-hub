import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { displayPath } from "../../../platform/displayPath";
import {
  CANVAS_SIZE,
  edgeStatusLabelKey,
  edgeTypeLabelKey,
  type GraphProjection,
  type ProjectedNode,
} from "./graphProjection";
import "./graph.css";

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface SkillGraphCanvasProps {
  /** 跳转前保存返回状态（视口），供浏览器后退恢复。 */
  onBeforeJump?: () => void;
  onFocusSkill: (skillId: string) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onSelectNode: (nodeId: string | null) => void;
  onViewportChange: (viewport: GraphViewport) => void;
  /** DEV-24：节点拖拽落点回调（画布坐标）；缺省时节点不可拖拽。 */
  onNodeDrag?: (nodeId: string, x: number, y: number) => void;
  projection: GraphProjection;
  selectedEdgeId: string | null;
  selectedNodeId: string | null;
  viewport: GraphViewport;
  /** DEV-15：SkillId → 展示名解析；节点标签用名称，不裸显 UUID。 */
  resolveSkillName?: (skillId: string) => string | undefined;
  /** 变化时触发一次 fit-view（内容整体居中，DEV-24）。 */
  fitSignal?: unknown;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100));
}

function nodeLabel(
  node: ProjectedNode["node"],
  fallback: string,
  resolveSkillName?: (skillId: string) => string | undefined,
): string {
  switch (node.kind) {
    case "skill": {
      if (node.skill_id) {
        return resolveSkillName?.(node.skill_id) ?? node.skill_id;
      }
      return fallback;
    }
    case "agent":
      return node.agent_client_id ?? fallback;
    case "directory":
      return node.path ? displayPath(node.path) : node.directory_node_id ?? fallback;
    case "conflict":
      return node.conflict_id ?? fallback;
    case "source":
      return node.path ? displayPath(node.path) : fallback;
    default:
      return fallback;
  }
}

/**
 * 图谱画布（任务 6；DEV-24 重设计）：React/SVG 渲染 + 力导向坐标（页面侧
 * computeForceLayout）。交互：画布拖拽平移、滚轮缩放、节点可拖拽定位、
 * fit-view 内容整体居中；可键盘操作的控件按钮保留。
 */
export function SkillGraphCanvas({
  fitSignal,
  onBeforeJump,
  onFocusSkill,
  onNodeDrag,
  onSelectEdge,
  onSelectNode,
  onViewportChange,
  projection,
  resolveSkillName,
  selectedEdgeId,
  selectedNodeId,
  viewport,
}: SkillGraphCanvasProps) {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const nodeDragRef = useRef<{ nodeId: string; pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  const zoomBy = (factor: number) => {
    onViewportChange({ ...viewport, zoom: clampZoom(viewport.zoom * factor) });
  };

  /** DEV-24：fit-view——按当前内容包围盒缩放并居中（不再以选中 Skill 为锚）。 */
  const fitToContent = () => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const width = surface.clientWidth;
    const height = surface.clientHeight;
    if (width <= 0 || height <= 0 || projection.nodes.length === 0) {
      onViewportChange({ x: 0, y: 0, zoom: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const projected of projection.nodes) {
      minX = Math.min(minX, projected.x);
      minY = Math.min(minY, projected.y);
      maxX = Math.max(maxX, projected.x);
      maxY = Math.max(maxY, projected.y);
    }
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);
    const zoom = clampZoom(Math.min(width / (contentWidth + 160), height / (contentHeight + 160)));
    onViewportChange({
      x: (width - contentWidth * zoom) / 2 - minX * zoom,
      y: (height - contentHeight * zoom) / 2 - minY * zoom,
      zoom,
    });
  };

  // 内容变化（事实/筛选/拖拽布局重算）即内容整体居中。
  useEffect(() => {
    fitToContent();
  }, [fitSignal]);

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.1 : 0.9);
  };

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLElement>, nodeId: string) => {
    if (!onNodeDrag) return;
    event.stopPropagation();
    nodeDragRef.current = {
      nodeId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: projection.nodes.find((projected) => projected.node.node_id === nodeId)?.x ?? 0,
      originY: projection.nodes.find((projected) => projected.node.node_id === nodeId)?.y ?? 0,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleNodePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      drag.moved = true;
    }
    onNodeDrag?.(drag.nodeId, drag.originX + dx / viewport.zoom, drag.originY + dy / viewport.zoom);
  };

  const handleNodePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = nodeDragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      // 拖拽过的节点释放前清除记录：随后的 click 落回选中语义。
      if (!drag.moved) nodeDragRef.current = null;
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest(".sh-graph-node, .sh-graph-edge__hit")) return;
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      drag.moved = true;
    }
    onViewportChange({ x: drag.originX + dx, y: drag.originY + dy, zoom: viewport.zoom });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId === event.pointerId) {
      dragState.current = null;
    }
  };

  const handleSurfaceClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    onSelectNode(null);
    onSelectEdge(null);
  };

  const nodeKey = (node: ProjectedNode) => node.node.node_id;

  return (
    <div className="sh-graph-canvas" role="group" aria-label={t("relationships.graph.canvasLabel")}>
      <div className="sh-graph-canvas__controls">
        <button
          type="button"
          className="sh-button sh-button--secondary sh-button--sm"
          aria-label={t("relationships.graph.zoomIn")}
          onClick={() => zoomBy(1.2)}
        >
          +
        </button>
        <button
          type="button"
          className="sh-button sh-button--secondary sh-button--sm"
          aria-label={t("relationships.graph.zoomOut")}
          onClick={() => zoomBy(1 / 1.2)}
        >
          −
        </button>
        <button
          type="button"
          className="sh-button sh-button--secondary sh-button--sm"
          aria-label={t("relationships.graph.fitView")}
          title={t("relationships.graph.fitView")}
          onClick={fitToContent}
        >
          ⛶
        </button>
      </div>
      <div
        ref={surfaceRef}
        className="sh-graph-canvas__surface"
        data-testid="skill-graph-surface"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        onClick={handleSurfaceClick}
      >
        <div
          className="sh-graph-canvas__layer"
          style={{
            width: CANVAS_SIZE.width,
            height: CANVAS_SIZE.height,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          }}
        >
          <svg
            aria-hidden="true"
            className="sh-graph-canvas__edges"
            width={CANVAS_SIZE.width}
            height={CANVAS_SIZE.height}
            viewBox={`0 0 ${CANVAS_SIZE.width} ${CANVAS_SIZE.height}`}
          >
            {projection.edges.map((projected) => {
              const { edge } = projected;
              const mx = (projected.x1 + projected.x2) / 2;
              const my = (projected.y1 + projected.y2) / 2;
              const selected = edge.edge_id === selectedEdgeId;
              return (
                <g
                  key={edge.edge_id}
                  className={`sh-graph-edge sh-graph-edge--${projected.state}${selected ? " is-selected" : ""}`}
                >
                  <title>{`${t(edgeTypeLabelKey(edge))} · ${t(edgeStatusLabelKey(edge))}`}</title>
                  <line
                    className="sh-graph-edge__hit"
                    data-testid={`edge-hit-${edge.edge_id}`}
                    x1={projected.x1}
                    y1={projected.y1}
                    x2={projected.x2}
                    y2={projected.y2}
                    stroke="transparent"
                    strokeWidth={14}
                    onClick={() => onSelectEdge(edge.edge_id)}
                  />
                  <line
                    className={`sh-graph-edge__line sh-graph-edge__line--${projected.line}`}
                    x1={projected.x1}
                    y1={projected.y1}
                    x2={projected.x2}
                    y2={projected.y2}
                  />
                  <text className="sh-graph-edge__label" x={mx} y={my - 6} textAnchor="middle">
                    {t(edgeTypeLabelKey(edge))}
                  </text>
                </g>
              );
            })}
          </svg>
          {projection.nodes.map((projected) => {
            const { node } = projected;
            const selected = node.node_id === selectedNodeId;
            const label = node.kind === "collapsed"
              ? t("relationships.graph.collapsedNodeLabel", { count: node.collapsed_count })
              : nodeLabel(node, node.node_id, resolveSkillName);
            const handleClick = () => {
              // 拖拽（位移超阈值）不算点击：不触发选中/跳转。
              if (nodeDragRef.current?.moved) {
                nodeDragRef.current = null;
                return;
              }
              if (projected.layer === "related" && node.skill_id) {
                onBeforeJump?.();
                onFocusSkill(node.skill_id);
                return;
              }
              onSelectNode(node.node_id);
            };
            return (
              <button
                key={nodeKey(projected)}
                type="button"
                className={[
                  "sh-graph-node",
                  `sh-graph-node--${projected.layer}`,
                  `sh-graph-node--${node.kind}`,
                  selected ? "is-selected" : "",
                ].filter(Boolean).join(" ")}
                style={{ left: projected.x, top: projected.y }}
                onPointerDown={(event) => {
                  if (onNodeDrag) {
                    handleNodePointerDown(event, node.node_id);
                    return;
                  }
                  event.stopPropagation();
                }}
                onPointerMove={onNodeDrag ? handleNodePointerMove : undefined}
                onPointerUp={onNodeDrag ? handleNodePointerUp : undefined}
                onClick={handleClick}
              >
                <span aria-hidden="true" className="sh-graph-node__kind">
                  {t(`relationships.graph.nodeKind.${node.kind}`)}
                </span>
                <span className="sh-graph-node__label">{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
