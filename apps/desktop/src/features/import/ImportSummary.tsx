import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { StatusBadge } from "../../ui/StatusBadge";
import type { ImportResult } from "./api";

export interface ImportSummaryProps {
  results: ImportResult[];
  unavailable?: boolean;
  onOpenGovernanceTask?: (task: NonNullable<ImportResult["governanceTasks"]>[number]) => void;
}

/** 导入结果摘要：统计、逐项结果与明细展开；重试/打开库在向导底部操作区。 */
export function ImportSummary({
  results,
  unavailable = false,
  onOpenGovernanceTask,
}: ImportSummaryProps) {
  const { t } = useTranslation();
  const [showCompletedDetails, setShowCompletedDetails] = useState(false);

  if (unavailable) {
    return (
      <section className="sh-import-summary" aria-labelledby="import-summary-title">
        <h2 id="import-summary-title">{t("importWorkflow.summary.title")}</h2>
        <DataState
          message={t("importWorkflow.summary.unavailable")}
          state="unavailable"
        />
      </section>
    );
  }

  const hasAttention = results.some((result) => result.status === "failed" || result.status === "todo");
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const todo = results.filter((result) => result.status === "todo").length;
  const visibleResults = showCompletedDetails
    ? results
    : results.filter((result) => result.status === "failed" || result.status === "todo");
  const governanceTasks = results.flatMap((result) => result.governanceTasks ?? []);
  const originalsPreserved = results.some((result) => result.originalPreserved);

  return (
    <section className="sh-import-summary" aria-labelledby="import-summary-title">
      <div className="sh-import-summary__heading">
        <div>
          <p className="sh-import-summary__eyebrow">{t("importWorkflow.summary.eyebrow")}</p>
          <h2 id="import-summary-title">{t("importWorkflow.summary.title")}</h2>
          <p>{t(hasAttention ? "importWorkflow.summary.partial" : "importWorkflow.summary.complete")}</p>
        </div>
      </div>

      <div className="sh-import-summary__counts">
        <span>{t("importWorkflow.summary.counts.succeeded", { count: succeeded })}</span>
        <span>{t("importWorkflow.summary.counts.skipped", { count: skipped })}</span>
        <span>{t("importWorkflow.summary.counts.failed", { count: failed })}</span>
        <span>{t("importWorkflow.summary.counts.todo", { count: todo })}</span>
      </div>

      {originalsPreserved ? (
        <p className="sh-import-summary__preservation">
          原始副本保持不变；如需清理，请在关系治理中单独确认并保留回退路径。
        </p>
      ) : null}

      {governanceTasks.length > 0 && onOpenGovernanceTask ? (
        <div aria-label="关系治理待办">
          {governanceTasks.map((task) => (
            <Button key={task.task_id} onClick={() => onOpenGovernanceTask(task)} variant="ghost">
              查看治理待办 {task.task_id}
            </Button>
          ))}
        </div>
      ) : null}

      <ul className="sh-import-summary__list">
        {visibleResults.map((result) => (
          <li className="sh-import-summary__item" key={result.candidateId}>
            <div>
              <strong>{result.candidateId}</strong>
              <span>{t(`importWorkflow.summary.actions.${result.action}`)}</span>
            </div>
            <StatusBadge tone={result.status === "succeeded" ? "success" : result.status === "skipped" ? "neutral" : result.status === "todo" ? "warning" : "danger"}>
              {t(`importWorkflow.summary.status.${result.status}`)}
            </StatusBadge>
            <p>{t(result.message, { defaultValue: result.message })}</p>
            {result.provenance ? (
              <p
                className="sh-import-summary__provenance"
                data-testid="import-provenance"
              >
                {t("importWorkflow.summary.provenance", {
                  agent: result.provenance.agentClientId ??
                    t("importWorkflow.summary.unknownAgent"),
                  path: result.provenance.originalPath,
                })}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {succeeded + skipped > 0 ? (
        <Button onClick={() => setShowCompletedDetails((current) => !current)} variant="ghost">
          {t(showCompletedDetails
            ? "importWorkflow.summary.hideCompletedDetails"
            : "importWorkflow.summary.showCompletedDetails")}
        </Button>
      ) : null}
    </section>
  );
}
