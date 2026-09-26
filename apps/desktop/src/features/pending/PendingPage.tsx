import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
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
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { Select } from "../../ui/Select";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { type HandledEntry, type PendingFacade, type PendingItem, type PendingKind, type PendingRisk, unavailablePendingFacade } from "./api";
import "./pending.css";
import { usePendingItems } from "./usePendingItems";

/** 批量暂缓固定 7 天：批量契约只覆盖安全的暂缓/忽略，不覆盖转换/重查/恢复。 */
const BATCH_DEFER_DAYS = 7;

/** 风险档位 → 全站统一图标映射（4.2：状态始终图标＋文字）。 */
const RISK_ICONS: Record<PendingRisk, IconName> = {
  high: "failure",
  medium: "warning",
  low: "info",
};

export function PendingPage({
  facade = unavailablePendingFacade,
  tracker = operationTracker,
  initialKind,
}: { facade?: PendingFacade; tracker?: OperationTracker; initialKind?: PendingKind }) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale([i18n.resolvedLanguage ?? i18n.language]);
  const notifications = useOptionalAppNotifications();
  // 历史 createdAt 是任意来源的即时时间字符串；非法值原样回显，不伪造格式化结果。
  const formatTimestamp = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : formatDateTime(date, locale);
  };
  const { items, error, reload } = usePendingItems(facade, tracker);
  // T4-A：单条/批量处置失败只在列表区播报并保持列表可用，不再整页替换。
  const [actionError, setActionError] = useState<string>();
  const [kind, setKind] = useState<PendingKind | "all">(initialKind ?? "all");
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
    if (initialKind) return;
    let cancelled = false;
    facade.loadSavedView()
      .then((saved) => {
        if (cancelled || !saved || kindChangedRef.current) return;
        setKind(saved as PendingKind | "all");
      })
      .catch(() => {
        if (!cancelled) setSavedViewIssue("load");
      });
    return () => { cancelled = true; };
  }, [facade, initialKind]);
  if (error) return <><DataState message={describe(error)} state="unavailable" /><Button onClick={reload}>{t("pending.actions.refresh")}</Button></>;
  if (!items) return <DataState message={t("pending.loading")} state="loading" />;
  const visibleItems = kind === "all" ? items : items.filter((item) => item.kind === kind);
  const busy = Boolean(processingItemId) || Boolean(batchProgress);
  const selectable = visibleItems.filter((item) => item.canSnooze !== false && item.kind !== "recovery");
  const selectedCount = items.filter((item) => item.canSnooze !== false && item.kind !== "recovery" && selectedIds.includes(item.id)).length;
  const allVisibleSelected = selectable.length > 0 && selectable.every((item) => selectedIds.includes(item.id));
  const changeKind = (next: PendingKind | "all") => {
    kindChangedRef.current = true;
    setKind(next);
    facade.saveSavedView(next).catch(() => setSavedViewIssue("save"));
  };
  const toggleItem = (id: string) => setSelectedIds((current) => current.includes(id)
    ? current.filter((value) => value !== id)
    : [...current, id]);
  const toggleAll = () => setSelectedIds(allVisibleSelected
    ? []
    : [...new Set([...selectedIds, ...selectable.map((item) => item.id)])]);
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
      () => reload(),
      (reason: unknown) => setActionError(describe(reason)),
    ).finally(() => setProcessingItemId(undefined));
  };
  // 批量暂缓/忽略进 phased 在途投影：逐项推进进度，顶栏可见；首错即停，
  // 已完成项经刷新反映到列表（部分成功保留成功项），失败描述三端同源。
  const runBatch = (action: "defer" | "ignore") => {
    if (busy || !items.length) return;
    const selected = items.filter((item) => item.canSnooze !== false && item.kind !== "recovery" && selectedIds.includes(item.id));
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
          completed += 1;
          setBatchProgress({ completed, total: selected.length });
          handle.progress(completed, selected.length);
        }
        return completed;
      },
    }).then(
      () => {
        setSelectedIds([]);
        reload();
      },
      (reason: unknown) => {
        setActionError(describe(reason));
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
      () => { reloadHandled(); reload(); },
      (reason: unknown) => setHandledError(describe(reason)),
    ).finally(() => setUndoingId(undefined));
  };
  return <PageFrame width="wide"><div className="sh-workflow-page sh-pending">
    <PageHeader description={t("pending.description")} headingLevel="h1" title={t("pending.heading")}
      actions={<Button onClick={reload} size="sm" variant="secondary">{t("pending.actions.refresh")}</Button>} />
    <section aria-labelledby="pending-list-heading" className="sh-workflow-card sh-pending__card">
      <h2 id="pending-list-heading">{t("pending.listHeading")}</h2>
      <p>{t("pending.count", { count: items.length })}</p>
      {items.length ? <>
        <div className="sh-pending__toolbar">
          <Field label={t("pending.filters.kind")}>
            <Select
              onChange={(event) => changeKind(event.target.value as PendingKind | "all")}
              value={kind}
            >
              <option value="all">{t("pending.filters.all")}</option>
              <option value="trial_due">{t("pending.kinds.trial_due")}</option>
              <option value="security_finding">{t("pending.kinds.security_finding")}</option>
              <option value="recovery">{t("pending.kinds.recovery")}</option>
              <option value="conflict">{t("pending.kinds.conflict")}</option>
              <option value="governance">{t("pending.kinds.governance")}</option>
            </Select>
          </Field>
          {savedViewIssue ? <p role="status">{savedViewIssue === "load" ? t("pending.savedView.loadFailed") : t("pending.savedView.saveFailed")}</p> : null}
        </div>
        {actionError ? <p className="sh-pending__action-error" role="alert">{actionError}</p> : null}
        <div aria-label={t("pending.batch.label")} className="sh-pending-batch sh-pending-batch--anchored" role="group">
          <label className="sh-pending-batch__select-all">
            <input
              aria-label={t("pending.batch.selectAll")}
              checked={allVisibleSelected}
              disabled={busy || selectable.length === 0}
              onChange={toggleAll}
              type="checkbox"
            />
            {t("pending.batch.selectAll")}
          </label>
          {selectedCount > 0 ? <span className="sh-pending-batch__count">{t("pending.batch.selectedCount", { count: selectedCount })}</span> : null}
          <Button disabled={busy || !selectedCount} loading={Boolean(batchProgress)} onClick={() => void runBatch("defer")} size="sm">
            {t("pending.batch.defer7")}
          </Button>
          <ConfirmDialog
            cancelLabel={t("actions.cancel")}
            confirmLabel={t("pending.batch.ignoreConfirmConfirm")}
            description={t("pending.batch.ignoreConfirmDescription", { count: selectedCount })}
            onConfirm={() => void runBatch("ignore")}
            title={t("pending.batch.ignoreConfirmTitle")}
            trigger={<Button disabled={busy || !selectedCount} size="sm" variant="secondary">{t("pending.batch.ignore")}</Button>}
            variant="danger"
          />
          {batchProgress ? <span role="status">{t("pending.batch.progress", batchProgress)}</span> : null}
          <small className="sh-pending-batch__note">{t("pending.batch.noBatchContract")}</small>
        </div>
        {visibleItems.length ? <ul className="sh-pending__list">
          {visibleItems.map((item) => {
            const name = "displayName" in item ? item.displayName || t(`pending.kinds.${item.kind}`) : item.subject;
            const canSnooze = item.canSnooze !== false && item.kind !== "recovery";
            // 每类事项的“建议操作”：试用到期→转为常规、安全发现→重新检查、恢复事项→确认恢复。
            const suggested = item.kind === "trial_due"
              ? { kind: "pending_convert", label: t("pending.actions.convert"), perform: (target: PendingItem) => facade.convert(target) }
              : item.kind === "security_finding"
                ? { kind: "pending_recheck", label: t("pending.actions.recheck"), perform: (target: PendingItem) => facade.recheck(target) }
                : { kind: "pending_recover", label: t("pending.actions.recover"), perform: (target: PendingItem) => facade.recover(target) };
            return <li className="sh-pending-item" key={item.id}>
              <input
                aria-label={t("pending.batch.selectItem", { subject: name })}
                checked={selectedIds.includes(item.id)}
                className="sh-pending-item__select"
                disabled={busy || !canSnooze}
                onChange={() => toggleItem(item.id)}
                type="checkbox"
              />
              <div className="sh-pending-item__main">
                <div className="sh-pending-item__identity">
                  <strong className="sh-pending-item__subject">{name}</strong>
                  {item.risk ? (
                    <span className={`sh-pending-item__risk sh-pending-item__risk--${item.risk}`}>
                      <Icon aria-hidden="true" name={RISK_ICONS[item.risk]} />
                      {t(`pending.risk.${item.risk}` as never)}
                    </span>
                  ) : null}
                </div>
                <p className="sh-pending-item__message">{t(item.message, { defaultValue: item.code })}</p>
                <small>{t(`pending.kinds.${item.kind}`)}</small>
                {item.path ? <p className="sh-pending-item__path">{displayPath(item.path)}</p> : null}
                <div className="sh-pending-item__facts">
                  {item.kind === "trial_due" && item.dueDate ? (
                    <small className="sh-pending-item__fact">
                      <Icon aria-hidden="true" name="pending" />
                      {t("pending.dueDate", { date: item.dueDate })}
                    </small>
                  ) : null}
                  {typeof item.affectedDeployments === "number" ? (
                    <small className="sh-pending-item__fact">
                      <Icon aria-hidden="true" name="deploy" />
                      {t("pending.impact", { count: item.affectedDeployments })}
                    </small>
                  ) : null}
                </div>
              </div>
              <div aria-label={t("pending.item.actionsGroup", { subject: name })} className="sh-pending-item__actions" role="group">
                {item.href ? <Link className="sh-button sh-button--secondary" to={item.href}>{t("pending.actions.open")}</Link> : null}
                {canSnooze || !item.href ? <Button
                  disabled={busy}
                  loading={processingItemId === item.id}
                  onClick={() => void runOne(item, suggested)}
                  size="sm"
                >
                  {suggested.label}
                </Button> : null}
                {canSnooze ? <><Select
                  aria-label={t("pending.defer.durationLabel")}
                  className="sh-pending-item__defer-days"
                  disabled={busy}
                  onChange={(event) => setDeferDays(Number(event.target.value) as 7 | 30)}
                  value={deferDays}
                >
                  <option value="7">{t("pending.defer.days7")}</option>
                  <option value="30">{t("pending.defer.days30")}</option>
                </Select>
                <Button
                  disabled={busy}
                  loading={processingItemId === item.id}
                  onClick={() => void runOne(item, { kind: "pending_defer", label: t("pending.actions.defer"), perform: (target) => facade.defer([target], deferDays, deferReason(deferDays)) })}
                  size="sm"
                  variant="secondary"
                >
                  {t("pending.actions.defer")}
                </Button>
                <ConfirmDialog
                  cancelLabel={t("actions.cancel")}
                  confirmLabel={t("pending.ignoreConfirm.confirm")}
                  description={t("pending.ignoreConfirm.description")}
                  onConfirm={() => void runOne(item, { kind: "pending_ignore", label: t("pending.actions.ignore"), perform: (target) => facade.ignore([target], ignoreReason()) })}
                  title={t("pending.ignoreConfirm.title")}
                  trigger={<Button disabled={busy} size="sm" variant="secondary">{t("pending.actions.ignore")}</Button>}
                  variant="danger"
                />
                </> : <small>{t("pending.requiredAction")}</small>}
              </div>
            </li>;
          })}
        </ul> : <p role="status">{t("pending.filteredEmpty")}</p>}
      </> : <DataState message={t("pending.empty")} state="empty" />}
    </section>
    <section aria-labelledby="pending-history-heading" className="sh-workflow-card sh-pending__card">
      <h2 id="pending-history-heading">{t("pending.history.heading")}</h2>
      {handledError ? <p role="alert">{handledError}</p> : null}
      {!handled ? <DataState message={t("pending.loading")} state="loading" /> : handled.length ? <ul className="sh-workflow-list">
        {handled.map((entry) => <li className="sh-workflow-list__item" key={entry.id}>
          <div className="sh-pending-item__info">
            <strong>{entry.displayName || t("pending.history.entry")}</strong>
            <p>{entry.reason}</p>
            <small>{`${t("pending.history.createdAt")}：${formatTimestamp(entry.createdAt)} · ${t("pending.history.deferUntil")}：${entry.deferUntil ?? t("pending.history.permanent")}`}</small>
          </div>
          <div className="sh-workflow-actions">
            <Button disabled={Boolean(undoingId)} loading={undoingId === entry.id} onClick={() => void undo(entry)} size="sm" variant="secondary">{t("pending.history.undo")}</Button>
          </div>
        </li>)}
      </ul> : <p role="status">{t("pending.history.empty")}</p>}
    </section>
  </div></PageFrame>;
}
