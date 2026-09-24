import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { runTrackedOperation } from "../../../platform/runTrackedOperation";
import { useOptionalAppNotifications } from "../../../ui/notifications";
import type { OperationTracker } from "../../../platform/operationTracker";
import { operationTracker } from "../../../platform/operationTracker";
import { Button } from "../../../ui/Button";
import { DataState } from "../../../ui/DataState";
import { RelationshipsLayout } from "../RelationshipsLayout";
import { relationshipsKeys } from "../api";
import { desktopDirectoryPicker } from "../../../platform/directoryPicker";
import type { GovernanceHistoryEntry } from "../../../api/bindings";
import type { RelationGovernanceFacade } from "./api";
import { nativeGovernanceFacade } from "./nativeApi";
import { GovernanceHistoryTable } from "./GovernanceHistoryTable";

const PAGE_SIZE = 20;

export interface GovernanceHistoryPageProps {
  /** 治理门面；缺省用原生实现，测试/预览注入替身。 */
  facade?: RelationGovernanceFacade;
  /** 统一执行桥的在途投影；测试注入独立实例，默认模块级单例。 */
  tracker?: OperationTracker;
}

/**
 * 关系治理历史（任务 12A）：只读展示写入时固化的不可变快照，按时间倒序。
 * ExternalRemoved（外部删除）条目提供「重新关联」——经目录 picker 取得受控
 * 路径后调用 RelinkSourceCopy；后端成功前不会出现任何新的 current 关系。
 */
export function GovernanceHistoryPage({
  facade = nativeGovernanceFacade,
  tracker = operationTracker,
}: GovernanceHistoryPageProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const notifications = useOptionalAppNotifications();
  const [page, setPage] = useState(1);

  const historyQuery = useQuery({
    queryFn: () => facade.listHistory({ page, pageSize: PAGE_SIZE }),
    queryKey: relationshipsKeys.governanceHistory({ page, pageSize: PAGE_SIZE }),
  });

  const describeError = useCallback(
    (_reason: unknown) => String(t("tasks.notices.failureUnknown") as never),
    [t],
  );

  const relinkEntry = useCallback((entry: GovernanceHistoryEntry) => {
    void (async () => {
      // 受控路径授权：只接受目录 picker 的选取结果，不接受手输任意路径。
      const pickedPath = await desktopDirectoryPicker.pickDirectory().catch(() => null);
      if (!pickedPath) return;
      await runTrackedOperation({
        canCancel: false,
        describeError,
        invalidateQueryKeys: [[relationshipsKeys.root]],
        kind: "relink_source_copy",
        label: t("relationships.governance.history.relink"),
        notifications,
        queryClient,
        run: () => facade.relinkSourceCopy(entry.relation_id, pickedPath),
        successNotice: () => ({
          title: t("relationships.governance.history.relinkDone"),
          tone: "success" as const,
        }),
        tracker,
        translate: (key, options) => String(t(key as never, options as never)),
      });
    })();
  }, [describeError, facade, notifications, queryClient, t, tracker]);

  const total = historyQuery.data?.total ?? 0;
  // 历史页契约：时间倒序展示。后端按写入序返回，这里按 occurred_at 排序。
  const entries = [...(historyQuery.data?.items ?? [])].sort(
    (left, right) => Number(right.occurred_at) - Number(left.occurred_at),
  );
  const hasNextPage = page * PAGE_SIZE < total;

  return (
    <RelationshipsLayout scope="governance">
      <div data-testid="governance-history-page">
        <div className="sh-governance__history-topbar">
          <h1>{t("relationships.governance.history.title")}</h1>
          <div className="sh-governance__history-links">
            <Link data-testid="governance-history-list-link" to="/relationships/governance">
              {t("relationships.governance.history.listLink")}
            </Link>
          </div>
        </div>
        {historyQuery.isError ? (
          <DataState message={t("relationships.governance.history.loadError")} state="error" />
        ) : !historyQuery.isSuccess ? (
          <DataState message={t("deployment.states.loading")} state="loading" />
        ) : entries.length === 0 ? (
          <p role="status">{t("relationships.governance.history.empty")}</p>
        ) : (
          <>
            <GovernanceHistoryTable entries={entries} onRelink={relinkEntry} />
            <div className="sh-governance__history-pager">
              <Button
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                size="sm"
                variant="secondary"
              >
                {t("relationships.governance.history.prevPage")}
              </Button>
              <span>{t("relationships.governance.history.pageInfo", { page, total })}</span>
              <Button
                data-testid="governance-history-next-page"
                disabled={!hasNextPage}
                onClick={() => setPage((current) => current + 1)}
                size="sm"
                variant="secondary"
              >
                {t("relationships.governance.history.nextPage")}
              </Button>
            </div>
          </>
        )}
      </div>
    </RelationshipsLayout>
  );
}
