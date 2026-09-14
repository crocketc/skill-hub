import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getBackgroundScanState, subscribeBackgroundScan } from "../features/bootstrap/backgroundScan";
import { useTrackedOperations } from "../platform/operationTracker";
import { Drawer } from "../ui/Drawer";
import { Icon } from "../ui/Icon";

const TERMINAL_DISPLAY_MS = 2_000;

export function TaskStatusIndicator() {
  const { t } = useTranslation();
  const state = useSyncExternalStore(subscribeBackgroundScan, getBackgroundScanState);
  const trackedOperations = useTrackedOperations();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hiddenToken, setHiddenToken] = useState<number | null>(null);

  useEffect(() => {
    if (state.status === "scanning") {
      setHiddenToken(null);
      return;
    }
    if (state.status !== "completed" && state.status !== "failed") return;
    const timer = window.setTimeout(() => setHiddenToken(state.token), TERMINAL_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [state.status, state.token]);

  const trackedOperation = state.status === "idle"
    ? trackedOperations.find((operation) => operation.status === "running")
    : null;
  if (state.status === "idle" && !trackedOperation) return null;
  if (state.status !== "idle" && hiddenToken === state.token) return null;

  const running = state.status === "scanning" || trackedOperation?.status === "running";
  const failed = state.status === "failed" || trackedOperation?.status === "failed";
  const label = trackedOperation?.label ?? t("operations.taskStatus.initializationScan");
  const statusLabel = running
    ? state.status === "scanning" ? t("operations.taskStatus.scanning") : label
    : failed
      ? t("operations.taskStatus.failed")
      : t("operations.taskStatus.completed");
  const statusDescription = running
    ? state.status === "scanning"
      ? t("operations.taskStatus.scanningDescription")
      : t("operations.tracker.running", {
          label,
          completed: trackedOperation?.completed ?? 0,
          total: trackedOperation?.total ?? 0,
        })
    : failed
      ? t("operations.taskStatus.failedDescription")
      : t("operations.taskStatus.completedDescription");
  const elapsedSeconds = state.startedAt
    ? Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000))
    : trackedOperation
      ? Math.max(0, Math.floor((Date.now() - trackedOperation.startedAt) / 1000))
      : 0;
  const hasKnownTotal = Boolean(trackedOperation && trackedOperation.total > 0);

  return (
    <>
      <button
        aria-label={statusDescription}
        className={`sh-task-status${failed ? " is-failed" : ""}`}
        onClick={() => setDrawerOpen(true)}
        ref={triggerRef}
        title={statusDescription}
        type="button"
      >
        <span aria-label={statusDescription} aria-live="polite" role="status">
          {running ? <span aria-hidden="true" className="sh-task-status__spinner" /> : <Icon name={failed ? "failure" : "success"} size={16} />}
          <span className="sh-task-status__label">{statusLabel}</span>
        </span>
      </button>
      <Drawer
        onOpenChange={setDrawerOpen}
        open={drawerOpen}
        returnFocusRef={triggerRef}
        title={t("operations.taskStatus.detailsTitle")}
      >
        <div className="sh-task-status__details">
          <p className="sh-task-status__details-name">{label}</p>
          <p>{statusDescription}</p>
          {running ? (
            <>
              <p>{t("operations.taskStatus.elapsed", { seconds: elapsedSeconds })}</p>
              <progress
                aria-label={t("onboarding.scanProgressTitle")}
                max={hasKnownTotal ? trackedOperation!.total : undefined}
                value={hasKnownTotal ? trackedOperation!.completed : undefined}
              />
              <p>
                {hasKnownTotal
                  ? t("operations.tracker.running", {
                      label,
                      completed: trackedOperation!.completed,
                      total: trackedOperation!.total,
                    })
                  : t("onboarding.scanProgressUnavailable")}
              </p>
            </>
          ) : null}
          {failed && state.error instanceof Error ? <p>{state.error.message}</p> : null}
        </div>
      </Drawer>
    </>
  );
}
