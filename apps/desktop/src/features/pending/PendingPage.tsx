import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { displayPath } from "../../platform/displayPath";
import { describeNativeError } from "../../api/nativeErrors";
import { formatDateTime, resolveLocale } from "../../i18n";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DataState } from "../../ui/DataState";
import { Field } from "../../ui/Field";
import { Icon, type IconName } from "../../ui/Icon";
import { Input } from "../../ui/Input";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { Select } from "../../ui/Select";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { type HandledEntry, type PendingFacade, type PendingItem, type PendingKind, type PendingRisk, unavailablePendingFacade } from "./api";
import "./pending.css";
import { AgentPresentation } from "../../ui/AgentPresentation";
import { pendingKinds, pendingCategories, pendingCategoryForKind, actionableCount, canSnoozePendingItem, groupPendingItems, pendingReviewSkillIds, pendingDestination, pendingReturnHref, type PendingCategory, type PendingGroup, type PendingReviewIntent } from "./workspace";
import { usePendingItems } from "./usePendingItems";

/** 批量暂缓固定 7 天：批量契约只覆盖安全的暂缓/忽略，不覆盖转换/重查/恢复。 */
const BATCH_DEFER_DAYS = 7;

/** 风险档位 → 全站统一图标映射（4.2：状态始终图标＋文字）。 */
const RISK_ICONS: Record<PendingRisk, IconName> = {
  high: "failure",
  medium: "warning",
  low: "info",
};

type PendingAction = { kind: string; label: string; perform: (target: PendingItem) => Promise<void> };

// 组行折叠摘要最多点名 3 个对象，其余以 +N 计数保持行高稳定。
const SUMMARY_NAME_LIMIT = 3;

function PendingGroupRow({
  group,
  facade,
  selectedIds,
  busy,
  processingItemId,
  deferDays,
  changeDeferDays,
  toggleGroup,
  toggleItem,
  runOne,
}: {
  group: PendingGroup;
  facade: PendingFacade;
  selectedIds: string[];
  busy: boolean;
  processingItemId?: string;
  deferDays: 7 | 30;
  changeDeferDays: (days: 7 | 30) => void;
  toggleGroup: (group: PendingGroup) => void;
  toggleItem: (id: string) => void;
  runOne: (item: PendingItem, action: PendingAction) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const selectedCount = group.selectableIds.filter((id) => selectedIds.includes(id)).length;
  const allSelected = group.selectableIds.length > 0 && selectedCount === group.selectableIds.length;
  const summaryNames = group.category === "agents" || group.objectNames.length < 2 ? [] : group.objectNames.slice(0, SUMMARY_NAME_LIMIT);
  const hiddenNameCount = summaryNames.length ? group.objectNames.length - summaryNames.length : 0;
  const title = group.category === "agents"
    ? group.sharedDirectory ? String(t("agents.sharedDirectoryTitle")) : group.agentBrand ?? group.displayName ?? String(t("pending.kinds.agent_compatibility"))
    : group.category === "skill_review"
      ? String(t(`pending.reviewPurpose.${group.reviewPurpose ?? "security_check"}` as never))
      : String(t(`pending.kinds.${group.kind}` as never));
  const factKinds = [...new Set(group.items.map((item) => item.kind))];
  const highRiskItems = group.items.filter((item) => item.risk === "high");
  const firstPath = group.items.find((item) => item.path)?.path;
  const itemName = (item: PendingItem) => item.displayName || String(t(`pending.kinds.${item.kind}` as never));
  const messageFor = (item: PendingItem) => String(t(item.message as never, { defaultValue: String(t(`pending.kinds.${item.kind}` as never)) } as never));
  const getItemLink = (item: PendingItem) => item.href ?? pendingDestination(item);

  return <li className="sh-pending-group">
    <div className="sh-pending-group__row">
      <label className="sh-pending-group__selection">
        <input
          aria-label={String(t("pending.group.selectGroup", { count: group.selectableIds.length }))}
          checked={allSelected}
          disabled={busy || group.selectableIds.length === 0}
          onChange={() => toggleGroup(group)}
          ref={(node) => { if (node) node.indeterminate = selectedCount > 0 && !allSelected; }}
          type="checkbox"
        />
      </label>
      <div className="sh-pending-group__main">
        <div className="sh-pending-group__heading">
          <Button aria-label={`${t(expanded ? "pending.group.collapse" : "pending.group.details")}: ${title}`} aria-expanded={expanded} className="sh-pending-group__toggle" onClick={() => setExpanded((value) => !value)} size="sm" variant="ghost">
            {group.category === "agents" ? <AgentPresentation
              brand={group.sharedDirectory ? undefined : group.agentBrand ?? group.displayName ?? undefined}
              kinds={group.agentKinds}
              sharedDirectory={group.sharedDirectory}
              sharedAgentBrands={group.sharedDirectory ? group.agentBrands : undefined}
              sharedAgentBrandKinds={group.sharedDirectory ? group.agentSharedBrandKinds : undefined}
              sharedBrandOverflowInteractive={false}
            /> : <strong>{title}</strong>}
            <span className="sh-pending-group__chevron" aria-hidden="true">{expanded ? "−" : "+"}</span>
          </Button>
          <Link className="sh-button sh-button--secondary sh-button--sm" to={group.href}>{t("pending.actions.open")}</Link>
        </div>
        <div className="sh-pending-group__facts">
          <span>{t("pending.group.items", { count: group.count })}</span>
          <span>{t("pending.group.objects", { count: group.objectCount })}</span>
          {summaryNames.map((name) => <span className="sh-pending-group__object" key={name}>{name}</span>)}
          {hiddenNameCount > 0 ? <span className="sh-pending-group__object sh-pending-group__object--overflow">+{hiddenNameCount}</span> : null}
          {factKinds.map((kind) => <span className="sh-pending-group__kind" key={kind}>{t(`pending.kinds.${kind}` as never)}</span>)}
          {group.highestRisk ? <span className={`sh-pending-item__risk sh-pending-item__risk--${group.highestRisk}`}>
            <Icon aria-hidden="true" name={RISK_ICONS[group.highestRisk]} />{t(`pending.risk.${group.highestRisk}` as never)}
          </span> : null}
        </div>
        {highRiskItems.length ? <ul aria-label={String(t("pending.group.highRiskReasons", { count: highRiskItems.length }))} className="sh-pending-group__risk-reasons">
          {highRiskItems.map((item) => <li key={item.id}>
            <Icon aria-hidden="true" name={RISK_ICONS.high} />
            <span><strong>{item.displayName || String(t(`pending.kinds.${item.kind}` as never))}</strong> · {messageFor(item)}</span>
            <Link to={getItemLink(item)}>{t("pending.actions.open")}</Link>
          </li>)}
        </ul> : null}
        {firstPath && group.category === "agents" ? <p className="sh-pending-item__path">{displayPath(firstPath)}</p> : null}
      </div>
    </div>
    {expanded ? <ul className="sh-pending-group__details">
      {group.items.map((item) => {
        const name = itemName(item);
        const canSnooze = canSnoozePendingItem(item);
        const isAgent = item.kind === "agent_compatibility";
        const compatibilityMethod = item.checkKind === "managed_copy" || item.checkKind === "symbolic_link" || item.checkKind === "directory_junction"
          ? String(t(`agents.compatibility.methods.${item.checkKind}` as never)) : undefined;
        const trialAction = item.kind === "trial_due"
          ? { kind: "pending_convert", label: String(t("pending.actions.convert")), perform: (target: PendingItem) => facade.convert(target) }
          : null;
        // W3-1（FB-003 裁决第 1 节）：预警待办的「不信任（删除）」跳既有删除
        // 流——进入详情页后由 removalRequest 状态自动打开既有删除影响确认，
        // 不在待办造第二套删除。
        const isSecurityAlert = item.kind === "security_alert";
        return <li className="sh-pending-item" key={item.id}>
          <input
            aria-label={String(t("pending.batch.selectItem", { subject: name }))}
            checked={selectedIds.includes(item.id)}
            className="sh-pending-item__select"
            disabled={busy || !canSnooze}
            onChange={() => toggleItem(item.id)}
            type="checkbox"
          />
          <div className="sh-pending-item__main">
            <div className="sh-pending-item__identity">
              {isAgent ? <AgentPresentation brand={item.agentBrand ?? item.displayName ?? undefined} kinds={item.agentKinds} />
                : item.risk === "high" ? null : <strong className="sh-pending-item__subject">{name}</strong>}
              {item.risk ? <span className={`sh-pending-item__risk sh-pending-item__risk--${item.risk}`}>
                <Icon aria-hidden="true" name={RISK_ICONS[item.risk]} />{t(`pending.risk.${item.risk}` as never)}
              </span> : null}
            </div>
            <p className="sh-pending-item__message">{messageFor(item)}</p>
            {compatibilityMethod ? <small>{compatibilityMethod}</small> : null}
            {item.path ? <p className="sh-pending-item__path">{displayPath(item.path)}</p> : null}
            <div className="sh-pending-item__facts">
              {item.dueDate ? <small className="sh-pending-item__fact"><Icon aria-hidden="true" name="pending" />{t("pending.dueDate", { date: item.dueDate })}</small> : null}
              {typeof item.affectedDeployments === "number" ? <small className="sh-pending-item__fact"><Icon aria-hidden="true" name="deploy" />{t("pending.impact", { count: item.affectedDeployments })}</small> : null}
            </div>
            {/* W3-1：预警条目无顺延/忽略；「稍后处理」语义由静态说明承载。 */}
            {isSecurityAlert ? <small className="sh-pending-item__note">{t("pending.securityAlert.deferNote")}</small> : null}
          </div>
          <div aria-label={String(t("pending.item.actionsGroup", { subject: name }))} className="sh-pending-item__actions" role="group">
            <Link className="sh-button sh-button--secondary" to={getItemLink(item)} state={item.kind === "import_skills" && item.sourceRoots?.length ? { initialSources: item.sourceRoots, onboardingImport: true } : undefined}>{t("pending.actions.open")}</Link>
            {isSecurityAlert && facade.trust ? (
              <ConfirmDialog
                cancelLabel={String(t("actions.cancel"))}
                confirmLabel={String(t("pending.securityAlert.confirmConfirm"))}
                description={String(t("pending.securityAlert.confirmDescription"))}
                onConfirm={() => runOne(item, { kind: "pending_trust_security", label: String(t("pending.actions.trust")), perform: (target) => facade.trust!(target) })}
                title={String(t("pending.securityAlert.confirmTitle"))}
                trigger={<Button disabled={busy} loading={processingItemId === item.id} size="sm">{t("pending.actions.trust")}</Button>}
              />
            ) : null}
            {isSecurityAlert ? (
              <Link
                className="sh-button sh-button--secondary"
                state={{ removalRequest: { skillId: item.subject } }}
                to={`/library/${encodeURIComponent(item.subject)}`}
              >
                {t("pending.actions.distrustDelete")}
              </Link>
            ) : null}
            {trialAction ? <Button disabled={busy} loading={processingItemId === item.id} onClick={() => runOne(item, trialAction)} size="sm">{trialAction.label}</Button> : null}
            {canSnooze ? <>
              <Select aria-label={String(t("pending.defer.durationLabel"))} className="sh-pending-item__defer-days" disabled={busy} value={deferDays} onChange={(event) => changeDeferDays(Number(event.target.value) as 7 | 30)}>
                <option value="7">{t("pending.defer.days7")}</option>
                <option value="30">{t("pending.defer.days30")}</option>
              </Select>
              <Button disabled={busy} loading={processingItemId === item.id} onClick={() => runOne(item, { kind: "pending_defer", label: String(t("pending.actions.defer")), perform: (target) => facade.defer([target], deferDays, String(t("pending.actions.deferReason", { days: deferDays }))) })} size="sm" variant="secondary">{t("pending.actions.defer")}</Button>
              <ConfirmDialog
                cancelLabel={String(t("actions.cancel"))}
                confirmLabel={String(t("pending.ignoreConfirm.confirm"))}
                description={String(t("pending.ignoreConfirm.description"))}
                onConfirm={() => runOne(item, { kind: "pending_ignore", label: String(t("pending.actions.ignore")), perform: (target) => facade.ignore([target], String(t("pending.actions.ignoreReason"))) })}
                title={String(t("pending.ignoreConfirm.title"))}
                trigger={<Button disabled={busy} size="sm" variant="secondary">{t("pending.actions.ignore")}</Button>}
                variant="danger"
              />
            </> : null}
          </div>
        </li>;
      })}
    </ul> : null}
  </li>;
}

export function PendingPage({
  facade = unavailablePendingFacade,
  tracker = operationTracker,
  initialKind,
  initialSubjects = [],
}: { facade?: PendingFacade; tracker?: OperationTracker; initialKind?: PendingKind; initialSubjects?: string[] }) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const routeParams = new URLSearchParams(location.search);
  const routeCategory = routeParams.get("category");
  const hasRouteView = Boolean(initialKind || routeParams.has("category") || routeParams.has("search"));
  const locale = resolveLocale([i18n.resolvedLanguage ?? i18n.language]);
  const notifications = useOptionalAppNotifications();
  // 历史 createdAt 是任意来源的即时时间字符串；非法值原样回显，不伪造格式化结果。
  const formatTimestamp = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : formatDateTime(date, locale);
  };
  const { items, error, unavailableSources, reload } = usePendingItems(facade, tracker);
  // T4-A：单条/批量处置失败只在列表区播报并保持列表可用，不再整页替换。
  const [actionError, setActionError] = useState<string>();
  const [category, setCategory] = useState<PendingCategory | "all">(initialKind ? pendingCategoryForKind(initialKind)
    : routeCategory === "all" || pendingCategories.includes(routeCategory as PendingCategory) ? routeCategory as PendingCategory | "all" : "all");
  const [specificKind, setSpecificKind] = useState<PendingKind | "all">(initialKind ?? "all");
  const [searchText, setSearchText] = useState(routeParams.get("search") ?? "");
  const [processingItemId, setProcessingItemId] = useState<string>();
  const [deferDays, setDeferDays] = useState<7 | 30>(7);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number }>();
  const [handled, setHandled] = useState<HandledEntry[]>();
  const [handledError, setHandledError] = useState<string>();
  const [undoingId, setUndoingId] = useState<string>();
  const [savedViewIssue, setSavedViewIssue] = useState<"load" | "save">();
  const kindChangedRef = useRef(false);
  // describeNativeError 以动态键调用翻译；i18next 的强类型键联合在此收窄。
  const describe = (reason: unknown) =>
    describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "pending.errors.generic");
  // 桥的 translate/describeError 复用页面同一份描述：通知详情与页面局部提示逐字同源。
  const translate = (key: string, options?: Record<string, unknown>) => String(t(key as never, options as never));
  const deferReason = (days: number) => t("pending.actions.deferReason", { days });
  const ignoreReason = () => t("pending.actions.ignoreReason");
  const reloadHandled = () => void facade.listHandled()
    .then((entries) => setHandled(entries))
    .catch((reason: unknown) => setHandledError(describe(reason)));
  useEffect(reloadHandled, [facade]);
  useEffect(() => {
    if (hasRouteView) return;
    let cancelled = false;
    facade.loadSavedView()
      .then((saved) => {
        if (cancelled || !saved || kindChangedRef.current) return;
        if (saved === "all" || pendingCategories.includes(saved as PendingCategory)) setCategory(saved as PendingCategory | "all");
        else {
          const legacyKind = pendingKinds.find((candidate) => candidate === saved);
          if (legacyKind) setCategory(pendingCategoryForKind(legacyKind));
        }
      })
      .catch(() => {
        if (!cancelled) setSavedViewIssue("load");
      });
    return () => { cancelled = true; };
  }, [facade, hasRouteView]);
  if (error && !items) return <><DataState message={describe(error)} state="unavailable" /><Button onClick={reload}>{t("pending.actions.refresh")}</Button></>;
  if (!items) return <DataState message={t("pending.loading")} state="loading" />;
  const scopedItems = initialSubjects.length ? items.filter((item) => initialSubjects.includes(item.subject)) : items;
  const kindScopedItems = specificKind === "all" ? scopedItems : scopedItems.filter((item) => item.kind === specificKind);
  const projectedGroups = groupPendingItems(kindScopedItems);
  const matchesSearch = (group: PendingGroup) => {
    const needle = searchText.trim().toLocaleLowerCase(locale);
    if (!needle) return true;
    const text = [
      group.displayName,
      ...group.agentBrands,
      ...group.items.flatMap((item) => [
        item.displayName,
        item.path ? displayPath(item.path) : undefined,
        String(t(item.message as never, { defaultValue: String(t(`pending.kinds.${item.kind}` as never)) } as never)),
        String(t(`pending.kinds.${item.kind}` as never)),
      ]),
    ].filter(Boolean).join(" ").toLocaleLowerCase(locale);
    return text.includes(needle);
  };
  const visibleGroups = projectedGroups.filter((group) => (category === "all" || group.category === category) && matchesSearch(group));
  const visibleSelectableIds = [...new Set(visibleGroups.flatMap((group) => group.selectableIds))];
  const busy = Boolean(processingItemId) || Boolean(batchProgress);
  const selectedCount = items.filter((item) => canSnoozePendingItem(item) && selectedIds.includes(item.id)).length;
  const allVisibleSelected = visibleSelectableIds.length > 0 && visibleSelectableIds.every((id) => selectedIds.includes(id));
  const changeCategory = (next: PendingCategory | "all") => {
    kindChangedRef.current = true;
    setCategory(next);
    setSpecificKind("all");
    facade.saveSavedView(next).catch(() => setSavedViewIssue("save"));
  };
  const changeSpecificKind = (next: PendingKind | "all") => {
    setSpecificKind(next);
    if (next !== "all") {
      const nextCategory = pendingCategoryForKind(next);
      setCategory(nextCategory);
      kindChangedRef.current = true;
      facade.saveSavedView(nextCategory).catch(() => setSavedViewIssue("save"));
    }
  };
  const toggleItem = (id: string) => setSelectedIds((current) => current.includes(id)
    ? current.filter((value) => value !== id)
    : [...current, id]);
  const toggleGroup = (group: PendingGroup) => setSelectedIds((current) => {
    const ids = group.selectableIds;
    return ids.every((id) => current.includes(id))
      ? current.filter((id) => !ids.includes(id))
      : [...new Set([...current, ...ids])];
  });
  const toggleAll = () => setSelectedIds((current) => allVisibleSelected
    ? current.filter((id) => !visibleSelectableIds.includes(id))
    : [...new Set([...current, ...visibleSelectableIds])]);
  // 统一执行桥（任务 4）：单条处置是单次同步写入，走 instant——不占在途顶栏，
  // 但成功/失败都留下通知；失败描述与页面局部提示同源。
  const runOne = (item: PendingItem, action: { kind: string; label: string; perform: (target: PendingItem) => Promise<void> }) => {
    if (busy) return;
    setActionError(undefined);
    setProcessingItemId(item.id);
    void runTrackedOperation({
      kind: action.kind,
      label: action.label,
      mode: "instant",
      tracker,
      notifications,
      translate,
      describeError: describe,
      run: () => action.perform(item),
    }).then(
      () => { reloadHandled(); },
      (reason: unknown) => setActionError(describe(reason)),
    ).finally(() => setProcessingItemId(undefined));
  };
  // 批量暂缓/忽略进 phased 在途投影：逐项推进进度，顶栏可见；首错即停，
  // 已完成项经刷新反映到列表（部分成功保留成功项），失败描述三端同源。
  const runBatch = (action: "defer" | "ignore") => {
    if (busy || !items.length) return;
    const selected = items.filter((item) => canSnoozePendingItem(item) && selectedIds.includes(item.id));
    if (!selected.length) return;
    setActionError(undefined);
    setBatchProgress({ completed: 0, total: selected.length });
    const label = action === "defer" ? t("pending.batch.defer7") : t("pending.batch.ignore");
    void runTrackedOperation<number>({
      kind: action === "defer" ? "pending_defer" : "pending_ignore",
      label,
      total: selected.length,
      tracker,
      notifications,
      translate,
      describeError: describe,
      summarize: (completed) => ({ succeeded: completed, failed: 0, skipped: 0 }),
      successNotice: (_completed, summary) => ({
        tone: "success",
        title: label,
        detail: t("pending.notices.batchDone", { count: summary?.succeeded ?? selected.length }),
      }),
      run: async (handle) => {
        let completed = 0;
        for (const item of selected) {
          if (action === "defer") await facade.defer([item], BATCH_DEFER_DAYS, deferReason(BATCH_DEFER_DAYS));
          else await facade.ignore([item], ignoreReason());
          setSelectedIds((current) => current.filter((id) => id !== item.id));
          completed += 1;
          setBatchProgress({ completed, total: selected.length });
          handle.progress(completed, selected.length);
        }
        return completed;
      },
    }).then(
      () => {
        reloadHandled();
      },
      (reason: unknown) => {
        setActionError(describe(reason));
        reloadHandled();
        reload();
      },
    ).finally(() => setBatchProgress(undefined));
  };
  const undo = (entry: HandledEntry) => {
    if (undoingId) return;
    setUndoingId(entry.id);
    void runTrackedOperation({
      kind: "pending_unignore",
      label: t("pending.history.undo"),
      mode: "instant",
      tracker,
      notifications,
      translate,
      describeError: describe,
      run: () => facade.unignore(entry.id),
    }).then(
      () => { reloadHandled(); },
      (reason: unknown) => setHandledError(describe(reason)),
    ).finally(() => setUndoingId(undefined));
  };
  return <PageFrame width="wide"><div className="sh-workflow-page sh-pending">
    <PageHeader description={t("pending.description")} headingLevel="h1" title={t("pending.heading")}
      actions={<Button onClick={reload} size="sm" variant="secondary">{t("pending.actions.refresh")}</Button>} />
    <section aria-labelledby="pending-list-heading" className="sh-workflow-card sh-pending__card">
      <h2 id="pending-list-heading">{t("pending.listHeading")}</h2>
      <p className="sh-pending__counts">
        {t("pending.totalCount", { count: items.length })} · {t("pending.count", { count: actionableCount(items) })} · {t("pending.recommendedCount", { count: items.filter((item) => item.recommended).length })}
      </p>
      {error || unavailableSources.length ? <p role="alert">{t("pending.partial")}</p> : null}
      {initialSubjects.length ? <p>{scopedItems.length ? t("pending.relatedScope") : t("pending.linkResolved")} <Link to="/pending">{t("pending.showAll")}</Link></p> : null}
      {items.length ? <>
        <div className="sh-pending__toolbar">
          <div aria-label={String(t("pending.categories.all"))} className="sh-pending__categories" role="group">
            <Button aria-pressed={category === "all"} onClick={() => changeCategory("all")} size="sm" variant={category === "all" ? "primary" : "secondary"}>
              {t("pending.categories.all")} <span>{scopedItems.length}</span>
            </Button>
            {pendingCategories.map((value) => <Button
              aria-pressed={category === value}
              key={value}
              onClick={() => changeCategory(value)}
              size="sm"
              variant={category === value ? "primary" : "secondary"}
            >
              {t(`pending.categories.${value}` as never)} <span>{projectedGroups.filter((group) => group.category === value).reduce((count, group) => count + group.count, 0)}</span>
            </Button>)}
          </div>
          <Field label={t("pending.search.label")}>
            <Input onChange={(event) => setSearchText(event.target.value)} placeholder={String(t("pending.search.placeholder"))} type="search" value={searchText} />
          </Field>
          <Field label={t("pending.filters.kind")}>
            <Select onChange={(event) => changeSpecificKind(event.target.value as PendingKind | "all")} value={specificKind}>
              <option value="all">{t("pending.filters.all")}</option>
              {pendingKinds.filter((value) => category === "all" || pendingCategoryForKind(value) === category).map((value) => <option key={value} value={value}>{t(`pending.kinds.${value}` as never)}</option>)}
            </Select>
          </Field>
          {savedViewIssue ? <p role="status">{savedViewIssue === "load" ? t("pending.savedView.loadFailed") : t("pending.savedView.saveFailed")}</p> : null}
        </div>
        {actionError ? <p className="sh-pending__action-error" role="alert">{actionError}</p> : null}
        <div aria-label={String(t("pending.batch.label"))} className="sh-pending-batch sh-pending-batch--anchored" role="group">
          <label className="sh-pending-batch__select-all">
            <input aria-label={String(t("pending.batch.selectAll"))} checked={allVisibleSelected} disabled={busy || visibleSelectableIds.length === 0} onChange={toggleAll} type="checkbox" />
            {t("pending.batch.selectAll")}
          </label>
          {selectedCount > 0 ? <span className="sh-pending-batch__count">{t("pending.batch.selectedCount", { count: selectedCount })}</span> : null}
          <Button disabled={busy || !selectedCount} loading={Boolean(batchProgress)} onClick={() => runBatch("defer")} size="sm">{t("pending.batch.defer7")}</Button>
          <ConfirmDialog
            cancelLabel={String(t("actions.cancel"))}
            confirmLabel={String(t("pending.batch.ignoreConfirmConfirm"))}
            description={String(t("pending.batch.ignoreConfirmDescription", { count: selectedCount }))}
            onConfirm={() => runBatch("ignore")}
            title={String(t("pending.batch.ignoreConfirmTitle"))}
            trigger={<Button disabled={busy || !selectedCount} size="sm" variant="secondary">{t("pending.batch.ignore")}</Button>}
            variant="danger"
          />
          {batchProgress ? <span role="status">{t("pending.batch.progress", batchProgress)}</span> : null}
          {/* 历史入口钉顶常驻，与批量结果/撤销同域；置于满宽说明之前以停留在操作行行尾。 */}
          <a className="sh-pending__history-link" href="#pending-history-heading">{t("pending.history.heading")} {handled ? `(${handled.length})` : ""}</a>
          <small className="sh-pending-batch__note">{t("pending.batch.noBatchContract")}</small>
        </div>
        {visibleGroups.length ? <div className="sh-pending__sections">
          {(category === "all" ? pendingCategories : [category]).map((sectionCategory) => {
            const sectionGroups = visibleGroups.filter((group) => group.category === sectionCategory);
            if (!sectionGroups.length) return null;
            const sectionItems = sectionGroups.flatMap((group) => group.items);
            const objectCount = new Set(sectionItems.map((item) => item.subject)).size;
            const securitySkillIds = sectionCategory === "skill_review" ? pendingReviewSkillIds(sectionItems, "security_check") : [];
            const sourceSkillIds = sectionCategory === "skill_review" ? pendingReviewSkillIds(sectionItems, "source_update") : [];
            const returnTo = pendingReturnHref(location.search, category, searchText, specificKind);
            const reviewLink = (intent: PendingReviewIntent, skillIds: string[], label: string) => skillIds.length ? <Link
              className="sh-button sh-button--secondary sh-button--sm"
              key={intent}
              state={{ pendingReview: { skillIds, intent, returnTo } }}
              to="/library"
            >{label} ({skillIds.length})</Link> : null;
            return <section aria-labelledby={`pending-section-${sectionCategory}`} className="sh-pending__section" key={sectionCategory}>
              <div className="sh-pending__section-heading">
                <div>
                  <h3 id={`pending-section-${sectionCategory}`}>{t(`pending.categories.${sectionCategory}` as never)}</h3>
                  <p>{t("pending.totalCount", { count: sectionItems.length })} · {t("pending.group.objects", { count: objectCount })}</p>
                </div>
                {sectionCategory === "skill_review" ? <div className="sh-pending__section-actions">
                  {reviewLink("security_check", securitySkillIds, String(t("pending.group.reviewBatch")))}
                  {reviewLink("source_update", sourceSkillIds, String(t("pending.group.sourceBatch")))}
                  {sectionItems.some((item) => item.risk === "high") ? <small>{t("pending.group.highRiskIndividual")}</small> : null}
                </div> : null}
              </div>
              <ul className="sh-pending__list">
                {sectionGroups.map((group) => <PendingGroupRow
                  changeDeferDays={setDeferDays}
                  deferDays={deferDays}
                  facade={facade}
                  group={group}
                  key={group.key}
                  busy={busy}
                  processingItemId={processingItemId}
                  runOne={runOne}
                  selectedIds={selectedIds}
                  toggleGroup={toggleGroup}
                  toggleItem={toggleItem}
                />)}
              </ul>
            </section>;
          })}
        </div> : <p role="status">{searchText ? t("pending.group.emptySearch") : t("pending.filteredEmpty")}</p>}
      </> : !error && !unavailableSources.length ? <DataState message={t("pending.empty")} state="empty" /> : null}
    </section>
    <section aria-labelledby="pending-history-heading" className="sh-workflow-card sh-pending__card">
      <h2 id="pending-history-heading">{t("pending.history.heading")}</h2>
      {handledError ? <p role="alert">{handledError}</p> : null}
      {!handled ? <DataState message={t("pending.loading")} state="loading" /> : handled.length ? <ul className="sh-workflow-list">
        {handled.map((entry) => <li className="sh-workflow-list__item" key={entry.id}>
          <div className="sh-pending-item__info">
            <strong>{entry.displayName || t("pending.history.entry")}</strong>
            <p>{entry.reason}</p>
            {entry.confirmed ? <small>{t("pending.confirmReason")} · {formatTimestamp(entry.createdAt)}</small> : <small>{`${t("pending.history.createdAt")}：${formatTimestamp(entry.createdAt)} · ${t("pending.history.deferUntil")}：${entry.deferUntil ?? t("pending.history.permanent")}`}</small>}
          </div>
          <div className="sh-workflow-actions">
            {!entry.confirmed ? <Button disabled={Boolean(undoingId)} loading={undoingId === entry.id} onClick={() => void undo(entry)} size="sm" variant="secondary">{t("pending.history.undo")}</Button> : null}
          </div>
        </li>)}
      </ul> : <p role="status">{t("pending.history.empty")}</p>}
    </section>
  </div></PageFrame>;
}
