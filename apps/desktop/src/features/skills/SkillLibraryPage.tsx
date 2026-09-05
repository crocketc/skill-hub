import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import {
  detailSearchFromLibrary,
  readLibraryReturnState,
} from "../skill-detail/detailContext";
import {
  BUILT_IN_SAVED_VIEWS,
  DEFAULT_DRAWER_PREFERENCES,
  DEFAULT_SKILL_QUERY,
  DEFAULT_TABLE_PREFERENCES,
  isSkillLibraryUnavailable,
  skillLibraryKeys,
  type BatchAction,
  type SavedSkillView,
  type SkillColumnId,
  type SkillDrawerPreferences,
  type SkillLibraryFacade,
  type SkillLibraryQuery,
  type SkillPage,
  type SkillTablePreferences,
} from "./api";
import {
  applySavedView,
  parseSkillLibrarySearchParams,
  serializeSkillLibrarySearchParams,
  skillFilterKey,
} from "./queryState";
import { SavedViews } from "./SavedViews";
import {
  retainExplicitSelection,
  selectAllFiltered,
  selectionCount,
  selectionToBatchTarget,
  type SkillSelection,
} from "./selection";
import { SkillFilters } from "./SkillFilters";
import { BatchTagDialog, type BatchTagAction } from "./BatchTagDialog";
import { SkillQuickDrawer } from "./SkillQuickDrawer";
import { SkillTable } from "./SkillTable";
import { BatchRemovalImpactDialog } from "../removal/BatchRemovalImpactDialog";
import type { RemovalChoice, RemovalFacade, RemovalImpact } from "../removal/api";
import { nativeRemovalFacade } from "../removal/nativeApi";

export interface SkillLibraryCapabilities {
  /** Columns the facade can sort on; omitted keeps every column sortable. */
  sortableColumns?: SkillColumnId[];
  /** Whether the upgrade-available version filter has a real read model. */
  versionFilterSupported?: boolean;
}

export interface SkillLibraryPageProps {
  capabilities?: SkillLibraryCapabilities;
  facade: SkillLibraryFacade;
  onOpenDiscovery?: () => void;
  removalFacade?: RemovalFacade;
}

interface SaveViewFormProps {
  error?: string;
  name: string;
  onCancel: () => void;
  onNameChange: (name: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
}

interface PreferenceStatusProps {
  message: string;
  onRestore?: () => void;
  onRetry: () => void;
}

interface BatchBarProps {
  announcement?: string;
  barRef: Ref<HTMLElement>;
  onAction: (action: BatchAction) => void;
  onClear: () => void;
  onDelete: () => void;
  onSelectAll: () => void;
  onStartExport: () => void;
  onTagAction: (action: BatchTagAction) => void;
  page: SkillPage;
  selection: Exclude<SkillSelection, { kind: "none" }>;
}

const BATCH_ACTIONS: readonly BatchAction[] = [
  "add_to",
  "security_check",
  "export",
  "archive",
];

const BATCH_ACTION_KEYS = {
  add_to: "skillLibrary.page.batch.addTo",
  add_tag: "skillLibrary.page.batch.addTags",
  archive: "skillLibrary.page.batch.archive",
  export: "skillLibrary.page.batch.export",
  remove_tag: "skillLibrary.page.batch.removeTags",
  security_check: "skillLibrary.page.batch.securityCheck",
} as const satisfies Record<BatchAction, string>;

function hasActiveFilter(query: SkillLibraryQuery): boolean {
  return skillFilterKey(query) !== skillFilterKey(DEFAULT_SKILL_QUERY);
}

function actionableSelection(
  selection: SkillSelection,
  pageRefreshing: boolean,
): Exclude<SkillSelection, { kind: "none" }> | undefined {
  if (
    pageRefreshing ||
    selection.kind === "none" ||
    selectionCount(selection) <= 0
  ) {
    return undefined;
  }
  return selection;
}

function savedViewScope(query: SkillLibraryQuery): SavedSkillView["query"] {
  return {
    filters: {
      ...query.filters,
      aiCheck: [...query.filters.aiCheck],
      basicCheck: [...query.filters.basicCheck],
      lifecycle: [...query.filters.lifecycle],
      tags: [...query.filters.tags],
    },
    sort: { ...query.sort },
    text: query.text,
  };
}

function savedViewIsDirty(
  view: SavedSkillView | undefined,
  query: SkillLibraryQuery,
  table: SkillTablePreferences,
): boolean {
  if (!view) return false;
  const current = {
    filterKey: skillFilterKey(query),
    sort: query.sort,
    table,
  };
  const saved = {
    filterKey: skillFilterKey({ ...query, ...view.query }),
    sort: view.query.sort,
    table: view.table,
  };
  return JSON.stringify(current) !== JSON.stringify(saved);
}

function mergeSavedViews(userViews: SavedSkillView[] | undefined): SavedSkillView[] {
  const views = new Map<string, SavedSkillView>();
  for (const view of BUILT_IN_SAVED_VIEWS) views.set(view.id, view);
  for (const view of userViews ?? []) {
    if (!views.has(view.id)) views.set(view.id, view);
  }
  return [...views.values()];
}

function SkillLibrarySkeleton(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="sh-skill-library__loading">
      <p
        aria-label={t("skillLibrary.page.states.loading")}
        aria-live="polite"
        role="status"
      >
        {t("skillLibrary.page.states.loading")}
      </p>
      <div
        aria-label={t("skillLibrary.table.resultsRegion")}
        className="sh-skill-library__loading-table"
        role="region"
      >
        {Array.from({ length: 6 }, (_, index) => (
          <div
            className="sh-skill-library__loading-row"
            data-testid="skill-loading-row"
            key={index}
          >
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}

function SaveViewForm({
  error,
  name,
  onCancel,
  onNameChange,
  onSubmit,
  pending,
}: SaveViewFormProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <form
      aria-label={t("skillLibrary.page.saveView.formLabel")}
      className="sh-skill-library__save-view"
      onSubmit={onSubmit}
    >
      <label>
        {t("skillLibrary.page.saveView.name")}
        <input
          onChange={(event) => onNameChange(event.currentTarget.value)}
          required
          type="text"
          value={name}
        />
      </label>
      <Button disabled={pending || name.trim().length === 0} size="sm" type="submit">
        {t("skillLibrary.page.saveView.submit")}
      </Button>
      <Button onClick={onCancel} size="sm" type="button" variant="ghost">
        {t("actions.cancel")}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

function PreferenceStatus({
  message,
  onRestore,
  onRetry,
}: PreferenceStatusProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      aria-label={t("skillLibrary.page.preferences.statusLabel")}
      className="sh-skill-library__preference-status"
      role="status"
    >
      <span>{message}</span>
      <Button onClick={onRetry} size="sm" variant="ghost">
        {t("actions.retry")}
      </Button>
      {onRestore ? (
        <Button onClick={onRestore} size="sm" variant="ghost">
          {t("skillLibrary.page.preferences.restoreDefault")}
        </Button>
      ) : null}
    </div>
  );
}

function BatchBar({
  announcement,
  barRef,
  onAction,
  onClear,
  onDelete,
  onSelectAll,
  onStartExport,
  onTagAction,
  page,
  selection,
}: BatchBarProps): JSX.Element {
  const { t } = useTranslation();
  const count = selectionCount(selection);
  const pageIds = new Set(page.items.map((row) => row.id));
  const selectedCurrentPage =
    selection.kind === "explicit" &&
    selection.skillIds.length === page.items.length &&
    page.items.length > 1 &&
    selection.skillIds.every((skillId) => pageIds.has(skillId));
  const scope =
    selection.kind === "all_filtered"
      ? t("skillLibrary.page.selection.allFiltered", { count })
      : selectedCurrentPage
        ? t("skillLibrary.page.selection.currentPage", { count })
        : t("skillLibrary.page.selection.explicit", { count });

  return (
    <aside
      aria-label={t("skillLibrary.page.batch.label")}
      className="sh-skill-library__batch-bar"
      ref={barRef}
    >
      <strong>{scope}</strong>
      {selection.kind === "explicit" && count < page.total ? (
        <Button onClick={onSelectAll} size="sm" variant="secondary">
          {t("skillLibrary.page.selection.selectAll", { count: page.total })}
        </Button>
      ) : null}
      <div className="sh-skill-library__batch-actions">
        <Button onClick={() => onAction("add_to")} size="sm" variant="ghost">
          {t(BATCH_ACTION_KEYS.add_to)}
        </Button>
        <Button onClick={() => onTagAction("add_tag")} size="sm" variant="ghost">
          {t("skillLibrary.page.batch.addTags")}
        </Button>
        <Button onClick={() => onTagAction("remove_tag")} size="sm" variant="ghost">
          {t("skillLibrary.page.batch.removeTags")}
        </Button>
        {BATCH_ACTIONS.slice(1).map((action) => (
          <Button key={action} onClick={() => onAction(action)} size="sm" variant="ghost">
            {t(BATCH_ACTION_KEYS[action])}
          </Button>
        ))}
        <Button onClick={onStartExport} size="sm" variant="ghost">
          {t("skillLibrary.page.batch.startExport")}
        </Button>
        <Button onClick={onDelete} size="sm" variant="danger">
          {t("skillLibrary.page.batch.delete")}
        </Button>
        <Button onClick={onClear} size="sm" variant="ghost">
          {t("skillLibrary.page.selection.clear")}
        </Button>
      </div>
      {announcement ? <p aria-live="polite" role="status">{announcement}</p> : null}
    </aside>
  );
}

export function SkillLibraryPage({
  capabilities,
  facade,
  onOpenDiscovery,
  removalFacade = nativeRemovalFacade,
}: SkillLibraryPageProps): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const libraryReturnState = readLibraryReturnState(location.state);
  // 反向发起部署：Agent/项目详情携带的目标预选。
  const deployTarget = (location.state as { deployTarget?: { id: string; label: string } } | null)?.deployTarget;
  const search = searchParams.toString();
  const parsed = useMemo(() => parseSkillLibrarySearchParams(search), [search]);
  const { query, skillId } = parsed;
  const rootRef = useRef<HTMLElement | null>(null);
  const [batchBarElement, setBatchBarElement] = useState<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const scrollPositionRef = useRef<{ left: number; top: number }>();
  const batchRequestRef = useRef(0);
  const currentFilterKeyRef = useRef(skillFilterKey(query));
  currentFilterKeyRef.current = skillFilterKey(query);

  const [selection, setSelection] = useState<SkillSelection>({ kind: "none" });
  const [tablePreferences, setTablePreferences] = useState<SkillTablePreferences>();
  const [drawerPreferences, setDrawerPreferences] = useState<SkillDrawerPreferences>();
  const [tableSaveFailure, setTableSaveFailure] = useState<SkillTablePreferences>();
  const [drawerSaveFailure, setDrawerSaveFailure] = useState<SkillDrawerPreferences>();
  const [selectionAnnouncement, setSelectionAnnouncement] = useState<string>();
  const [batchAnnouncement, setBatchAnnouncement] = useState<string>();
  const [batchTagAction, setBatchTagAction] = useState<BatchTagAction>();
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [saveViewName, setSaveViewName] = useState("");
  const [saveViewError, setSaveViewError] = useState<string>();
  const [saveViewPending, setSaveViewPending] = useState(false);
  const [savedViewDeleteError, setSavedViewDeleteError] = useState<string>();
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  const [batchRemovalImpacts, setBatchRemovalImpacts] = useState<RemovalImpact[] | null>(null);
  const [batchRemovalLoading, setBatchRemovalLoading] = useState(false);
  const [batchRemovalSubmitting, setBatchRemovalSubmitting] = useState(false);
  const [batchRemovalError, setBatchRemovalError] = useState<string>();
  const defaultPageRetry = queryClient.getDefaultOptions().queries?.retry;

  const clearBatchAnnouncement = () => {
    batchRequestRef.current += 1;
    setBatchAnnouncement(undefined);
  };

  const changeSelection = (next: SkillSelection) => {
    clearBatchAnnouncement();
    setSelection(next);
  };

  const pageQuery = useQuery({
    placeholderData: keepPreviousData,
    queryFn: () => facade.listSkills(query),
    queryKey: skillLibraryKeys.page(query),
    retry: (failureCount, error) => {
      if (isSkillLibraryUnavailable(error)) return false;
      if (typeof defaultPageRetry === "function") {
        return defaultPageRetry(failureCount, error);
      }
      if (defaultPageRetry === true) return true;
      if (defaultPageRetry === false) return false;
      return failureCount < (defaultPageRetry ?? 3);
    },
  });
  const savedViewsQuery = useQuery({
    queryFn: () => facade.listSavedViews(),
    queryKey: skillLibraryKeys.savedViews(),
  });
  const tablePreferencesQuery = useQuery({
    queryFn: () => facade.loadTablePreferences(),
    queryKey: skillLibraryKeys.tablePreferences(),
  });
  const drawerPreferencesQuery = useQuery({
    queryFn: () => facade.loadDrawerPreferences(),
    queryKey: skillLibraryKeys.drawerPreferences(),
  });

  const effectiveTablePreferences =
    tablePreferences ?? tablePreferencesQuery.data ?? DEFAULT_TABLE_PREFERENCES;
  const effectiveDrawerPreferences =
    drawerPreferences ?? drawerPreferencesQuery.data ?? DEFAULT_DRAWER_PREFERENCES;
  const savedViews = useMemo(
    () => mergeSavedViews(savedViewsQuery.data),
    [savedViewsQuery.data],
  );
  const activeSavedView = savedViews.find((view) => view.id === query.savedViewId);

  // FE-04 卡片视图：视图模式经 ui 偏好持久化；facade 未提供时静默用表格视图。
  const [viewMode, setViewMode] = useState<LibraryViewMode>("table");
  const viewModeRef = useRef<LibraryViewMode>("table");
  useEffect(() => {
    let active = true;
    void facade.loadViewMode?.().then((mode) => {
      if (!active) return;
      viewModeRef.current = mode;
      setViewMode(mode);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [facade]);

  const toggleViewMode = useCallback(() => {
    const next: LibraryViewMode = viewModeRef.current === "table" ? "cards" : "table";
    viewModeRef.current = next;
    setViewMode(next);
    void facade.saveViewMode?.(next).catch(() => undefined);
  }, [facade]);

  const persistDrawerPreferences = useCallback(
    async (next: SkillDrawerPreferences) => {
      setDrawerSaveFailure(undefined);
      try {
        await facade.saveDrawerPreferences(next);
        await queryClient.invalidateQueries({
          queryKey: skillLibraryKeys.drawerPreferences(),
        });
      } catch (error) {
        setDrawerSaveFailure(next);
        throw error;
      }
    },
    [facade, queryClient],
  );
  const drawerFacade = useMemo<SkillLibraryFacade>(
    () => ({
      ...facade,
      saveDrawerPreferences: persistDrawerPreferences,
    }),
    [facade, persistDrawerPreferences],
  );
  const selectedBatchTarget = actionableSelection(
    selection,
    pageQuery.isPlaceholderData,
  );
  const hasActionableSelection = Boolean(selectedBatchTarget);

  useLayoutEffect(() => {
    const workspace = rootRef.current;
    const batchBar = batchBarElement;
    if (!workspace || !hasActionableSelection || !batchBar) {
      workspace?.style.removeProperty("--skill-batch-bar-height");
      return;
    }

    const reserveBatchBarHeight = () => {
      const height = Math.ceil(batchBar.getBoundingClientRect().height);
      workspace.style.setProperty("--skill-batch-bar-height", `${height}px`);
    };
    reserveBatchBarHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", reserveBatchBarHeight);
      return () => {
        window.removeEventListener("resize", reserveBatchBarHeight);
        workspace.style.removeProperty("--skill-batch-bar-height");
      };
    }

    const observer = new ResizeObserver(reserveBatchBarHeight);
    observer.observe(batchBar);
    return () => {
      observer.disconnect();
      workspace.style.removeProperty("--skill-batch-bar-height");
    };
  }, [batchBarElement, hasActionableSelection]);

  useEffect(() => {
    const region = rootRef.current?.querySelector<HTMLElement>(
      ".sh-skill-table__region",
    );
    if (region && (!returnFocusRef.current || !returnFocusRef.current.isConnected)) {
      returnFocusRef.current = region;
    }
  }, [pageQuery.data]);

  const writeQuery = (nextQuery: SkillLibraryQuery, nextSkillId?: string) => {
    setSearchParams(serializeSkillLibrarySearchParams(nextQuery, nextSkillId));
  };

  const writeDrawerSkill = (nextSkillId?: string) => {
    setSearchParams((currentSearchParams) => {
      const nextSearchParams = new URLSearchParams(currentSearchParams);
      if (nextSkillId) {
        nextSearchParams.set("skill", nextSkillId);
      } else {
        nextSearchParams.delete("skill");
      }
      return nextSearchParams;
    });
  };

  const updateQuery = (nextQuery: SkillLibraryQuery) => {
    const previousKey = skillFilterKey(query);
    const nextKey = skillFilterKey(nextQuery);
    if (previousKey !== nextKey) {
      currentFilterKeyRef.current = nextKey;
      if (selection.kind === "all_filtered") {
        changeSelection({ kind: "none" });
        setSelectionAnnouncement(
          t("skillLibrary.page.selection.clearedForFilters"),
        );
      } else if (selection.kind === "explicit") {
        clearBatchAnnouncement();
        const selectedIds = [...selection.skillIds];
        void facade.retainMatchingSkillIds(selectedIds, nextQuery).then((matchingIds) => {
          if (currentFilterKeyRef.current !== nextKey) return;
          clearBatchAnnouncement();
          setSelection((current) => retainExplicitSelection(current, matchingIds));
        });
      }
    }
    writeQuery(nextQuery, skillId);
  };

  const clearFilters = () => {
    updateQuery({
      ...query,
      filters: DEFAULT_SKILL_QUERY.filters,
      page: 1,
      savedViewId: undefined,
      text: "",
    });
  };

  const applyView = (view: SavedSkillView) => {
    const applied = applySavedView(query, view);
    setTablePreferences(applied.table);
    updateQuery(applied.query);
  };

  const deleteSavedView = (view: SavedSkillView) => {
    setSavedViewDeleteError(undefined);
    void facade.deleteView(view.id).then(
      () => {
        queryClient.setQueryData<SavedSkillView[]>(
          skillLibraryKeys.savedViews(),
          (currentViews) => currentViews?.filter((current) => current.id !== view.id),
        );
        if (query.savedViewId === view.id) {
          writeQuery({ ...query, savedViewId: undefined }, skillId);
        }
        return queryClient.invalidateQueries({
          queryKey: skillLibraryKeys.savedViews(),
        });
      },
      () => setSavedViewDeleteError(t("skillLibrary.savedViews.deleteError")),
    );
  };

  const persistTablePreferences = (next: SkillTablePreferences) => {
    setTablePreferences(next);
    setTableSaveFailure(undefined);
    void facade.saveTablePreferences(next).then(
      () =>
        queryClient.invalidateQueries({
          queryKey: skillLibraryKeys.tablePreferences(),
        }),
      () => setTableSaveFailure(next),
    );
  };

  const openSkill = (nextSkillId: string, rowElement: HTMLElement) => {
    const region = rootRef.current?.querySelector<HTMLElement>(
      ".sh-skill-table__region",
    );
    scrollPositionRef.current = region
      ? { left: region.scrollLeft, top: region.scrollTop }
      : undefined;
    returnFocusRef.current = rowElement;
    writeDrawerSkill(nextSkillId);
  };

  const closeDrawer = () => {
    const region = rootRef.current?.querySelector<HTMLElement>(
      ".sh-skill-table__region",
    );
    if (region && scrollPositionRef.current) {
      region.scrollLeft = scrollPositionRef.current.left;
      region.scrollTop = scrollPositionRef.current.top;
    }
    if (!returnFocusRef.current?.isConnected && region) {
      returnFocusRef.current = region;
    }
    writeDrawerSkill(undefined);
  };

  const emitBatchAction = (action: BatchAction) => {
    if (selection.kind === "none" || selectionCount(selection) <= 0) return;
    if (action === "add_to") {
      void selectedSkillsForRemoval().then(
        (skills) => {
          const search = new URLSearchParams();
          skills.forEach((skill) => search.append("skill", skill.id));
          if (deployTarget) search.append("target", deployTarget.id);
          navigate({ pathname: "/deploy", search: `?${search.toString()}` });
        },
        () => setBatchAnnouncement(t("skillLibrary.page.batch.error")),
      );
      return;
    }
    const request = batchRequestRef.current + 1;
    batchRequestRef.current = request;
    setBatchAnnouncement(undefined);
    const intent = { action, target: selectionToBatchTarget(selection) };
    void facade.emitBatchIntent(intent).catch((error: unknown) => {
      if (request !== batchRequestRef.current) return;
      setBatchAnnouncement(
        isSkillLibraryUnavailable(error)
          ? t("skillLibrary.page.batch.unconnected")
          : t("skillLibrary.page.batch.error"),
      );
    });
  };

  const emitBatchTagAction = (action: BatchTagAction, tags: string[]) => {
    if (selection.kind === "none" || selectionCount(selection) <= 0) return;
    const request = batchRequestRef.current + 1;
    batchRequestRef.current = request;
    setBatchAnnouncement(undefined);
    void facade.emitBatchIntent({ action, tags, target: selectionToBatchTarget(selection) }).catch((error: unknown) => {
      if (request !== batchRequestRef.current) return;
      setBatchAnnouncement(
        isSkillLibraryUnavailable(error)
          ? t("skillLibrary.page.batch.unconnected")
          : t("skillLibrary.page.batch.error"),
      );
    });
  };

  const startBatchExport = () => {
    if (selection.kind === "none" || selectionCount(selection) <= 0) return;
    if (selection.kind === "explicit") {
      navigate("/settings/data-protection", { state: { exportSkillIds: [...selection.skillIds] } });
      return;
    }
    void selectedSkillsForRemoval().then(
      (skills) => navigate("/settings/data-protection", {
        state: { exportSkillIds: skills.map((skill) => skill.id) },
      }),
      () => setBatchAnnouncement(t("skillLibrary.page.batch.error")),
    );
  };

  const selectedSkillsForRemoval = async (): Promise<Array<{ id: string; name: string }>> => {
    if (selection.kind === "explicit") {
      const names = new Map(pageQuery.data?.items.map((item) => [item.id, item.name]));
      return Promise.all(selection.skillIds.map(async (id) => ({
        id,
        name: names.get(id) ?? (await facade.getSkillQuickView(id)).name,
      })));
    }
    const items: Array<{ id: string; name: string }> = [];
    let pageNumber = 1;
    while (true) {
      const result = await facade.listSkills({ ...query, page: pageNumber, pageSize: 100 });
      items.push(...result.items.map((item) => ({ id: item.id, name: item.name })));
      if (items.length >= result.total || result.items.length === 0) return items;
      pageNumber += 1;
    }
  };

  const startBatchRemoval = async (single?: { id: string; name: string }) => {
    setBatchRemovalLoading(true);
    setBatchRemovalError(undefined);
    try {
      const selected = single ? [single] : await selectedSkillsForRemoval();
      const impacts: RemovalImpact[] = [];
      for (const skill of selected) {
        impacts.push(await removalFacade.prepareDelete(skill.id, skill.name));
      }
      setBatchRemovalImpacts(impacts);
    } catch {
      setBatchRemovalError(t("removal.batch.loadError"));
    } finally {
      setBatchRemovalLoading(false);
    }
  };

  const commitBatchRemoval = async (choices: Record<string, Record<string, RemovalChoice>>) => {
    if (!batchRemovalImpacts) return;
    setBatchRemovalSubmitting(true);
    setBatchRemovalError(undefined);
    try {
      for (const impact of batchRemovalImpacts) {
        if (!impact.operationId) throw new Error("missing prepared delete id");
        const result = await removalFacade.commitDelete(impact.operationId, choices[impact.operationId] ?? {});
        if (!result.centralSkillDeleted) throw new Error("central skill was not deleted");
      }
      await queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
      setBatchRemovalImpacts(null);
      changeSelection({ kind: "none" });
    } catch {
      setBatchRemovalError(t("removal.batch.commitError"));
    } finally {
      setBatchRemovalSubmitting(false);
    }
  };

  const submitSavedView = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = saveViewName.trim();
    if (!name) return;
    setSaveViewPending(true);
    setSaveViewError(undefined);
    void facade
      .saveView({
        name,
        query: savedViewScope(query),
        table: effectiveTablePreferences,
      })
      .then(
        (savedView) => {
          queryClient.setQueryData<SavedSkillView[]>(
            skillLibraryKeys.savedViews(),
            (currentViews) => {
              const views = currentViews ?? [];
              return [
                ...views.filter((view) => view.id !== savedView.id),
                savedView,
              ];
            },
          );
          writeQuery({ ...query, savedViewId: savedView.id }, skillId);
          setSaveViewOpen(false);
          setSaveViewName("");
          return queryClient.invalidateQueries({
            queryKey: skillLibraryKeys.savedViews(),
          });
        },
        () => setSaveViewError(t("skillLibrary.page.saveView.error")),
      )
      .finally(() => setSaveViewPending(false));
  };

  let preferenceStatus: JSX.Element | null = null;
  if (tableSaveFailure) {
    preferenceStatus = (
      <PreferenceStatus
        message={t("skillLibrary.page.preferences.notSaved")}
        onRestore={() => persistTablePreferences(DEFAULT_TABLE_PREFERENCES)}
        onRetry={() => persistTablePreferences(tableSaveFailure)}
      />
    );
  } else if (drawerSaveFailure) {
    preferenceStatus = (
      <PreferenceStatus
        message={t("skillLibrary.page.preferences.notSaved")}
        onRestore={() => {
          setDrawerPreferences(DEFAULT_DRAWER_PREFERENCES);
          void persistDrawerPreferences(DEFAULT_DRAWER_PREFERENCES).catch(
            () => undefined,
          );
        }}
        onRetry={() => {
          void persistDrawerPreferences(drawerSaveFailure).catch(
            () => undefined,
          );
        }}
      />
    );
  } else if (tablePreferencesQuery.isError) {
    preferenceStatus = (
      <PreferenceStatus
        message={t("skillLibrary.page.preferences.tableLoadError")}
        onRetry={() => void tablePreferencesQuery.refetch()}
      />
    );
  } else if (drawerPreferencesQuery.isError) {
    preferenceStatus = (
      <PreferenceStatus
        message={t("skillLibrary.page.preferences.drawerLoadError")}
        onRetry={() => void drawerPreferencesQuery.refetch()}
      />
    );
  } else if (savedViewsQuery.isError) {
    preferenceStatus = (
      <PreferenceStatus
        message={t("skillLibrary.page.preferences.viewsLoadError")}
        onRetry={() => void savedViewsQuery.refetch()}
      />
    );
  }

  if (pageQuery.isPending) {
    return (
      <section className="sh-skill-library" ref={rootRef}>
        <SkillLibrarySkeleton />
      </section>
    );
  }

  if (pageQuery.isError && isSkillLibraryUnavailable(pageQuery.error)) {
    return (
      <section className="sh-skill-library" ref={rootRef}>
        <DataState
          message={t("skillLibrary.page.states.unavailable")}
          state="unavailable"
        />
      </section>
    );
  }

  if (pageQuery.isError) {
    return (
      <section className="sh-skill-library" ref={rootRef}>
        <DataState
          actionLabel={t("actions.retry")}
          message={t("skillLibrary.page.states.error")}
          onAction={() => void pageQuery.refetch()}
          state="error"
        />
      </section>
    );
  }

  const page = pageQuery.data;
  const pageRefreshing = pageQuery.isPlaceholderData;
  if (!pageRefreshing && page.total === 0 && !hasActiveFilter(query)) {
    return (
      <section className="sh-skill-library" ref={rootRef}>
        <DataState
          actionLabel={onOpenDiscovery ? t("skillLibrary.page.states.openDiscovery") : undefined}
          message={t("skillLibrary.page.states.empty")}
          onAction={onOpenDiscovery}
          state="empty"
        />
        <p className="sh-skill-library__boundary">
          {t("skillLibrary.page.states.importBoundary")}
        </p>
      </section>
    );
  }

  if (!pageRefreshing && page.items.length === 0 && hasActiveFilter(query)) {
    return (
      <section className="sh-skill-library" ref={rootRef}>
        <DataState
          actionLabel={t("skillLibrary.filters.clear")}
          message={t("skillLibrary.page.states.noResults")}
          onAction={clearFilters}
          state="empty"
        />
      </section>
    );
  }

  return (
    <section
      className={`sh-skill-library${selectedBatchTarget ? " sh-skill-library--batch-active" : ""}`}
      ref={rootRef}
    >
      <div className="sh-skill-library__saved-views">
        {savedViewDeleteError ? <p role="alert">{savedViewDeleteError}</p> : null}
        <SavedViews
          activeViewId={query.savedViewId}
          dirty={savedViewIsDirty(activeSavedView, query, effectiveTablePreferences)}
          onApply={applyView}
          onDelete={deleteSavedView}
          onSave={() => {
            setSaveViewError(undefined);
            setSaveViewOpen(true);
          }}
          views={savedViews}
        />
      </div>

      {saveViewOpen ? (
        <SaveViewForm
          error={saveViewError}
          name={saveViewName}
          onCancel={() => setSaveViewOpen(false)}
          onNameChange={setSaveViewName}
          onSubmit={submitSavedView}
          pending={saveViewPending}
        />
      ) : null}

      {deployTarget ? (
        <p aria-live="polite" className="sh-notice" role="status">
          {t("skillLibrary.page.deployTargetBanner", { label: deployTarget.label })}
        </p>
      ) : null}
      <div className="sh-skill-library__view-toggle">
        <Button
          aria-pressed={viewMode === "cards"}
          onClick={toggleViewMode}
          size="sm"
          variant="ghost"
        >
          {viewMode === "table" ? t("skillLibrary.viewMode.toggle") : t("skillLibrary.viewMode.toggle")}
        </Button>
      </div>
      {preferenceStatus}
      {selectionAnnouncement ? (
        <p className="sh-skill-library__announcement" role="status">
          {selectionAnnouncement}
        </p>
      ) : null}

      <div className={`sh-skill-library__query-tools${filtersCollapsed ? " is-collapsed" : ""}`}>
        <button
          aria-controls="skill-library-filters"
          aria-expanded={!filtersCollapsed}
          aria-label={t(filtersCollapsed ? "skillLibrary.filters.expand" : "skillLibrary.filters.collapse")}
          className="sh-skill-library__query-toggle"
          onClick={() => setFiltersCollapsed((collapsed) => !collapsed)}
          type="button"
        >
          <span aria-hidden="true">{filtersCollapsed ? "⌄" : "⌃"}</span>
        </button>
        {!filtersCollapsed ? (
          <SkillFilters
            availableTags={page.facets.tags}
            id="skill-library-filters"
            onChange={updateQuery}
            onClear={clearFilters}
            query={query}
            versionFilterSupported={capabilities?.versionFilterSupported ?? true}
          />
        ) : null}
      </div>

      {pageRefreshing ? (
        <SkillLibrarySkeleton />
      ) : (
        {viewMode === "cards" ? (
          <div className="sh-skill-cards" data-testid="skill-cards">
            {page.items.map((item) => (
              <article
                className="sh-skill-card"
                data-testid={`skill-card-${item.id}`}
                key={item.id}
              >
                <button className="sh-skill-card__open" onClick={() => openSkill(item.id)} type="button">
                  <strong>{item.name}</strong>
                </button>
                {item.purpose ? <p>{item.purpose}</p> : null}
                {item.tags.length > 0 ? (
                  <ul aria-label={t("skillLibrary.page.card.tags")} className="sh-skill-card__tags">
                    {item.tags.map((tag) => <li key={tag}>{tag}</li>)}
                  </ul>
                ) : null}
                <span className="sh-skill-card__facts">
                  {t("skillLibrary.page.card.deploymentCount", { count: item.agentDeploymentCount })}
                </span>
              </article>
            ))}
          </div>
        ) : (
        <SkillTable
          pageStatus={t("skillLibrary.page.pageStatus", {
            count: page.total,
            page: page.page,
          })}
          onOpenSkill={openSkill}
          onPreferencesChange={persistTablePreferences}
          onQueryChange={updateQuery}
          onSelectionChange={(next) => {
            setSelectionAnnouncement(undefined);
            changeSelection(next);
          }}
          page={page}
          preferences={effectiveTablePreferences}
          query={query}
          returnPosition={
            libraryReturnState
              ? {
                  focusSkillId: libraryReturnState.focusSkillId,
                  left: libraryReturnState.scrollLeft,
                  top: libraryReturnState.scrollTop,
                }
              : undefined
          }
          selection={selection}
          sortableColumns={capabilities?.sortableColumns}
        />
        )}
      )}

      {selectedBatchTarget ? (
        <BatchBar
          announcement={batchAnnouncement}
          barRef={setBatchBarElement}
          onAction={emitBatchAction}
          onClear={() => {
            changeSelection({ kind: "none" });
          }}
          onDelete={() => void startBatchRemoval()}
          onSelectAll={() =>
            changeSelection(
              selectAllFiltered(
                { filters: query.filters, text: query.text },
                skillFilterKey(query),
                page.total,
              ),
            )}
          onStartExport={startBatchExport}
          onTagAction={setBatchTagAction}
          page={page}
          selection={selectedBatchTarget}
        />
      ) : null}

      {selectedBatchTarget && batchTagAction ? (
        <BatchTagDialog
          action={batchTagAction}
          count={selectionCount(selectedBatchTarget)}
          onCancel={() => setBatchTagAction(undefined)}
          onConfirm={(tags) => {
            setBatchTagAction(undefined);
            emitBatchTagAction(batchTagAction, tags);
          }}
        />
      ) : null}

      <SkillQuickDrawer
        detailSearch={detailSearchFromLibrary(location.search)}
        facade={drawerFacade}
        libraryReturn={
          skillId
            ? {
                focusSkillId: skillId,
                scrollLeft: scrollPositionRef.current?.left ?? 0,
                scrollTop: scrollPositionRef.current?.top ?? 0,
              }
            : undefined
        }
        onOpenChange={(open) => {
          if (!open) closeDrawer();
        }}
        onDelete={(id, name) => {
          closeDrawer();
          void startBatchRemoval({ id, name });
        }}
        onPreferencesChange={setDrawerPreferences}
        open={Boolean(skillId)}
        preferenceSaveFailed={Boolean(drawerSaveFailure)}
        preferences={effectiveDrawerPreferences}
        returnFocusRef={returnFocusRef}
        skillId={skillId}
      />
      {batchRemovalLoading ? <p role="status">{t("removal.loading")}</p> : null}
      {batchRemovalImpacts ? <BatchRemovalImpactDialog
        error={batchRemovalError}
        impacts={batchRemovalImpacts}
        onCancel={() => setBatchRemovalImpacts(null)}
        onConfirm={commitBatchRemoval}
        submitting={batchRemovalSubmitting}
      /> : null}
      {batchRemovalError && !batchRemovalLoading && !batchRemovalImpacts ? <p role="alert">{batchRemovalError}</p> : null}
    </section>
  );
}
