import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { DataState } from "../../../ui/DataState";
import type {
  RelationshipGraphParams,
  RelationshipGraphStatus,
  RelationshipType,
  RelationshipsFacade,
  SkillRelationshipCandidate,
} from "../api";
import { relationshipsKeys } from "../api";
import { nativeRelationshipsFacade } from "../nativeApi";
import { useRelationshipsReturnState } from "../returnState";
import {
  ALL_DISPLAY_ON,
  type GraphDisplaySettings,
  projectGraph,
} from "./graphProjection";
import { GraphDetailsPanel } from "./GraphDetailsPanel";
import { GraphSearch } from "./GraphSearch";
import { SkillGraphCanvas, type GraphViewport } from "./SkillGraphCanvas";
import "./graph.css";

const RELATIONSHIP_TYPES: RelationshipType[] = [
  "import_copy",
  "shared_directory_read",
  "shared_directory_reference",
  "managed_copy",
  "managed_link",
  "observed_copy",
  "observed_link",
  "unknown",
];

const GRAPH_STATUSES: RelationshipGraphStatus[] = [
  "active",
  "released",
  "content_verified",
  "name_only",
  "diverged",
];

const DEFAULT_VIEWPORT: GraphViewport = { x: 0, y: 0, zoom: 1 };

export interface GraphUrlState {
  skillId: string | null;
  types: RelationshipType[];
  statuses: RelationshipGraphStatus[];
  tags: string[];
}

export function parseGraphSearchParams(params: URLSearchParams): GraphUrlState {
  const list = (name: string) =>
    (params.get(name) ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return {
    skillId: params.get("skillId") || null,
    types: list("types") as RelationshipType[],
    statuses: list("statuses") as RelationshipGraphStatus[],
    tags: list("tags"),
  };
}

export function buildGraphSearchParams(
  state: GraphUrlState & { skillId: string },
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("skillId", state.skillId);
  if (state.types.length > 0) params.set("types", state.types.join(","));
  if (state.statuses.length > 0) params.set("statuses", state.statuses.join(","));
  if (state.tags.length > 0) params.set("tags", state.tags.join(","));
  return params;
}

/**
 * 「换一个 Skill」只从有可展示关系、且不是当前中心的候选中挑选。
 * random 注入以便测试固定选择。
 */
export function pickNextCenter(
  candidates: SkillRelationshipCandidate[],
  currentSkillId: string | null,
  random: () => number,
): SkillRelationshipCandidate | null {
  const pool = candidates.filter(
    (candidate) => candidate.relationship_count > 0 && candidate.skill_id !== currentSkillId,
  );
  if (pool.length === 0) return null;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index] ?? null;
}

function toggleInList<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function ToolbarPopover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sh-graph-pop">
      <button
        type="button"
        className="sh-button sh-button--secondary sh-button--sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        {label}
      </button>
      {open ? <div className="sh-graph-pop__panel">{children}</div> : null}
    </div>
  );
}

export interface SkillGraphPageProps {
  facade?: RelationshipsFacade;
  /** 随机源（首次选中心/换一个）；默认 Math.random，测试注入固定值。 */
  random?: () => number;
}

/**
 * 技能图谱页（任务 6）：单中心、有限深度。URL 承载 skillId 与筛选事实；
 * 首次无 skillId 时只在候选中随机一次并 replace URL，刷新/回退/深链不重新随机；
 * 打开页面绝不触发扫描，只消费任务 1 的只读查询。
 */
export function SkillGraphPage({
  facade = nativeRelationshipsFacade,
  random = Math.random,
}: SkillGraphPageProps) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlState = useMemo(() => parseGraphSearchParams(searchParams), [searchParams]);
  const { skillId } = urlState;
  const queryClient = useQueryClient();
  const returnState = useRelationshipsReturnState("graph");

  const [viewport, setViewport] = useState<GraphViewport>(
    returnState.initialState?.viewport ?? DEFAULT_VIEWPORT,
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [display, setDisplay] = useState<GraphDisplaySettings>(ALL_DISPLAY_ON);
  const [tagsDraft, setTagsDraft] = useState(urlState.tags.join(","));
  const [knownRevisions, setKnownRevisions] = useState<Record<string, string>>({});
  const [initialPick, setInitialPick] = useState<"pending" | "empty">("pending");
  const [pickAnotherNotice, setPickAnotherNotice] = useState(false);
  const pickAttemptedRef = useRef(false);

  const candidatesParams = useMemo(
    () => ({ text: "", tags: urlState.tags }),
    [urlState.tags],
  );
  const candidatesQuery = useQuery({
    queryKey: relationshipsKeys.candidates(candidatesParams),
    queryFn: () => facade.listCandidates(candidatesParams),
  });

  // DEV-15：SkillId → 展示名映射（来自关系候选查询的 display_name）；
  // 图谱节点标签用名称，不裸显 UUID。
  const skillNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const candidate of candidatesQuery.data ?? []) {
      if (candidate.skill_id) map.set(candidate.skill_id, candidate.display_name);
    }
    return map;
  }, [candidatesQuery.data]);
  const resolveSkillName = useCallback(
    (skillId: string) => skillNameById.get(skillId),
    [skillNameById],
  );

  const mergeRevisions = useCallback((list: SkillRelationshipCandidate[]) => {
    setKnownRevisions((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const candidate of list) {
        if (next[candidate.skill_id] !== candidate.relationship_revision) {
          next[candidate.skill_id] = candidate.relationship_revision;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  useEffect(() => {
    if (candidatesQuery.data) {
      mergeRevisions(candidatesQuery.data);
    }
  }, [candidatesQuery.data, mergeRevisions]);

  // 首次无 skillId：只在候选中随机一次，并 replace URL（不新增历史条目）。
  useEffect(() => {
    if (skillId || pickAttemptedRef.current || !candidatesQuery.isSuccess) return;
    const list = candidatesQuery.data ?? [];
    const picked = list.length > 0 ? pickNextCenter(list, null, random) : null;
    if (!picked) {
      pickAttemptedRef.current = true;
      setInitialPick("empty");
      return;
    }
    pickAttemptedRef.current = true;
    mergeRevisions([picked]);
    setSearchParams(buildGraphSearchParams({ ...urlState, skillId: picked.skill_id }), {
      replace: true,
    });
  }, [skillId, candidatesQuery.isSuccess, candidatesQuery.data, random, setSearchParams, urlState, mergeRevisions]);

  // 修订号进入 query key：候选里能拿到修订就先于首次图谱查询注入；
  // 中心不在候选里或候选查询失败时才允许无修订查询，再由下方效果收敛一次。
  const knownRevision = skillId ? knownRevisions[skillId] : undefined;
  const centerCandidateMissing =
    candidatesQuery.isSuccess
    && (candidatesQuery.data ?? []).every((candidate) => candidate.skill_id !== skillId);
  const revisionKnown = knownRevision !== undefined || centerCandidateMissing;
  const graphParams: RelationshipGraphParams = useMemo(
    () => ({
      skillId: skillId ?? "",
      relationshipTypes: urlState.types,
      statuses: urlState.statuses,
      ...(knownRevision !== undefined ? { relationshipRevision: knownRevision } : {}),
    }),
    [skillId, urlState.types, urlState.statuses, knownRevision],
  );
  const graphQuery = useQuery({
    queryKey: relationshipsKeys.graph(graphParams),
    queryFn: () => facade.getGraph(graphParams),
    enabled: skillId !== null && (revisionKnown || candidatesQuery.isError),
    placeholderData: (previous) => previous,
  });
  useEffect(() => {
    const data = graphQuery.data;
    if (!skillId || !data) return;
    if (knownRevisions[skillId] !== data.relationship_revision) {
      setKnownRevisions((prev) => ({ ...prev, [skillId]: data.relationship_revision }));
    }
  }, [skillId, graphQuery.data, knownRevisions]);

  const graph = skillId ? graphQuery.data ?? null : null;
  const projection = useMemo(
    () =>
      graph
        ? projectGraph(
            graph,
            { relationshipTypes: urlState.types, statuses: urlState.statuses },
            display,
          )
        : null,
    [graph, urlState.types, urlState.statuses, display],
  );

  const saveReturnState = useCallback(() => {
    returnState.saveState({ viewport });
  }, [returnState.saveState, viewport]);

  const navigateToSkill = useCallback(
    (nextSkillId: string) => {
      if (!nextSkillId || nextSkillId === skillId) return;
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setPickAnotherNotice(false);
      setSearchParams(buildGraphSearchParams({ ...urlState, skillId: nextSkillId }), {
        replace: false,
      });
    },
    [skillId, setSearchParams, urlState],
  );

  const fetchCandidates = useCallback(
    async (text: string) => {
      const list = await queryClient.fetchQuery({
        queryKey: relationshipsKeys.candidates({ text, tags: urlState.tags }),
        queryFn: () => facade.listCandidates({ text, tags: urlState.tags }),
      });
      mergeRevisions(list);
      return list;
    },
    [facade, queryClient, urlState.tags, mergeRevisions],
  );

  const handlePickAnother = useCallback(async () => {
    if (!skillId) return;
    setPickAnotherNotice(false);
    try {
      const list = await fetchCandidates("");
      const picked = pickNextCenter(list, skillId, random);
      if (!picked) {
        setPickAnotherNotice(true);
        return;
      }
      mergeRevisions([picked]);
      navigateToSkill(picked.skill_id);
    } catch {
      setPickAnotherNotice(true);
    }
  }, [fetchCandidates, mergeRevisions, navigateToSkill, random, skillId]);

  const updateParams = useCallback(
    (next: Partial<Omit<GraphUrlState, "skillId">>) => {
      if (!skillId) return;
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setSearchParams(buildGraphSearchParams({ ...urlState, ...next, skillId }), {
        replace: true,
      });
    },
    [skillId, setSearchParams, urlState],
  );

  if (!skillId) {
    if (initialPick === "empty" || (candidatesQuery.isSuccess && (candidatesQuery.data ?? []).length === 0)) {
      return (
        <div className="sh-graph-empty">
          <DataState
            hint={t("relationships.graph.emptyHint")}
            message={t("relationships.graph.emptyMessage")}
            state="empty"
          />
          <Link className="sh-button sh-button--primary" to="/discovery?from=relationships">
            {t("relationships.graph.goToDiscovery")}
          </Link>
        </div>
      );
    }
    if (candidatesQuery.isError) {
      return (
        <DataState
          message={t("relationships.graph.candidatesLoadFailed")}
          state="error"
        />
      );
    }
    return <DataState message={t("dataState.loading")} state="loading" />;
  }

  if (graphQuery.isError) {
    return (
      <DataState message={t("relationships.graph.graphLoadFailed")} state="error" />
    );
  }
  if (graphQuery.isPending || !graph || !projection) {
    return <DataState message={t("dataState.loading")} state="loading" />;
  }

  const collapsedTotal = projection.collapsed.reduce((sum, chip) => sum + chip.count, 0);
  const displayName =
    candidatesQuery.data?.find((candidate) => candidate.skill_id === skillId)?.display_name ?? null;

  return (
    <div className="sh-graph">
      <div className="sh-graph__toolbar">
        <GraphSearch onPick={navigateToSkill} search={fetchCandidates} />
        <div className="sh-graph__tags">
          <label className="sh-graph__tags-label" htmlFor="sh-graph-tags-input">
            {t("relationships.graph.tagsLabel")}
          </label>
          <input
            id="sh-graph-tags-input"
            className="sh-graph__tags-input"
            type="text"
            value={tagsDraft}
            placeholder={t("relationships.graph.tagsPlaceholder")}
            onChange={(event) => setTagsDraft(event.target.value)}
          />
          <button
            type="button"
            className="sh-button sh-button--secondary sh-button--sm"
            onClick={() =>
              updateParams({
                tags: tagsDraft.split(",").map((tag) => tag.trim()).filter(Boolean),
              })
            }
          >
            {t("relationships.graph.tagsApply")}
          </button>
        </div>
        <ToolbarPopover label={t("relationships.graph.filters")}>
          <fieldset>
            <legend>{t("relationships.graph.filterTypes")}</legend>
            {RELATIONSHIP_TYPES.map((type) => (
              <label key={type}>
                <input
                  type="checkbox"
                  checked={urlState.types.includes(type)}
                  onChange={() => updateParams({ types: toggleInList(urlState.types, type) })}
                />
                {t(`relationships.graph.edgeType.${type}`)}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>{t("relationships.graph.filterStatuses")}</legend>
            {GRAPH_STATUSES.map((status) => (
              <label key={status}>
                <input
                  type="checkbox"
                  checked={urlState.statuses.includes(status)}
                  onChange={() =>
                    updateParams({ statuses: toggleInList(urlState.statuses, status) })
                  }
                />
                {t(`relationships.graph.status.${status}`)}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="sh-button sh-button--ghost sh-button--sm"
            onClick={() => updateParams({ types: [], statuses: [] })}
          >
            {t("relationships.graph.filtersClear")}
          </button>
        </ToolbarPopover>
        <ToolbarPopover label={t("relationships.graph.displaySettings")}>
          {(
            [
              ["showSources", "displaySources"],
              ["showAgentsProjects", "displayAgentsProjects"],
              ["showDirectories", "displayDirectories"],
              ["showConflicts", "displayConflicts"],
            ] as const
          ).map(([key, labelKey]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={display[key]}
                onChange={() => setDisplay((prev) => ({ ...prev, [key]: !prev[key] }))}
              />
              {t(`relationships.graph.${labelKey}`)}
            </label>
          ))}
        </ToolbarPopover>
        <button
          type="button"
          className="sh-button sh-button--secondary sh-button--sm"
          onClick={() => void handlePickAnother()}
        >
          {t("relationships.graph.pickAnother")}
        </button>
      </div>
      {pickAnotherNotice ? (
        <p role="status">{t("relationships.graph.pickAnotherNone")}</p>
      ) : null}
      <div className="sh-graph__body">
        <SkillGraphCanvas
          onBeforeJump={saveReturnState}
          onFocusSkill={navigateToSkill}
          onSelectEdge={setSelectedEdgeId}
          onSelectNode={(nodeId) => {
            setSelectedNodeId(nodeId);
            setSelectedEdgeId(null);
          }}
          onViewportChange={setViewport}
          projection={projection}
          resolveSkillName={resolveSkillName}
          selectedEdgeId={selectedEdgeId}
          selectedNodeId={selectedNodeId}
          viewport={viewport}
        />
        <GraphDetailsPanel
          centerSkillId={skillId}
          displayName={displayName}
          factCounts={graph.fact_counts}
          lastVerifiedAt={graph.last_verified_at}
          onBeforeNavigate={saveReturnState}
          projection={projection}
          relationshipRevision={graph.relationship_revision}
          selectedEdgeId={selectedEdgeId}
          selectedNodeId={selectedNodeId}
        />
      </div>
      {projection.collapsed.length > 0 ? (
        <div className="sh-graph__collapsed" role="status">
          <p>{t("relationships.graph.collapsedSummary", { count: collapsedTotal })}</p>
          <ul className="sh-graph__collapsed-list">
            {projection.collapsed.map((chip) => (
              <li key={`${chip.reason}-${chip.kind}`}>
                {t(`relationships.graph.nodeKind.${chip.kind}`)}
                {" — "}
                {t(`relationships.graph.collapsedReason.${chip.reason}`)}
                {" ×"}
                {chip.count}
              </li>
            ))}
          </ul>
          <div className="sh-graph-details__actions">
            <Link
              className="sh-button sh-button--secondary sh-button--sm"
              to="/relationships/governance?from=graph"
              onClick={saveReturnState}
            >
              {t("relationships.graph.goToGovernance")}
            </Link>
            <Link
              className="sh-button sh-button--secondary sh-button--sm"
              to="/discovery?from=relationships"
              onClick={saveReturnState}
            >
              {t("relationships.graph.goToDiscovery")}
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
