import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { formatDateTime, resolveLocale } from "../../i18n";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DataState } from "../../ui/DataState";
import { Field } from "../../ui/Field";
import { Icon, type IconName } from "../../ui/Icon";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { Select } from "../../ui/Select";
import { type HandledEntry, type PendingFacade, type PendingItem, type PendingKind, type PendingRisk, unavailablePendingFacade } from "./api";
import "./pending.css";

/** 批量暂缓固定 7 天：批量契约只覆盖安全的暂缓/忽略，不覆盖转换/重查/恢复。 */
const BATCH_DEFER_DAYS = 7;

/** 风险档位 → 全站统一图标映射（4.2：状态始终图标＋文字）。 */
const RISK_ICONS: Record<PendingRisk, IconName> = {
  high: "failure",
  medium: "warning",
  low: "info",
};

export function PendingPage({ facade = unavailablePendingFacade }: { facade?: PendingFacade }) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale([i18n.resolvedLanguage ?? i18n.language]);
  // 历史 createdAt 是任意来源的即时时间字符串；非法值原样回显，不伪造格式化结果。
  const formatTimestamp = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : formatDateTime(date, locale);
  };
  const [items, setItems] = useState<PendingItem[]>();
  const [error, setError] = useState<string>();
  // T4-A：单条/批量处置失败只在列表区播报并保持列表可用，不再整页替换。
  const [actionError, setActionError] = useState<string>();
  const [kind, setKind] = useState<PendingKind | "all">("all");
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
  const deferReason = (days: number) => t("pending.actions.deferReason", { days });
  const ignoreReason = () => t("pending.actions.ignoreReason");
  const reload = () => void facade.list().then(setItems).catch((reason: unknown) => setError(describe(reason)));
  const reloadHandled = () => void facade.listHandled()
    .then((entries) => setHandled(entries))
    .catch((reason: unknown) => setHandledError(describe(reason)));
  useEffect(reload, [facade]);
  useEffect(reloadHandled, [facade]);
  useEffect(() => {
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
  }, [facade]);
  if (error) return <DataState message={error} state="unavailable" />;
  if (!items) return <DataState message={t("pending.loading")} state="loading" />;
  const visibleItems = kind === "all" ? items : items.filter((item) => item.kind === kind);
  const busy = Boolean(processingItemId) || Boolean(batchProgress);
  const selectedCount = items.filter((item) => selectedIds.includes(item.id)).length;
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((item) => selectedIds.includes(item.id));
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
    : [...new Set([...selectedIds, ...visibleItems.map((item) => item.id)])]);
  const runOne = async (item: PendingItem, perform: (target: PendingItem) => Promise<void>) => {
    if (busy) return;
    setActionError(undefined);
    setProcessingItemId(item.id);
    try {
      await perform(item);
      reload();
    } catch (reason) {
      setActionError(describe(reason));
    } finally {
      setProcessingItemId(undefined);
    }
  };
  const runBatch = async (action: "defer" | "ignore") => {
    if (busy || !items.length) return;
    const selected = items.filter((item) => selectedIds.includes(item.id));
    if (!selected.length) return;
    setActionError(undefined);
    setBatchProgress({ completed: 0, total: selected.length });
    try {
      let completed = 0;
      for (const item of selected) {
        if (action === "defer") await facade.defer([item], BATCH_DEFER_DAYS, deferReason(BATCH_DEFER_DAYS));
        else await facade.ignore([item], ignoreReason());
        completed += 1;
        setBatchProgress({ completed, total: selected.length });
      }
      setSelectedIds([]);
      setBatchProgress(undefined);
      reload();
    } catch (reason) {
      setBatchProgress(undefined);
      setActionError(describe(reason));
    }
  };
  const undo = async (entry: HandledEntry) => {
    if (undoingId) return;
    setUndoingId(entry.id);
    try {
      await facade.unignore(entry.id);
      reloadHandled();
    } catch (reason) {
      setHandledError(describe(reason));
    } finally {
      setUndoingId(undefined);
    }
  };
  return <PageFrame width="wide"><div className="sh-workflow-page sh-pending">
    <PageHeader description={t("pending.description")} title={t("pending.heading")} />
    <section aria-labelledby="pending-list-heading" className="sh-workflow-card sh-pending__card">
      <h2 id="pending-list-heading">{t("pending.listHeading")}</h2>
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
              disabled={busy}
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
            // 每类事项的“建议操作”：试用到期→转为常规、安全发现→重新检查、恢复事项→确认恢复。
            const suggested = item.kind === "trial_due"
              ? { label: t("pending.actions.convert"), perform: (target: PendingItem) => facade.convert(target) }
              : item.kind === "security_finding"
                ? { label: t("pending.actions.recheck"), perform: (target: PendingItem) => facade.recheck(target) }
                : { label: t("pending.actions.recover"), perform: (target: PendingItem) => facade.recover(target) };
            return <li className="sh-pending-item" key={item.id}>
              <input
                aria-label={t("pending.batch.selectItem", { subject: item.subject })}
                checked={selectedIds.includes(item.id)}
                className="sh-pending-item__select"
                disabled={busy}
                onChange={() => toggleItem(item.id)}
                type="checkbox"
              />
              <div className="sh-pending-item__main">
                <div className="sh-pending-item__identity">
                  <strong className="sh-pending-item__subject">{item.subject}</strong>
                  {item.risk ? (
                    <span className={`sh-pending-item__risk sh-pending-item__risk--${item.risk}`}>
                      <Icon aria-hidden="true" name={RISK_ICONS[item.risk]} />
                      {t(`pending.risk.${item.risk}` as never)}
                    </span>
                  ) : null}
                </div>
                <p className="sh-pending-item__message">{t(item.message, { defaultValue: item.code })}</p>
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
              <div aria-label={t("pending.item.actionsGroup", { subject: item.subject })} className="sh-pending-item__actions" role="group">
                <Button
                  disabled={busy}
                  loading={processingItemId === item.id}
                  onClick={() => void runOne(item, suggested.perform)}
                  size="sm"
                >
                  {suggested.label}
                </Button>
                <Select
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
                  onClick={() => void runOne(item, (target) => facade.defer([target], deferDays, deferReason(deferDays)))}
                  size="sm"
                  variant="secondary"
                >
                  {t("pending.actions.defer")}
                </Button>
                <ConfirmDialog
                  cancelLabel={t("actions.cancel")}
                  confirmLabel={t("pending.ignoreConfirm.confirm")}
                  description={t("pending.ignoreConfirm.description")}
                  onConfirm={() => void runOne(item, (target) => facade.ignore([target], ignoreReason()))}
                  title={t("pending.ignoreConfirm.title")}
                  trigger={<Button disabled={busy} size="sm" variant="secondary">{t("pending.actions.ignore")}</Button>}
                  variant="danger"
                />
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
            <strong>{entry.pendingId}</strong>
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
