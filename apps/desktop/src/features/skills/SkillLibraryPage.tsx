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
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import "./batchBar.css";
import "./skills.css";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { Input } from "../../ui/Input";
import { describeNativeError } from "../../api/nativeErrors";
// M-21 #5：页面直接消费全局通知中心（AppShell 级单例服务），不再保留
// 页面内局部通知列表（NotificationCenter/useNotices 兼容桥从本页移除）。
import { useAppNotifications } from "../../ui/notifications";
import { Icon, type IconName } from "../../ui/Icon";
import {
  detailSearchFromLibrary,
  readLibraryReturnState,
} from "../skill-detail/detailContext";
import { SkillCard } from "../shared/skill-card/SkillCard";
import type { SkillCardViewModel } from "../shared/skill-card/SkillCardViewModel";
import {
  BUILT_IN_SAVED_VIEWS,
  DEFAULT_DRAWER_PREFERENCES,
  DEFAULT_SKILL_QUERY,
  DEFAULT_TABLE_PREFERENCES,
  isSkillLibraryUnavailable,
  SkillLibraryUnavailableError,
  skillLibraryKeys,
  type BatchAction,
  type SavedSkillView,
  type SkillColumnId,
  type SkillDrawerPreferences,
  type SkillLibraryFacade,
  type SkillLibraryQuery,
  type SkillPage,
  type SkillTablePreferences,
  type LibraryViewMode,
  type DeploymentRecord,
  type DeploymentTarget,
  type LibraryGroupMode,
  type SkillTableRow,
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
  selectExplicit,
  excludeFromAllFiltered,
  setPageSelection,
  type SkillSelection,
} from "./selection";
import { SkillFilters } from "./SkillFilters";
import { BatchTagDialog, type BatchTagAction } from "./BatchTagDialog";
import { SkillQuickDrawer } from "./SkillQuickDrawer";
import { SkillMatrix } from "./SkillMatrix";
import { SkillPagination } from "./SkillPagination";
import { SkillTable } from "./SkillTable";
import { SourceUpdateCheckSummary } from "./SourceUpdateCheckSummary";
import { BatchRemovalDrawer } from "./BatchRemovalDrawer";
import { BatchOperationSummary, type BatchOutcome } from "../../ui/BatchOperationSummary";
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
  barRef: Ref<HTMLElement>;
  checkUpdatesPending?: boolean;
  onAction: (action: BatchAction) => void;
  onCheckUpdates?: () => void;
  onClear: () => void;
  onDelete: () => void;
  onSelectAll: () => void;
  onStartExport: () => void;
  onTagAction: (action: BatchTagAction) => void;
  page: SkillPage;
  selection: Exclude<SkillSelection, { kind: "none" }>;
}

const BATCH_ACTION_KEYS = {
  add_to: "skillLibrary.page.batch.addTo",
  add_tag: "skillLibrary.page.batch.addTags",
  archive: "skillLibrary.page.batch.archive",
  export: "skillLibrary.page.batch.export",
  remove_tag: "skillLibrary.page.batch.removeTags",
  security_check: "skillLibrary.page.batch.securityCheck",
} as const satisfies Record<BatchAction, string>;

// P1-08：视图/分组切换的分段控件选项。视图用图标 + 可访问名，分组用短文本。
const VIEW_MODE_OPTIONS: ReadonlyArray<{
  icon: IconName;
  labelKey:
    | "skillLibrary.viewMode.table"
    | "skillLibrary.viewMode.cards"
    | "skillLibrary.viewMode.matrix";
  mode: LibraryViewMode;
}> = [
  { icon: "operations", labelKey: "skillLibrary.viewMode.table", mode: "table" },
  { icon: "library", labelKey: "skillLibrary.viewMode.cards", mode: "cards" },
  { icon: "agents", labelKey: "skillLibrary.viewMode.matrix", mode: "matrix" },
];

const GROUP_MODE_OPTIONS: ReadonlyArray<{
  labelKey: "skillLibrary.groupMode.none" | "skillLibrary.groupMode.tags";
  mode: LibraryGroupMode;
}> = [
  { labelKey: "skillLibrary.groupMode.none", mode: "none" },
  { labelKey: "skillLibrary.groupMode.tags", mode: "tags" },
];

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
        <Input
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
  barRef,
  checkUpdatesPending,
  onAction,
  onCheckUpdates,
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
      <Button onClick={onClear} size="sm" variant="ghost">
        {t("skillLibrary.page.selection.clear")}
      </Button>
      {/* AR-024 按使用频率分组：高频（部署/标签/导出/检查更新）→ 管理类（安全检查/批量流程/归档）→ 破坏性（删除，单独分组降级呈现）。 */}
      <div className="sh-skill-library__batch-actions">
        <Button
          onClick={() => onAction("add_to")}
          size="sm"
          title={t("skillLibrary.page.batch.addToTitle")}
          variant="ghost"
        >
          {t(BATCH_ACTION_KEYS.add_to)}
        </Button>
        <Button onClick={() => onTagAction("add_tag")} size="sm" variant="ghost">
          {t("skillLibrary.page.batch.addTags")}
        </Button>
        <Button onClick={() => onTagAction("remove_tag")} size="sm" variant="ghost">
          {t("skillLibrary.page.batch.removeTags")}
        </Button>
        <Button
          onClick={onStartExport}
          size="sm"
          title={t("skillLibrary.page.batch.startExportTitle")}
          variant="ghost"
        >
          {t("skillLibrary.page.batch.startExport")}
        </Button>
        {onCheckUpdates ? (
          <Button
            disabled={checkUpdatesPending}
            onClick={onCheckUpdates}
            size="sm"
            variant="ghost"
          >
            {checkUpdatesPending
              ? t("skillLibrary.page.batch.checkUpdatesPending")
              : t("skillLibrary.page.batch.checkUpdates")}
          </Button>
        ) : null}
        <Button
          onClick={() => onAction("security_check")}
          size="sm"
          variant="ghost"
        >
          {t(BATCH_ACTION_KEYS.security_check)}
        </Button>
        <Button
          onClick={() => onAction("export")}
          size="sm"
          title={t("skillLibrary.page.batch.exportTitle")}
          variant="ghost"
        >
          {t(BATCH_ACTION_KEYS.export)}
        </Button>
        <Button onClick={() => onAction("archive")} size="sm" variant="ghost">
          {t(BATCH_ACTION_KEYS.archive)}
        </Button>
        <div className="sh-skill-library__batch-destructive">
          <Button onClick={onDelete} size="sm" variant="ghost">
            {t("skillLibrary.page.batch.delete")}
          </Button>
        </div>
      </div>
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
  // describeNativeError 的 translate 签名与 i18next 的 TFunction 不完全一致，
  // 经包装收敛（同 SemanticDuplicatePanel 先例），结构化错误码不再 String() 直达界面。
  const describeError = (reason: unknown, genericKey: string): string =>
    describeNativeError(
      reason,
      (key, options) => String(t(key as never, options as never)),
      genericKey,
    );
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
  // P1-11→M-21 通知规范：成功/中性经全局 toast 自动消退（2 秒，历史保留），
  // 危险通知走全局 alert 通道；批量错误随选择变更经 dismissByKind 撤销。
  const { dismissByKind, notify } = useAppNotifications();
  const [batchTagAction, setBatchTagAction] = useState<BatchTagAction>();
  // P1-08：工具栏第二行（已保存视图）可折叠；搜索与模式开关保持在第一行。
  const [toolbarOpen, setToolbarOpen] = useState(true);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [saveViewName, setSaveViewName] = useState("");
  const [saveViewError, setSaveViewError] = useState<string>();
  const [saveViewPending, setSaveViewPending] = useState(false);
  const [batchRemovalImpacts, setBatchRemovalImpacts] = useState<RemovalImpact[] | null>(null);
  const [batchRemovalLoading, setBatchRemovalLoading] = useState(false);
  const [batchRemovalSubmitting, setBatchRemovalSubmitting] = useState(false);
  const [batchRemovalError, setBatchRemovalError] = useState<string>();
  const [sourceUpdatesPending, setSourceUpdatesPending] = useState(false);
  const defaultPageRetry = queryClient.getDefaultOptions().queries?.retry;

  const clearBatchAnnouncement = () => {
    batchRequestRef.current += 1;
    dismissByKind("batch");
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

  // T3-B 卡片视图：普通用户默认增强卡片视图；表格保留为专业模式。
  // 视图模式经 ui 偏好持久化；facade 未提供读取能力时静默使用默认卡片视图。
  const [viewMode, setViewMode] = useState<LibraryViewMode>("cards");
  const viewModeRef = useRef<LibraryViewMode>("cards");
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
  const [deploymentRecords, setDeploymentRecords] = useState<DeploymentRecord[]>();
  const [deploymentTargets, setDeploymentTargets] = useState<DeploymentTarget[]>();
  useEffect(() => {
    let active = true;
    void facade.listDeployments?.().then((records) => {
      if (active) setDeploymentRecords(records);
    }).catch(() => undefined);
    void facade.listDeploymentTargets?.().then((targets) => {
      if (active) setDeploymentTargets(targets);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [facade]);
  const [groupMode, setGroupMode] = useState<LibraryGroupMode>("none");
  useEffect(() => {
    let active = true;
    void facade.loadGroupMode?.().then((mode) => {
      if (active) setGroupMode(mode);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [facade]);
  const changeGroupMode = useCallback(
    (next: LibraryGroupMode) => {
      setGroupMode(next);
      void facade.saveGroupMode?.(next).catch(() => undefined);
    },
    [facade],
  );

  const changeViewMode = useCallback(
    (next: LibraryViewMode) => {
      viewModeRef.current = next;
      setViewMode(next);
      void facade.saveViewMode?.(next).catch(() => undefined);
    },
    [facade],
  );

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
    dismissByKind("saved-view-delete");
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
      () =>
        notify({
          kind: "saved-view-delete",
          title: t("skillLibrary.savedViews.deleteError"),
          tone: "danger",
        }),
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

  // P1-11 主次语义对调：卡区激活开快速抽屉（openSkill），
  // “查看”按钮跳完整详情页（与抽屉内的完整详情入口同一路由约定）。
  const openSkillDetail = (nextSkillId: string) => {
    const base = location.pathname.startsWith("/__preview")
      ? "/__preview/skill-detail"
      : "/library";
    navigate({
      pathname: `${base}/${nextSkillId}`,
      search: detailSearchFromLibrary(location.search),
    });
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
        () =>
          notify({
            kind: "batch",
            title: t("skillLibrary.page.batch.error"),
            tone: "danger",
          }),
      );
      return;
    }
    const request = batchRequestRef.current + 1;
    batchRequestRef.current = request;
    const intent = { action, target: selectionToBatchTarget(selection) };
    void facade.emitBatchIntent(intent).catch((error: unknown) => {
      if (request !== batchRequestRef.current) return;
      notify({
        kind: "batch",
        title: isSkillLibraryUnavailable(error)
          ? t("skillLibrary.page.batch.unconnected")
          : t("skillLibrary.page.batch.error"),
        tone: "danger",
      });
    });
  };

  // P1-10：批量标签写落地——生产 emitBatchIntent 未绑定，这里改为
  // 对选中集合逐项 get→set（set_metadata 整体覆盖语义），
  // 单项失败不掩盖其余，产出 BatchOutcome[] 交给常驻结果区。
  const applyBatchTags = async (action: BatchTagAction, tags: string[]) => {
    if (selection.kind === "none" || selectionCount(selection) <= 0) return;
    const request = batchRequestRef.current + 1;
    batchRequestRef.current = request;
    try {
      const selected = await selectedSkillsForRemoval();
      const save = facade.saveSkillMetadata?.bind(facade);
      // 各选中项互不依赖，并行 get→set；逐项失败语义保持不变。
      const outcomes: BatchOutcome[] = await Promise.all(selected.map(async (skill) => {
        try {
          if (!save) throw new SkillLibraryUnavailableError();
          const view = await facade.getSkillQuickView(skill.id);
          const nextTags = action === "add_tag"
            ? [...new Set([...view.tags, ...tags])]
            : view.tags.filter((current) => !tags.includes(current));
          const unchanged =
            nextTags.length === view.tags.length &&
            nextTags.every((tag, index) => tag === view.tags[index]);
          if (unchanged) {
            return { id: skill.id, label: skill.name, status: "skipped" } as BatchOutcome;
          }
          await save(skill.id, { tags: nextTags });
          return { id: skill.id, label: skill.name, status: "succeeded" } as BatchOutcome;
        } catch (reason: unknown) {
          return {
            id: skill.id,
            label: skill.name,
            message: describeError(reason, "skillLibrary.page.batch.tagOutcomeError"),
            status: "failed",
          } as BatchOutcome;
        }
      }));
      if (request !== batchRequestRef.current) return;
      await queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
      const failedCount = outcomes.filter((outcome) => outcome.status === "failed").length;
      // 全局通知契约：成功 toast 自动消退（本体保留在会话历史）；失败走危险通道。
      notify({
        detailNode: <BatchOperationSummary outcomes={outcomes} />,
        kind: "batch-tags",
        title: t(
          failedCount > 0
            ? "skillLibrary.page.batchTags.partialFailure"
            : "skillLibrary.page.batchTags.done",
        ),
        tone: failedCount > 0 ? "danger" : "success",
      });
    } catch {
      if (request === batchRequestRef.current) {
        notify({
          kind: "batch-tags",
          title: t("skillLibrary.page.batch.error"),
          tone: "danger",
        });
      }
    }
  };

  const startBatchUpdateCheck = () => {
    if (selection.kind === "none" || selectionCount(selection) <= 0) return;
    if (!facade.checkSourceUpdates) return;
    const request = batchRequestRef.current + 1;
    batchRequestRef.current = request;
    setSourceUpdatesPending(true);
    const checkFacade = facade.checkSourceUpdates;
    void selectedSkillsForRemoval()
      .then(async (skills) => {
        const entries = await checkFacade(skills.map((skill) => skill.id));
        if (request !== batchRequestRef.current) return;
        const names = new Map(skills.map((skill) => [skill.id, skill.name]));
        const reports = entries.map((entry) => ({
          ...entry,
          name: names.get(entry.skillId) ?? entry.skillId,
        }));
        // 来源更新检查结果随全局通知展示（详情面板随通知展开，历史保留）。
        notify({
          detailNode: <SourceUpdateCheckSummary reports={reports} />,
          kind: "batch",
          title: t("skillLibrary.page.sourceUpdates.title"),
          tone: "info",
        });
      })
      .catch((error: unknown) => {
        if (request !== batchRequestRef.current) return;
        notify({
          kind: "batch",
          title: isSkillLibraryUnavailable(error)
            ? t("skillLibrary.page.batch.unconnected")
            : t("skillLibrary.page.batch.error"),
          tone: "danger",
        });
      })
      .finally(() => {
        if (request === batchRequestRef.current) setSourceUpdatesPending(false);
      });
  };

  const startBatchExport = () => {    if (selection.kind === "none" || selectionCount(selection) <= 0) return;
    if (selection.kind === "explicit") {
      navigate("/settings/data-protection", { state: { exportSkillIds: [...selection.skillIds] } });
      return;
    }
    void selectedSkillsForRemoval().then(
      (skills) => navigate("/settings/data-protection", {
        state: { exportSkillIds: skills.map((skill) => skill.id) },
      }),
      () =>
        notify({
          kind: "batch",
          title: t("skillLibrary.page.batch.error"),
          tone: "danger",
        }),
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
    dismissByKind("removal-summary");
    try {
      const selected = single ? [single] : await selectedSkillsForRemoval();
      // prepare_delete 是只读准备，各项独立；仍保持首错即停的外层 catch 语义。
      const impacts: RemovalImpact[] = await Promise.all(
        selected.map((skill) => removalFacade.prepareDelete(skill.id, skill.name)),
      );
      setBatchRemovalImpacts(impacts);
    } catch {
      const message = t("removal.batch.loadError");
      setBatchRemovalError(message);
      // 影响读取失败：抽屉内与全局通知双通道可见，不静默。
      notify({ kind: "removal-summary", title: message, tone: "danger" });
    } finally {
      setBatchRemovalLoading(false);
    }
  };

  const commitBatchRemoval = async (choices: Record<string, Record<string, RemovalChoice>>) => {
    if (!batchRemovalImpacts) return;
    setBatchRemovalSubmitting(true);
    setBatchRemovalError(undefined);
    const outcomes: BatchOutcome[] = [];
    // 批量删除刻意逐项推进并汇总，而不是首错即停：单个 Skill 失败不掩盖其余结果。
    for (const impact of batchRemovalImpacts) {
      const label = impact.skillName ?? impact.skillId ?? "unknown";
      const outcomeId = impact.operationId ?? label;
      if (!impact.operationId) {
        outcomes.push({ id: outcomeId, label, status: "failed", message: t("removal.batch.missingPreparation") });
        continue;
      }
      try {
        const result = await removalFacade.commitDelete(impact.operationId, choices[impact.operationId] ?? {});
        if (!result.centralSkillDeleted) throw new Error("central skill was not deleted");
        outcomes.push({ id: outcomeId, label, status: "succeeded" });
      } catch (reason: unknown) {
        // 结构化 AppError 不允许 String() 直达用户界面（P1-10 错误路径统一）。
        outcomes.push({
          id: outcomeId,
          label,
          message: describeError(reason, "removal.batch.outcomeError"),
          status: "failed",
        });
      }
    }
    await queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
    // 全局通知契约：结果 toast 自动消退（本体保留在会话历史），不再常驻文档流末尾。
    const failedCount = outcomes.filter((outcome) => outcome.status === "failed").length;
    notify({
      detailNode: <BatchOperationSummary outcomes={outcomes} />,
      kind: "removal-summary",
      title: t(
        failedCount > 0
          ? "skillLibrary.page.batchRemovals.partialFailure"
          : "skillLibrary.page.batchRemovals.done",
      ),
      tone: failedCount > 0 ? "danger" : "success",
    });
    setBatchRemovalImpacts(null);
    changeSelection({ kind: "none" });
    setBatchRemovalSubmitting(false);
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
  const isSkillSelected = (skillId: string) =>
    selection.kind === "all_filtered"
      ? !selection.excludedSkillIds.includes(skillId)
      : selection.kind === "explicit" && selection.skillIds.includes(skillId);
  const toggleSkillSelected = (skillId: string, selected: boolean) => {
    setSelectionAnnouncement(undefined);
    if (selection.kind === "all_filtered") {
      changeSelection(excludeFromAllFiltered(selection, skillId, !selected));
      return;
    }
    changeSelection(selectExplicit(selection, [skillId], selected));
  };
  // T3-B：库内 Skill 的可证实字段映射到共享卡片；来源缺失时如实标注集中库，
  // 不伪造作者、评分或兼容性。升级/风险状态保持“标记+文字”与既有测试锚点。
  const renderSkillCard = (item: SkillTableRow) => {
    const card: SkillCardViewModel = {
      id: item.id,
      name: item.name,
      // P1-10：别名场景下卡片同时展示展示名（标题）与原名（小一号副名）。
      subtitle:
        item.originalName && item.originalName !== item.name
          ? item.originalName
          : undefined,
      sourceType: "local",
      sourceLabel: item.source ?? t("skillLibrary.page.card.sourceLocal"),
      description:
        item.purpose || item.translatedDescription || item.originalDescription || undefined,
      metrics: [
        t("skillLibrary.page.card.version", { version: item.currentVersion }),
        t("skillLibrary.page.card.deploymentCount", { count: item.agentDeploymentCount }),
        t("skillLibrary.table.projectDeployments", { count: item.projectDeploymentCount }),
      ],
      statuses: [
        ...(item.upgradeAvailable
          ? [{
              label: t("skillLibrary.page.card.upgradeAvailable"),
              testId: `skill-card-upgrade-${item.id}`,
              tone: "warning" as const,
            }]
          : []),
        ...(item.highRiskCount > 0
          ? [{
              label: t("skillLibrary.page.card.highRisk", { count: item.highRiskCount }),
              testId: `skill-card-risk-${item.id}`,
              tone: "danger" as const,
            }]
          : []),
      ],
    };
    return (
      <SkillCard
        headingLevel={groupMode === "tags" ? "h4" : "h2"}
        key={item.id}
        onCardActivate={(event) => openSkill(item.id, event.currentTarget)}
        primaryAction={
          <Button
            onClick={(event) => {
              event.stopPropagation();
              openSkillDetail(item.id);
            }}
            variant="secondary"
          >
            {t("skillLibrary.page.card.open", { name: item.name })}
          </Button>
        }
        secondaryAction={
          <label
            className="sh-skill-card__select"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <input
              aria-label={t("skillLibrary.table.selectSkill", { name: item.name })}
              checked={isSkillSelected(item.id)}
              className="sh-control-checkbox"
              onChange={(event) => toggleSkillSelected(item.id, event.currentTarget.checked)}
              type="checkbox"
            />
          </label>
        }
        skill={card}
        testId={`skill-card-${item.id}`}
      />
    );
  };

  // 注意：此处位于若干早退 return 之后，不能用 useMemo（hooks 顺序约束）。
  // 仅卡片视图按标签分组时消费，成本为 O(页条目 × 标签数)，可接受。
  const groupedCards = new Map<string, SkillTableRow[]>();
  for (const item of page.items) {
    const tags = item.tags.length > 0 ? item.tags : ["—"];
    for (const tag of tags) {
      const bucket = groupedCards.get(tag) ?? [];
      bucket.push(item);
      groupedCards.set(tag, bucket);
    }
  }
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
      className={[
        "sh-skill-library",
        // M-21 #3：表格视图时页面成为定高 flex 列，表格区域自成滚动容器。
        !pageRefreshing && viewMode === "table" ? "sh-skill-library--table-view" : "",
        selectedBatchTarget ? "sh-skill-library--batch-active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={rootRef}
    >
      {deployTarget ? (
        <p aria-live="polite" className="sh-notice" role="status">
          {t("skillLibrary.page.deployTargetBanner", { label: deployTarget.label })}
        </p>
      ) : null}
      {/* M-21 IA 重排：主行 = 主搜索 + 结果摘要（左）与页面动作簇（右，最右）。
          视图切换（表格/卡片/关系矩阵）与组合管理入口移至动作簇最右；
          第二行（可折叠）= 已保存视图。查询语义不变。 */}
      <div className="sh-skill-library__toolbar">
        <div className="sh-skill-library__toolbar-main">
          <SkillFilters
            availableTags={page.facets.tags}
            id="skill-library-filters"
            onChange={updateQuery}
            onClear={clearFilters}
            query={query}
            versionFilterSupported={capabilities?.versionFilterSupported ?? true}
          />
          <section aria-label={t("skillLibrary.page.summary.label")} className="sh-skill-library__summary">
            <span data-testid="library-summary-total">
              {t("skillLibrary.page.summary.total", { count: page.total })}
            </span>
            <span data-testid="library-summary-tags">
              {t("skillLibrary.page.summary.tags", { count: page.facets.tags.length })}
            </span>
          </section>
          <div className="sh-skill-library__toolbar-actions">
            <div
              aria-label={t("skillLibrary.viewMode.label")}
              className="sh-skill-library__mode-switch"
              role="group"
            >
              {VIEW_MODE_OPTIONS.map((option) => (
                <Button
                  aria-label={t(option.labelKey)}
                  aria-pressed={viewMode === option.mode}
                  key={option.mode}
                  onClick={() => changeViewMode(option.mode)}
                  title={t(option.labelKey)}
                  variant={viewMode === option.mode ? "secondary" : "ghost"}
                >
                  <Icon aria-hidden="true" name={option.icon} size={16} />
                </Button>
              ))}
            </div>
            <div
              aria-label={t("skillLibrary.groupMode.label")}
              className="sh-skill-library__mode-switch"
              role="group"
            >
              {GROUP_MODE_OPTIONS.map((option) => (
                <Button
                  aria-pressed={groupMode === option.mode}
                  key={option.mode}
                  onClick={() => changeGroupMode(option.mode)}
                  size="sm"
                  variant={groupMode === option.mode ? "secondary" : "ghost"}
                >
                  {t(option.labelKey)}
                </Button>
              ))}
            </div>
            {facade.listCombinations ? (
              <Link className="sh-skill-library__combination-entry" to="/library/combinations">
                {t("skillLibrary.combinations.managerEntry")}
              </Link>
            ) : null}
            <button
              aria-controls="sh-skill-library-toolbar-secondary"
              aria-expanded={toolbarOpen}
              className="sh-skill-library__toolbar-toggle sh-button sh-button--ghost sh-button--sm"
              onClick={() => setToolbarOpen((open) => !open)}
              type="button"
            >
              {toolbarOpen
                ? t("skillLibrary.toolbar.collapse")
                : t("skillLibrary.toolbar.expand")}
            </button>
          </div>
        </div>
        <div
          className="sh-skill-library__toolbar-secondary"
          hidden={!toolbarOpen}
          id="sh-skill-library-toolbar-secondary"
        >
          <div className="sh-skill-library__saved-views">
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
        </div>
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
      {preferenceStatus}
      {selectionAnnouncement ? (
        <p className="sh-skill-library__announcement" role="status">
          {selectionAnnouncement}
        </p>
      ) : null}

      {pageRefreshing ? (
        <SkillLibrarySkeleton />
      ) : null}
      {!pageRefreshing && viewMode === "matrix" ? (
          <SkillMatrix
            deploymentRecords={deploymentRecords}
            deploymentTargets={deploymentTargets}
            items={page.items}
          />
      ) : null}
      {!pageRefreshing && viewMode === "cards" ? (
        <>
          {/* P1-08：卡片视图补齐与表格对等的“选择当前页”入口（共用选择模型）。 */}
          <div className="sh-skill-cards__toolbar">
            <label className="sh-skill-cards__select-page">
              <input
                aria-label={t("skillLibrary.table.selectCurrentPage")}
                checked={page.items.length > 0 && page.items.every((item) => isSkillSelected(item.id))}
                className="sh-control-checkbox"
                onChange={(event) =>
                  changeSelection(
                    setPageSelection(
                      selection,
                      page.items.map((item) => item.id),
                      event.currentTarget.checked,
                    ),
                  )}
                type="checkbox"
              />
              <span>{t("skillLibrary.table.selectCurrentPage")}</span>
            </label>
          </div>
          {groupMode === "tags" ? (
            [...groupedCards.entries()].map(([tag, groupItems]) => (
              <section key={tag}>
                <h3>{tag}</h3>
                <div className="sh-skill-cards">
                  {groupItems.map((item) => renderSkillCard(item))}
                </div>
              </section>
            ))
          ) : (
            <div className="sh-skill-cards" data-testid="skill-cards">
              {page.items.map((item) => renderSkillCard(item))}
            </div>
          )}
        </>
      ) : null}
      {viewMode === "cards" ? (
        <SkillPagination
          className="sh-skill-cards__pagination"
          onPageChange={(nextPage) => updateQuery({ ...query, page: nextPage })}
          onPageSizeChange={(pageSize) => updateQuery({ ...query, page: 1, pageSize })}
          page={page}
          query={query}
        />
      ) : null}
      {!pageRefreshing && viewMode === "table" ? (
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
      ) : null}

      {selectedBatchTarget ? (
        <BatchBar
          barRef={setBatchBarElement}
          checkUpdatesPending={sourceUpdatesPending}
          onAction={emitBatchAction}
          onCheckUpdates={facade.checkSourceUpdates ? startBatchUpdateCheck : undefined}
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
            void applyBatchTags(batchTagAction, tags);
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
      {batchRemovalImpacts ? <BatchRemovalDrawer
        error={batchRemovalError}
        impacts={batchRemovalImpacts}
        onCancel={() => setBatchRemovalImpacts(null)}
        onConfirm={commitBatchRemoval}
        submitting={batchRemovalSubmitting}
      /> : null}
    </section>
  );
}
