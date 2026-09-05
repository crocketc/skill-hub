import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import { useTrackedOperations, type OperationTracker, type TrackedOperation } from "../../platform/operationTracker";
import { type RecentOperationRow, type RecentOperationsReader } from "./api";

export interface OperationsListProps {
  /** 持久化的最近操作（BootstrapSnapshot.recent_operations）。 */
  recent?: RecentOperationsReader;
  /** 本会话的后台操作（全局 tracker）。 */
  tracker?: OperationTracker;
}

/**
 * FE-14 操作记录列表：合并两类事实并诚实标注来源——
 * 1) 本会话后台操作（tracker，仅当前会话，含进度）；
 * 2) 持久化最近操作（原生快照，跨会话，链接到既有操作详情页）。
 * 没有数据时显示说明，不伪造历史。
 */
export function OperationsList({ recent, tracker }: OperationsListProps) {
  const { t } = useTranslation();
  const tracked = useTrackedOperations(tracker);
  const [rows, setRows] = useState<RecentOperationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recent) return;
    let cancelled = false;
    recent
      .listRecentOperations()
      .then((result) => {
        if (!cancelled) setRows(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [recent]);

  if (error) {
    return <DataState message={t("operations.list.error", { error })} state="error" />;
  }

  const hasTracked = tracked.length > 0;
  if (!hasTracked && rows !== null && rows.length === 0) {
    return <DataState message={t("operations.list.empty")} state="empty" />;
  }

  return (
    <section aria-label={t("operations.list.ariaLabel")} className="sh-operations-list">
      {hasTracked ? (
        <>
          <h3>{t("operations.list.sessionTitle")}</h3>
          <ul>
            {tracked.map((operation) => (
              <SessionOperationRow key={operation.id} operation={operation} />
            ))}
          </ul>
        </>
      ) : null}

      <h3>{t("operations.list.recentTitle")}</h3>
      {rows === null ? (
        <DataState message={t("operations.list.loading")} state="loading" />
      ) : rows.length === 0 ? (
        <p>{t("operations.list.recentEmpty")}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.operation_id} className="sh-operations-list__row">
              <Link to={`/operations/${row.operation_id}`}>{row.kind}</Link>
              <span>{t("operations.list.state", { state: row.state })}</span>
              <span>
                {row.error_code ? t("operations.list.errorCode", { code: row.error_code }) : ""}
              </span>
              <time dateTime={row.created_at}>{row.created_at}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SessionOperationRow({ operation }: { operation: TrackedOperation }) {
  const { t } = useTranslation();
  return (
    <li className="sh-operations-list__row">
      <span>{operation.label}</span>
      {operation.status === "running" ? (
        <span>
          {t("operations.list.sessionRunning", {
            completed: operation.completed,
            total: operation.total,
          })}
        </span>
      ) : null}
      {operation.status === "completed" && operation.resultSummary ? (
        <span>
          {t("operations.list.sessionCompleted", { ...operation.resultSummary })}
        </span>
      ) : null}
      {operation.status === "failed" ? (
        <span role="alert">{operation.error ?? t("operations.list.sessionFailed")}</span>
      ) : null}
    </li>
  );
}
