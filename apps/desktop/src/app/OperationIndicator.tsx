import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useTrackedOperations, type OperationTracker } from "../platform/operationTracker";

/**
 * 全局操作指示器（验收反馈 #12）：挂在应用壳上，跨路由显示后台长时操作
 * （当前为导入提交）的进度与结果。只读展示；真正的操作记录列表见 Q5。
 */
export function OperationIndicator({ tracker }: { tracker?: OperationTracker }) {
  const { t } = useTranslation();
  const operations = useTrackedOperations(tracker);
  const visible = operations.slice(0, 3);

  if (visible.length === 0) {
    return null;
  }

  return (
    <aside aria-label={t("operations.tracker.ariaLabel")} className="sh-operation-indicator">
      {visible.map((operation) => {
        if (operation.status === "running") {
          return (
            <p
              key={operation.id}
              className="sh-operation-indicator__row"
              role="status"
            >
              {t("operations.tracker.running", {
                label: operation.label,
                completed: operation.completed,
                total: operation.total,
              })}
            </p>
          );
        }
        if (operation.status === "failed") {
          return (
            <p key={operation.id} className="sh-operation-indicator__row" role="alert">
              {t("operations.tracker.failed", { label: operation.label, error: operation.error ?? "" })}
            </p>
          );
        }
        if (operation.status === "cancelled") {
          return (
            <p key={operation.id} className="sh-operation-indicator__row">
              {t("operations.tracker.cancelled", { label: operation.label })}
            </p>
          );
        }
        const summary = operation.resultSummary;
        return (
          <p key={operation.id} className="sh-operation-indicator__row" role="status">
            {summary
              ? t("operations.tracker.completed", {
                  label: operation.label,
                  succeeded: summary.succeeded,
                  failed: summary.failed,
                  skipped: summary.skipped,
                })
              : t("operations.tracker.completedPlain", { label: operation.label })}
            {" "}
            <Link to="/operations">{t("operations.tracker.viewOperations")}</Link>
          </p>
        );
      })}
    </aside>
  );
}
