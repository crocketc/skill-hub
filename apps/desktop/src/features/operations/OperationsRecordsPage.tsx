import { useTranslation } from "react-i18next";
import { OperationsList } from "./OperationsList";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import type { OperationTracker } from "../../platform/operationTracker";
import { nativeRecentOperations, type RecentOperationsReader } from "./nativeApi";

export interface OperationsRecordsPageProps {
  /** 持久化的最近操作；默认读取原生 BootstrapSnapshot.recent_operations。 */
  recent?: RecentOperationsReader;
  /** 本会话后台操作；生产环境使用全局 operationTracker 单例。 */
  tracker?: OperationTracker;
}

/**
 * AR-015：/operations 指向真实操作记录列表——本会话 tracker 操作与持久化
 * 最近记录双来源，渲染为结构化时间线；单条操作详情仍由
 * /operations/:operationId 的 OperationProgress 呈现。
 * 页面 h1 由顶栏承载，内容从 h2 开始（规格 4.3）。
 */
export function OperationsRecordsPage({ recent = nativeRecentOperations, tracker }: OperationsRecordsPageProps) {
  const { t } = useTranslation();
  return (
    <PageFrame width="wide">
      <div className="sh-workflow-page sh-operations-page">
        <PageHeader title={t("operations.recordsTitle")} />
        <section aria-label={t("operations.list.ariaLabel")} className="sh-workflow-card sh-operations-page__card">
          <OperationsList recent={recent} tracker={tracker} />
        </section>
      </div>
    </PageFrame>
  );
}
