import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { describeNativeError } from "../../api/nativeErrors";
import { formatDateTime, resolveLocale, type SupportedLocale } from "../../i18n";
import { DataState } from "../../ui/DataState";
import { Icon } from "../../ui/Icon";
import { useTrackedOperations, type OperationTracker, type TrackedOperation } from "../../platform/operationTracker";
import { PHASE_PRESENTATION } from "./phasePresentation";
import { type RecentOperationRow, type RecentOperationsReader } from "./api";
import "./operations.css";

/**
 * DEV-94：操作 kind 是内部技术名（import_skill 等），按「技术标识不进界面」
 * 约定映射为本地化操作名；不在表内的 kind（后端新增而映射未跟上）回退原文，
 * 由补映射修复，不在渲染层编造文案。
 */
const KIND_LABEL_KEYS: Record<string, string> = {
  delete_skill: "operations.kinds.delete_skill",
  deploy_skill: "operations.kinds.deploy_skill",
  import_skill: "operations.kinds.import_skill",
  migrate_original: "operations.kinds.migrate_original",
  relink_source_copy: "operations.kinds.relink_source_copy",
  undeploy_skill: "operations.kinds.undeploy_skill",
  uninstall_skill: "operations.kinds.uninstall_skill",
};

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
  const locale = resolveLocale([i18n.resolvedLanguage ?? i18n.language]);  const tracked = useTrackedOperations(tracker);
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
        if (!cancelled) setError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "tasks.notices.failureUnknown"));
      });
    return () => {
      cancelled = true;
    };
  }, [recent, t]);

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
            <RecentTimelineEntry
              formattedTime={formattedTimes[index]}
              key={row.operation_id}
              row={row}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/** DEV-94：单条持久化操作的时间线条目——本地化操作名标题、阶段徽标、
 *  本地化时间、目标结果摘要（快照携带 targets 时）。 */
function RecentTimelineEntry({
  formattedTime,
  row,
}: {
  formattedTime: string;
  row: RecentOperationRow;
}) {
  const { t } = useTranslation();
  const labelKey = KIND_LABEL_KEYS[row.kind];
  // DEV-94：快照携带 object_name 时标题带对象名（「导入技能：Notes」），
  // 没有则退回本地化 kind 或原始 kind；技术名不裸奔进界面。
  const label = labelKey ? t(labelKey as never) : row.kind;
  const title = row.object_name?.trim()
    ? (t("operations.list.objectTitle" as never, { label, name: row.object_name }) as string)
    : label;
  const targets = row.targets ?? [];
  const succeeded = targets.filter((target) => target.error_code === null).length;
  const failed = targets.length - succeeded;
  return (
    <li className="sh-operations-timeline__entry">
      <span aria-hidden="true" className={`sh-operations-timeline__marker sh-operations-timeline__marker--${PHASE_PRESENTATION[row.phase].tone}`}>
        <Icon name={PHASE_PRESENTATION[row.phase].icon} />
      </span>
      <div className="sh-operations-timeline__content">
        <div className="sh-operations-timeline__heading">
          <Link to={`/operations/${row.operation_id}`}>
            {title}
          </Link>
          <span className={`sh-status sh-status--${row.phase}`}>
            {t(`operations.phases.${row.phase}` as never)}
          </span>
        </div>
        {targets.length > 0 ? (
          <>
            <p>{t("operations.list.targetsSummary", { succeeded, failed })}</p>
            {targets
              .filter((target) => target.error_code !== null && target.path)
              .map((target) => (
                <p className="sh-operations-timeline__error" key={target.physical_target_id}>
                  {t("operations.list.targetFailed", { path: target.path })}
                </p>
              ))}
          </>
        ) : null}
        {row.error_code ? (
          <p className="sh-operations-timeline__error">{t("operations.list.errorCode", { code: row.error_code })}</p>
        ) : null}
        <time className="sh-operations-timeline__time" dateTime={row.created_at}>
          {formattedTime}
        </time>
      </div>
    </li>
  );
}

function SessionTimelineEntry({ locale, operation }: { locale: SupportedLocale; operation: TrackedOperation }) {
  const { t } = useTranslation();
  const tone = operation.status === "success" || operation.status === "partial"
    ? operation.status === "partial" ? "warning" : "success"
    : operation.status === "failed"
      ? "danger"
      : operation.status === "cancelled"
        ? "muted"
        : "info";
  const icon = operation.status === "success"
    ? "success"
    : operation.status === "partial"
      ? "warning"
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
        {operation.status === "success" && operation.resultSummary ? (
          <p>
            {t("operations.list.sessionCompleted", { ...operation.resultSummary, todo: operation.resultSummary.todo ?? 0 })}
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
    // DEV-94：后端 created_at 落库为 epoch 秒字符串（如 1789890340），
    // 按 ISO 解析会得到 Invalid Date 并把原始数字串回显给用户；10 位纯
    // 数字按秒转 Date。彻底解析不了的显示「—」，不回显原始值。
    const epochSeconds = /^\d{10}$/.test(value) ? Number(value) : null;
    const date =
      epochSeconds !== null
        ? new Date(epochSeconds * 1000)
        : new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : formatDateTime(date, locale);
  });
}
