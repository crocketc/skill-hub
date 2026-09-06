import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DataState } from "../../ui/DataState";
import { type HandledEntry, type PendingFacade, type PendingItem, type PendingKind, unavailablePendingFacade } from "./api";

/** 批量暂缓固定 7 天：批量契约只覆盖安全的暂缓/忽略，不覆盖转换/重查/恢复。 */
const BATCH_DEFER_DAYS = 7;

export function PendingPage({ facade = unavailablePendingFacade }: { facade?: PendingFacade }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<PendingItem[]>();
  const [error, setError] = useState<string>();
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
    setProcessingItemId(item.id);
    try {
      await perform(item);
      reload();
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setProcessingItemId(undefined);
    }
  };
  const runBatch = async (action: "defer" | "ignore") => {
    if (busy || !items.length) return;
    const selected = items.filter((item) => selectedIds.includes(item.id));
    if (!selected.length) return;
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
      setError(describe(reason));
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
  return <main className="sh-page sh-workflow-page">
    <header className="sh-page__header">
      <div>
        <p className="sh-eyebrow">{t("pending.eyebrow")}</p>
        <h1>{t("pending.heading")}</h1>
        <p>{t("pending.description")}</p>
      </div>
    </header>
    <section className="sh-workflow-card" aria-labelledby="pending-list-heading">
      <h2 id="pending-list-heading">{t("pending.listHeading")}</h2>
      {items.length ? <>
        <label>
          {t("pending.filters.kind")}
          <select onChange={(event) => changeKind(event.target.value as PendingKind | "all")} value={kind}>
            <option value="all">{t("pending.filters.all")}</option>
            <option value="trial_due">{t("pending.kinds.trial_due")}</option>
            <option value="security_finding">{t("pending.kinds.security_finding")}</option>
            <option value="recovery">{t("pending.kinds.recovery")}</option>
          </select>
        </label>
        {savedViewIssue ? <p role="status">{savedViewIssue === "load" ? t("pending.savedView.loadFailed") : t("pending.savedView.saveFailed")}</p> : null}
        <div aria-label={t("pending.batch.label")} className="sh-pending-batch" role="group">
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
        {visibleItems.length ? <ul className="sh-workflow-list">
          {visibleItems.map((item) => <li className="sh-workflow-list__item" key={item.id}>
            <input
              aria-label={t("pending.batch.selectItem", { subject: item.subject })}
              checked={selectedIds.includes(item.id)}
              disabled={busy}
              onChange={() => toggleItem(item.id)}
              type="checkbox"
            />
            <div className="sh-pending-item__info">
              <strong>{item.subject}</strong>
              <p>{t(item.message, { defaultValue: item.code })}</p>
              {item.kind === "trial_due" && item.dueDate ? <small>{t("pending.dueDate", { date: item.dueDate })}</small> : null}
              {item.risk ? <span className={`sh-pending-item__risk sh-pending-item__risk--${item.risk}`}>{t(`pending.risk.${item.risk}` as never)}</span> : null}
              {typeof item.affectedDeployments === "number" ? <small>{t("pending.impact", { count: item.affectedDeployments })}</small> : null}
            </div>
            <div className="sh-workflow-actions">
              <select
                aria-label={t("pending.defer.durationLabel")}
                disabled={busy}
                onChange={(event) => setDeferDays(Number(event.target.value) as 7 | 30)}
                value={deferDays}
              >
                <option value="7">{t("pending.defer.days7")}</option>
                <option value="30">{t("pending.defer.days30")}</option>
              </select>
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
              {item.kind === "recovery" ? <Button disabled={busy} loading={processingItemId === item.id} onClick={() => void runOne(item, (target) => facade.recover(target))} size="sm">{t("pending.actions.recover")}</Button> : null}
              {item.kind === "security_finding" ? <Button disabled={busy} loading={processingItemId === item.id} onClick={() => void runOne(item, (target) => facade.recheck(target))} size="sm" variant="secondary">{t("pending.actions.recheck")}</Button> : null}
              {item.kind === "trial_due" ? <Button disabled={busy} loading={processingItemId === item.id} onClick={() => void runOne(item, (target) => facade.convert(target))} size="sm" variant="secondary">{t("pending.actions.convert")}</Button> : null}
            </div>
          </li>)}
        </ul> : <p role="status">{t("pending.filteredEmpty")}</p>}
      </> : <DataState message={t("pending.empty")} state="empty" />}
    </section>
    <section className="sh-workflow-card" aria-labelledby="pending-history-heading">
      <h2 id="pending-history-heading">{t("pending.history.heading")}</h2>
      {handledError ? <p role="alert">{handledError}</p> : null}
      {!handled ? <DataState message={t("pending.loading")} state="loading" /> : handled.length ? <ul className="sh-workflow-list">
        {handled.map((entry) => <li className="sh-workflow-list__item" key={entry.id}>
          <div className="sh-pending-item__info">
            <strong>{entry.pendingId}</strong>
            <p>{entry.reason}</p>
            <small>{`${t("pending.history.createdAt")}：${entry.createdAt} · ${t("pending.history.deferUntil")}：${entry.deferUntil ?? t("pending.history.permanent")}`}</small>
          </div>
          <div className="sh-workflow-actions">
            <Button disabled={Boolean(undoingId)} loading={undoingId === entry.id} onClick={() => void undo(entry)} size="sm" variant="secondary">{t("pending.history.undo")}</Button>
          </div>
        </li>)}
      </ul> : <p role="status">{t("pending.history.empty")}</p>}
    </section>
  </main>;
}
