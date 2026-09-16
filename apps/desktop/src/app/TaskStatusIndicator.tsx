import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { getBackgroundScanState, subscribeBackgroundScan } from "../features/bootstrap/backgroundScan";
import {
  inFlightOperations,
  operationTracker,
  useTrackedOperations,
  type OperationTracker,
  type TrackedOperation,
} from "../platform/operationTracker";
import { Icon } from "../ui/Icon";

/**
 * 顶栏统一任务状态摘要（任务 4）：固定 360px、居中、无按钮感的在途摘要 +
 * 小浮层（一项一页），取代旧的全屏 Drawer 与底部 OperationIndicator 双状态竞争。
 * 只渲染在途（queued/running/needs_user）任务；终态结果由通知中心与
 * /operations 记录页承接——顶栏是在途投影，不是持久化来源。
 */
export function TaskStatusIndicator({ tracker = operationTracker }: { tracker?: OperationTracker } = {}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(subscribeBackgroundScan, getBackgroundScanState);
  const trackedOperations = useTrackedOperations(tracker);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);

  // 初始化扫描并入同一在途投影：scanning 才是在途；完成/失败交由通知承接。
  const scanInFlight = state.status === "scanning";
  const items: TrackedOperation[] = inFlightOperations(trackedOperations);
  if (scanInFlight) {
    items.unshift({
      canCancel: false,
      cancelRequested: false,
      completed: 0,
      error: null,
      finishedAt: null,
      hasKnownTotal: false,
      id: "__background_scan__",
      kind: "initialization_scan",
      label: t("operations.taskStatus.initializationScan"),
      operationId: null,
      parentId: null,
      phase: null,
      resultSummary: null,
      startedAt: state.startedAt ?? Date.now(),
      status: "running",
      targetHref: null,
      total: 0,
    });
  }

  const count = items.length;

  useEffect(() => {
    // 在途集合收缩后页码越界时收敛到最后一页；没有在途时整体不渲染。
    setPageIndex((current) => (count === 0 ? 0 : Math.min(current, count - 1)));
  }, [count]);

  const close = useCallback((options: { returnFocus: boolean } = { returnFocus: true }) => {
    setOpen(false);
    // 键盘关闭（Escape）时焦点返回触发器；指针点击外部时焦点跟随用户点击，
    // 不抢回（避免把焦点从用户点击的目标上夺走）。
    if (options.returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        close({ returnFocus: false });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [close, open]);

  if (count === 0) return null;

  const safeIndex = Math.min(pageIndex, count - 1);
  const current = items[safeIndex];
  // 初始化扫描的标签本身就是状态描述（“初始化只读扫描”），不套运行中文案。
  const description = current.kind === "initialization_scan"
    ? current.label
    : describeOperation(current, (key, options) => String(t(key as never, options as never)));

  return (
    <div className="sh-task-summary" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          count > 1
            ? t("tasks.summary.triggerAriaMultiple", { count, description, index: safeIndex + 1 })
            : description
        }
        className="sh-task-summary__trigger"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <span aria-hidden="true" className="sh-task-summary__icon">
          {current.status === "running" || current.status === "queued" ? (
            <span className="sh-task-summary__spinner" />
          ) : (
            <Icon name="update" size={16} />
          )}
        </span>
        <span aria-hidden="true" className="sh-task-summary__label">{current.label}</span>
        {count > 1 ? (
          <span aria-hidden="true" className="sh-task-summary__counter">
            {safeIndex + 1}/{count}
          </span>
        ) : null}
      </button>
      {/* 状态变化对读屏的播报保持与旧指示器一致（polite live region）。 */}
      <span aria-label={description} className="sh-visually-hidden" role="status">{description}</span>
      {open ? (
        <div aria-label={t("tasks.popover.title")} className="sh-task-popover" role="dialog">
          <div className="sh-task-popover__list">
            <p className="sh-task-popover__name">{current.label}</p>
            <p>
              <span className={`sh-status sh-status--${current.status}`}>
                {t(`tasks.status.${current.status}` as never)}
              </span>
            </p>
            <p>
              {current.hasKnownTotal
                ? t("operations.tracker.running", {
                    completed: current.completed,
                    label: current.label,
                    total: current.total,
                  })
                : t("tasks.popover.progressUnknown")}
            </p>
            {current.phase ? <p>{current.phase}</p> : null}
            {current.targetHref ? (
              <Link className="sh-task-popover__record" to={current.targetHref}>
                {t("tasks.popover.viewRecord")}
              </Link>
            ) : null}
          </div>
          {count > 1 ? (
            <div className="sh-task-popover__paging">
              <button
                aria-label={t("tasks.popover.previous")}
                disabled={safeIndex === 0}
                onClick={() => setPageIndex(safeIndex - 1)}
                type="button"
              >
                <Icon aria-hidden="true" name="arrowLeft" size={16} />
              </button>
              <span aria-live="polite">
                {t("tasks.popover.position", { count, index: safeIndex + 1 })}
              </span>
              <button
                aria-label={t("tasks.popover.next")}
                disabled={safeIndex === count - 1}
                onClick={() => setPageIndex(safeIndex + 1)}
                type="button"
              >
                <Icon aria-hidden="true" name="arrowRight" size={16} />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function describeOperation(
  operation: TrackedOperation,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (operation.status) {
    case "queued":
      return t("tasks.statusDescription.queued", { label: operation.label });
    case "needs_user":
      return t("tasks.statusDescription.needsUser", { label: operation.label });
    default:
      return operation.hasKnownTotal
        ? t("operations.tracker.running", {
            completed: operation.completed,
            label: operation.label,
            total: operation.total,
          })
        : t("tasks.statusDescription.progressUnknown", { label: operation.label });
  }
}
