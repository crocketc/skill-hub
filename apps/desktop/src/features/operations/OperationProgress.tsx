import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { DataState } from "../../ui/DataState";
import { localizeErrorCode, operationObjectTitle } from "./labels";
import { OperationPhaseStatus } from "./OperationPhaseStatus";
import { type OperationFacade, type OperationState, unavailableOperationFacade } from "./api";

export function OperationProgress({ operationId, facade = unavailableOperationFacade }: { operationId: string; facade?: OperationFacade }) {
  const { t } = useTranslation();
  const [operation, setOperation] = useState<OperationState>();
  const [error, setError] = useState<string>();
  useEffect(() => { void facade.get(operationId).then(setOperation).catch((reason: unknown) => setError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "tasks.notices.failureUnknown"))); }, [facade, operationId, t]);
  if (error) return <DataState message={error} state="unavailable" />;
  if (!operation) return <DataState message={t("operations.loading")} state="loading" />;
  const progress = operation.total > 0 ? Math.round((operation.completed / operation.total) * 100) : 0;
  // DEV-99：operation id 不进界面；标题用「本地化操作名：对象名」，message
  // 只在携带真实错误码（≠裸 kind）时呈现，原始 kind 不回显。
  const title = operationObjectTitle(operation.kind, operation.objectName, (key, options) => String(t(key as never, options as never))) || t("recovery.unknownOperation");
  const errorCode = operation.kind && operation.message && operation.message !== operation.kind ? localizeErrorCode(operation.message, (key, options) => String(t(key as never, options as never))) : undefined;
  return <section aria-labelledby="operation-progress-heading" className="sh-workflow-card"><div className="sh-section-heading"><div><p className="sh-eyebrow">{t("operations.eyebrow")}</p><h2 id="operation-progress-heading">{title}</h2></div><OperationPhaseStatus phase={operation.phase} /></div>{errorCode ? <p>{errorCode}</p> : null}<progress aria-label={t("operations.progressLabel")} max={100} value={progress}>{progress}%</progress><details><summary>{t("operations.technicalDetails")}</summary><dl className="sh-facts"><dt>{t("operations.completed")}</dt><dd>{operation.completed}/{operation.total}</dd></dl></details></section>;
}
