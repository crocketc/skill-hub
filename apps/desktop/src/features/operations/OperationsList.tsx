import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { formatDateTime, resolveLocale, type SupportedLocale } from "../../i18n";
import { DataState } from "../../ui/DataState";
import { Icon } from "../../ui/Icon";
import { useTrackedOperations, type OperationTracker, type TrackedOperation } from "../../platform/operationTracker";
import { PHASE_PRESENTATION } from "./phasePresentation";
import { type RecentOperationRow, type RecentOperationsReader } from "./api";
import "./operations.css";

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
 * T4-A：两类记录都渲染为结构化时间线，时间经 Intl.DateTimeFormat 本地化；
 * 没有数据时显示说明，不伪造历史。
 */
export function OperationsList({ recent, tracker }: OperationsListProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale([i18n.resolvedLanguage ?? i18n.language]);
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

  // 记录列表规模为数十行，直接逐行格式化；无测量证据不做记忆化
  // （计划第 2 节：性能优化必须有可复现的前后证据）。
  const formattedTimes = formatTimes(
    rows?.map((row) => row.created_at) ?? [],
    locale,
  );

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
          <ol className="sh-operations-timeline">
            {tracked.map((operation) => (
              <SessionTimelineEntry key={operation.id} locale={locale} operation={operation} />
            ))}
          </ol>
        </>
      ) : null}

      <h3>{t("operations.list.recentTitle")}</h3>
      {rows === null ? (
        <DataState message={t("operations.list.loading")} state="loading" />
      ) : rows.length === 0 ? (
        <p>{t("operations.list.recentEmpty")}</p>
      ) : (
        <ol aria-label={t("operations.list.timeline")} className="sh-operations-timeline">
          {rows.map((row, index) => (
            <li className="sh-operations-timeline__entry" key={row.operation_id}>
              <span aria-hidden="true" className={`sh-operations-timeline__marker sh-operations-timeline__marker--${PHASE_PRESENTATION[row.phase].tone}`}>
                <Icon name={PHASE_PRESENTATION[row.phase].icon} />
              </span>
              <div className="sh-operations-timeline__content">
                <div className="sh-operations-timeline__heading">
                  <Link to={`/operations/${row.operation_id}`}>{row.kind}</Link>
                  <span className={`sh-status sh-status--${row.phase}`}>
                    {t(`operations.phases.${row.phase}` as never)}
                  </span>
                </div>
                {row.error_code ? (
                  <p className="sh-operations-timeline__error">{t("operations.list.errorCode", { code: row.error_code })}</p>
                ) : null}
                <time className="sh-operations-timeline__time" dateTime={row.created_at}>
                  {formattedTimes[index]}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SessionTimelineEntry({ locale, operation }: { locale: SupportedLocale; operation: TrackedOperation }) {
  const { t } = useTranslation();
  const tone = operation.status === "completed"
    ? "success"
    : operation.status === "failed"
      ? "danger"
      : operation.status === "cancelled"
        ? "muted"
        : "info";
  const icon = operation.status === "completed"
    ? "success"
    : operation.status === "failed"
      ? "failure"
      : operation.status === "cancelled"
        ? "close"
        : "update";
  return (
    <li className="sh-operations-timeline__entry">
      <span aria-hidden="true" className={`sh-operations-timeline__marker sh-operations-timeline__marker--${tone}`}>
        <Icon name={icon} />
      </span>
      <div className="sh-operations-timeline__content">
        <div className="sh-operations-timeline__heading">
          <span>{operation.label}</span>
          <time className="sh-operations-timeline__time" dateTime={new Date(operation.startedAt).toISOString()}>
            {formatDateTime(new Date(operation.startedAt), locale)}
          </time>
        </div>
        {operation.status === "running" ? (
          <p>
            {t("operations.list.sessionRunning", {
              completed: operation.completed,
              total: operation.total,
            })}
          </p>
        ) : null}
        {operation.status === "completed" && operation.resultSummary ? (
          <p>
            {t("operations.list.sessionCompleted", { ...operation.resultSummary })}
          </p>
        ) : null}
        {operation.status === "failed" ? (
          <p className="sh-operations-timeline__error" role="alert">{operation.error ?? t("operations.list.sessionFailed")}</p>
        ) : null}
      </div>
    </li>
  );
}

function formatTimes(values: string[], locale: SupportedLocale): string[] {
  return values.map((value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : formatDateTime(date, locale);
  });
}
