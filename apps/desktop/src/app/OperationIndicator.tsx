import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  useTrackedOperations,
  type OperationTracker,
  type TrackedOperation,
} from "../platform/operationTracker";

/**
 * 已完成/已取消行自动消失的等待时间；失败行不自动消失，只能手动关闭
 * （AR-023：指示器不能永久占据页面底部，但失败原因必须用户显式确认）。
 */
const AUTO_DISMISS_MS = 10_000;

/**
 * 全局操作指示器（验收反馈 #12）：挂在应用壳上，跨路由显示后台长时操作
 * （当前为导入提交）的进度与结果。只读展示；真正的操作记录列表见 /operations。
 */
export function OperationIndicator({ tracker }: { tracker?: OperationTracker }) {
  const { t } = useTranslation();
  const operations = useTrackedOperations(tracker);
  // 关闭只影响指示器的显示（本地集合），不改写 tracker 里的操作记录。
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(new Set());

  const dismiss = useCallback((id: string) => {
    setDismissedIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);

  const visible = operations
    .filter((operation) => !dismissedIds.has(operation.id))
    .slice(0, 3);

  if (visible.length === 0) {
    return null;
  }

  return (
    <aside aria-label={t("operations.tracker.ariaLabel")} className="sh-operation-indicator">
      {visible.map((operation) => (
        <IndicatorRow
          dismiss={dismiss}
          key={operation.id}
          operation={operation}
        />
      ))}
    </aside>
  );
}

function IndicatorRow({
  dismiss,
  operation,
}: {
  dismiss: (id: string) => void;
  operation: TrackedOperation;
}) {
  const { t } = useTranslation();
  const autoDismiss = operation.status === "completed" || operation.status === "cancelled";

  useEffect(() => {
    if (!autoDismiss) return;
    const timer = setTimeout(() => dismiss(operation.id), AUTO_DISMISS_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [autoDismiss, dismiss, operation.id]);

  let content: string;
  let role: "status" | "alert" | undefined;
  if (operation.status === "running") {
    role = "status";
    content = t("operations.tracker.running", {
      label: operation.label,
      completed: operation.completed,
      total: operation.total,
    });
  } else if (operation.status === "failed") {
    role = "alert";
    content = t("operations.tracker.failed", { label: operation.label, error: operation.error ?? "" });
  } else if (operation.status === "cancelled") {
    content = t("operations.tracker.cancelled", { label: operation.label });
  } else {
    role = "status";
    const summary = operation.resultSummary;
    content = summary
      ? t("operations.tracker.completed", {
          label: operation.label,
          succeeded: summary.succeeded,
          failed: summary.failed,
          skipped: summary.skipped,
        })
      : t("operations.tracker.completedPlain", { label: operation.label });
  }

  return (
    <p className="sh-operation-indicator__row" role={role}>
      <span>{content}</span>
      {operation.status === "completed" ? (
        <>
          {" "}
          <Link to="/operations">{t("operations.tracker.viewOperations")}</Link>
        </>
      ) : null}
      {operation.status !== "running" ? (
        <button
          aria-label={t("actions.close")}
          className="sh-operation-indicator__close"
          onClick={() => dismiss(operation.id)}
          type="button"
        >
          ×
        </button>
      ) : null}
    </p>
  );
}
