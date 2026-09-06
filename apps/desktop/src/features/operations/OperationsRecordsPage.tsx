import { useTranslation } from "react-i18next";
import { OperationsList } from "./OperationsList";
import { nativeRecentOperations, type RecentOperationsReader } from "./nativeApi";

export interface OperationsRecordsPageProps {
  /** 持久化的最近操作；默认读取原生 BootstrapSnapshot.recent_operations。 */
  recent?: RecentOperationsReader;
}

/**
 * AR-015：/operations 指向真实操作记录列表——本会话 tracker 操作与持久化
 * 最近记录双来源；单条操作详情仍由 /operations/:operationId 的
 * OperationProgress 呈现。
 */
export function OperationsRecordsPage({ recent = nativeRecentOperations }: OperationsRecordsPageProps) {
  const { t } = useTranslation();
  return (
    <main className="sh-page">
      <header className="sh-page__header">
        <div>
          <h1>{t("operations.recordsTitle")}</h1>
        </div>
      </header>
      <OperationsList recent={recent} />
    </main>
  );
}
