import { useContext, useRef } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import { Icon, type IconName } from "../../ui/Icon";
import {
  relationshipsKeys,
  type RelationshipsFacade,
} from "../relationships/api";
import { nativeRelationshipsFacade } from "../relationships/nativeApi";
import {
  getOverviewRelationEntries,
  getOverviewRelationEntryHref,
  type OverviewRelationEntryKey,
} from "./api";

/**
 * 任务 1/2/3 三条只读关系查询的聚合状态。全部走任务 5 的共享 query key
 * 命名空间：关系页内的确认/治理提交按根键失效后，概览计数随之刷新；
 * 概览自身是纯浏览查询，不经 runTrackedOperation（无写入、无顶栏任务）。
 * 页面（冻结指标带的冲突项）与缩略带共用本 hook，查询按 key 去重。
 */
export function useOverviewRelationshipSummaries(
  facade: RelationshipsFacade = nativeRelationshipsFacade,
) {
  const contextClient = useContext(QueryClientContext);
  // 挂载点缺 QueryClientProvider 时（BootstrapGate 等纯路由夹具），改用本地
  // 降级客户端并禁用查询：行为等同"摘要不可用"的占位状态——不崩溃、
  // 不发请求、不产生假计数；生产路由始终有全局 provider，不受影响。
  const fallbackClientRef = useRef<QueryClient | null>(null);
  if (fallbackClientRef.current === null) {
    fallbackClientRef.current = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
  }
  const queriesEnabled = contextClient !== undefined;
  const queryClient = contextClient ?? fallbackClientRef.current;

  const candidatesQuery = useQuery(
    {
      enabled: queriesEnabled,
      queryFn: () => facade.listCandidates(),
      queryKey: relationshipsKeys.candidates(),
    },
    queryClient,
  );
  const conflictsQuery = useQuery(
    {
      enabled: queriesEnabled,
      queryFn: () => facade.getConflictWorkspace(),
      queryKey: relationshipsKeys.conflicts(),
    },
    queryClient,
  );
  const governanceQuery = useQuery(
    {
      enabled: queriesEnabled,
      queryFn: () => facade.listGovernance(),
      queryKey: relationshipsKeys.governance(),
    },
    queryClient,
  );

  return { candidatesQuery, conflictsQuery, governanceQuery };
}

/** 入口的纯装饰图标，按冻结的入口顺序注册。 */
const entryIcons: Record<OverviewRelationEntryKey, IconName> = {
  conflicts: "warning",
  graph: "relationships",
  governance: "library",
};

interface RelationshipThumbnailNetworkProps {
  /**
   * 测试与预览桩的接缝；缺省使用原生只读门面（与页面同一实例约定，
   * 查询经共享 key 去重，页面与缩略带不会产生双份请求）。
   */
  facade?: RelationshipsFacade;
}

/**
 * 概览的组织/关系区域：任务 1/2/3 冻结聚合出的三个缩略入口（图谱、冲突
 * 处理、关系治理），计数与标签来自 `getOverviewRelationEntries`，深链来自
 * `getOverviewRelationEntryHref`。任何数据状态（空 / 加载 / 失败）都只影响
 * 本区域内部，不吞没概览其余内容。
 */
export function RelationshipThumbnailNetwork({
  facade = nativeRelationshipsFacade,
}: RelationshipThumbnailNetworkProps) {
  const { t } = useTranslation();
  const { candidatesQuery, conflictsQuery, governanceQuery } =
    useOverviewRelationshipSummaries(facade);

  const queries = [candidatesQuery, conflictsQuery, governanceQuery];
  const pending = queries.some((query) => query.isPending);
  const allFailed = queries.every((query) => query.isError);

  const entries = getOverviewRelationEntries(
    {
      conflictWorkspace: conflictsQuery.data ?? null,
      governanceLedger: governanceQuery.data ?? null,
      relationshipCandidates: candidatesQuery.data ?? null,
    },
    t,
  );

  // 每个入口只在它自己的查询成功落地后才给出数字与钻取；加载与失败都用
  // 占位符呈现，绝不把 0 当作"查询还没回来"的答案。
  const entryReady: Record<OverviewRelationEntryKey, boolean> = {
    conflicts: conflictsQuery.isSuccess,
    graph: candidatesQuery.isSuccess,
    governance: governanceQuery.isSuccess,
  };
  const allZero =
    !pending && !allFailed && entries.every((entry) => entry.count === 0);

  return (
    <section
      aria-busy={pending || undefined}
      aria-labelledby="overview-relations-title"
      className="sh-overview__relations"
    >
      <div className="sh-overview__section-head">
        <div>
          <p className="sh-overview__eyebrow">{t("overview.summary.network.eyebrow")}</p>
          <h2 id="overview-relations-title">{t("overview.summary.network.heading")}</h2>
        </div>
        {allZero ? (
          <span className="sh-overview__relations-hint">
            {t("overview.summary.network.emptyHint")}
          </span>
        ) : null}
      </div>
      {allFailed ? (
        <DataState message={t("overview.summary.network.unavailable")} state="unavailable" />
      ) : (
        <ul className="sh-overview__relations-list">
          {entries.map((entry) => {
            const figure = (
              <span className="sh-overview__relation-figure">
                <Icon aria-hidden="true" name={entryIcons[entry.key]} size={16} />
                <strong aria-hidden="true">{entryReady[entry.key] ? entry.count : "–"}</strong>
              </span>
            );
            const name = (
              <span className="sh-overview__relation-name">{entry.label}</span>
            );
            const className = [
              "sh-overview__relation",
              entry.key === "conflicts" && entry.count > 0
                ? "sh-overview__relation--alert"
                : "",
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <li key={entry.key}>
                {entryReady[entry.key] ? (
                  <Link
                    aria-label={t(`overview.summary.entries.${entry.key}Aria`, {
                      count: entry.count,
                    })}
                    className={className}
                    to={getOverviewRelationEntryHref(entry.key)}
                  >
                    {figure}
                    {name}
                  </Link>
                ) : (
                  <p className={className}>
                    {figure}
                    {name}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
