import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { displayPath } from "../../../platform/displayPath";
import { AgentIdentity, readableAgentIdName } from "../../skills/AgentDeploymentIcons";
import {
  CANVAS_SIZE,
  edgeStatusLabelKey,
  edgeTypeLabelKey,
  type GraphProjection,
  type ProjectedNode,
} from "./graphProjection";
import type { GraphLayoutSize } from "./forceLayout";
import "./graph.css";

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface SkillGraphCanvasProps {
  legend?: ReactNode;
  /** 跳转前保存返回状态（视口），供浏览器后退恢复。 */
  onBeforeJump?: () => void;
  onFocusSkill: (skillId: string) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onSelectNode: (nodeId: string | null) => void;
  onViewportChange: (viewport: GraphViewport) => void;
  /** DEV-24：节点拖拽落点回调（画布坐标）；缺省时节点不可拖拽。 */
  onNodeDrag?: (nodeId: string, x: number, y: number) => void;
  onNodeDragStart?: (nodeId: string) => void;
  onNodeDragEnd?: (nodeId: string) => void;
  projection: GraphProjection;
  selectedEdgeId: string | null;
  selectedNodeId: string | null;
  viewport: GraphViewport;
  /** DEV-15：SkillId → 展示名解析；节点标签用名称，不裸显 UUID。 */
  resolveSkillName?: (skillId: string) => string | undefined;
  /** 变化时触发一次 fit-view（内容整体居中，DEV-24）。 */
  fitSignal?: unknown;
  /** DEV-69：按实际画布尺寸重算布局；未提供时使用设计基准尺寸。 */
  layoutSize?: GraphLayoutSize;
  /** DEV-69：报告真实可用区域，供页面侧布局和初始 fit 使用。 */
  onCanvasSizeChange?: (size: GraphLayoutSize) => void;
  /** 从返回状态恢复时保留传入视口，直到内容事实发生变化或用户主动 fit。 */
  preserveInitialViewport?: boolean;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;

type GraphViewportUpdate = GraphViewport | ((current: GraphViewport) => GraphViewport);

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
      return node.agent_client_id ? readableAgentIdName(node.agent_client_id) : fallback;
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
  legend,
  layoutSize = CANVAS_SIZE,
  onBeforeJump,
  onCanvasSizeChange,
  onFocusSkill,
  onNodeDrag,
  onNodeDragEnd,
  onNodeDragStart,
  onSelectEdge,
  onSelectNode,
  onViewportChange,
  preserveInitialViewport = false,
  projection,
  resolveSkillName,
  selectedEdgeId,
  selectedNodeId,
  viewport,
}: SkillGraphCanvasProps) {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef(viewport);
  const initialViewportRef = useRef(viewport);
  const initialFitSignalRef = useRef(fitSignal);
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const nodeDragRef = useRef<{ nodeId: string; pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  viewportRef.current = viewport;

  const commitViewport = useCallback((update: GraphViewportUpdate) => {
    const next = typeof update === "function" ? update(viewportRef.current) : update;
    viewportRef.current = next;
    onViewportChange(next);
  }, [onViewportChange]);

  const reportCanvasSize = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface || !onCanvasSizeChange) return;
    const width = surface.clientWidth;
    const height = surface.clientHeight;
    if (width > 0 && height > 0) {
      onCanvasSizeChange({ width, height });
    }
  }, [onCanvasSizeChange]);

  useEffect(() => {
    reportCanvasSize();
    const surface = surfaceRef.current;
    if (!surface || !onCanvasSizeChange || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reportCanvasSize);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [onCanvasSizeChange, reportCanvasSize]);

  const zoomBy = useCallback((factor: number) => {
    commitViewport((current) => ({ ...current, zoom: clampZoom(current.zoom * factor) }));
  }, [commitViewport]);

  /** DEV-24：fit-view——按当前内容包围盒缩放并居中（不再以选中 Skill 为锚）。 */
  const fitToContent = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const width = surface.clientWidth;
    const height = surface.clientHeight;
    if (width <= 0 || height <= 0 || projection.nodes.length === 0) {
      commitViewport({ x: 0, y: 0, zoom: 1 });
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
    const sparse = projection.nodes.length <= 3;
    const nodeWidth = sparse ? 68 : 136;
    const nodeHeight = sparse ? 40 : 56;
    minX -= nodeWidth / 2;
    maxX += nodeWidth / 2;
    minY -= nodeHeight / 2;
    maxY += nodeHeight / 2;
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);
    const zoom = clampZoom(Math.min(
      width / (contentWidth + 160),
      height / (contentHeight + 160),
      sparse ? 1 : MAX_ZOOM,
    ));
    commitViewport({
      x: (width - contentWidth * zoom) / 2 - minX * zoom,
      y: (height - contentHeight * zoom) / 2 - minY * zoom,
      zoom,
    });
  }, [commitViewport, projection.nodes]);

  // 内容变化（事实/筛选/拖拽布局重算）即内容整体居中。
  useEffect(() => {
    const contentChanged = initialFitSignalRef.current !== fitSignal;
    initialFitSignalRef.current = fitSignal;

    // 返回状态是用户明确留下的视口。首次挂载和首次尺寸回报都不能用
    // fit-view 覆盖它；后续真正的图谱事实变化仍会重新 fit。
    const initialViewportWasProvided =
      preserveInitialViewport
      || initialViewportRef.current.x !== 0
      || initialViewportRef.current.y !== 0
      || initialViewportRef.current.zoom !== 1;
    // 切换回已有偏好的 Skill 同样会带来新的 projection 引用；这不是用户
    // 请求重置视图，不能让自动 fit 覆盖其保存的缩放和拖拽布局。
    if (preserveInitialViewport || (initialViewportWasProvided && !contentChanged)) return;
    fitToContent();
  }, [fitSignal, fitToContent, layoutSize, preserveInitialViewport]);

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.1 : 0.9);
  };

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLElement>, nodeId: string) => {
    if (!onNodeDrag) return;
    event.preventDefault();
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
    setIsDragging(true);
    onNodeDragStart?.(nodeId);
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
      setIsDragging(false);
      onNodeDragEnd?.(drag.nodeId);
      if (!drag.moved) nodeDragRef.current = null;
    }
  };

  const handleNodePointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setIsDragging(false);
    onNodeDragEnd?.(drag.nodeId);
    nodeDragRef.current = null;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest(".sh-graph-node, .sh-graph-edge__hit, .sh-graph-canvas__controls, .sh-graph__legend")) return;
    event.preventDefault();
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
      moved: false,
    };
    setIsDragging(true);
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
    commitViewport({ x: drag.originX + dx, y: drag.originY + dy, zoom: viewportRef.current.zoom });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId === event.pointerId) {
      dragState.current = null;
      setIsDragging(false);
    }
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId === event.pointerId) {
      dragState.current = null;
      setIsDragging(false);
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
      <div
        ref={surfaceRef}
        className={[
          "sh-graph-canvas__surface",
          projection.nodes.length <= 3 ? "sh-graph-canvas__surface--sparse" : "",
          isDragging ? "is-dragging" : "",
        ].filter(Boolean).join(" ")}
        data-testid="skill-graph-surface"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onWheel={handleWheel}
        onClick={handleSurfaceClick}
      >
        {legend}
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
          className="sh-graph-canvas__layer"
          style={{
            width: layoutSize.width,
            height: layoutSize.height,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          }}
        >
          <svg
            aria-hidden="true"
            className="sh-graph-canvas__edges"
            width={layoutSize.width}
            height={layoutSize.height}
            viewBox={`0 0 ${layoutSize.width} ${layoutSize.height}`}
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
                onPointerCancel={onNodeDrag ? handleNodePointerCancel : undefined}
                onClick={handleClick}
              >
                <span aria-hidden="true" className="sh-graph-node__kind">
                  {t(`relationships.graph.nodeKind.${node.kind}`)}
                </span>
                {node.kind === "agent" && node.agent_client_id ? (
                  <AgentIdentity agentId={node.agent_client_id} density="compact" />
                ) : (
                  <span className="sh-graph-node__label">{label}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
