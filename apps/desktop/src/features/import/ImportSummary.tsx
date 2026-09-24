import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { StatusBadge } from "../../ui/StatusBadge";
import { AgentPresentation } from "../../ui/AgentPresentation";
import { displayPath } from "../../platform/displayPath";
import type { ImportResult } from "./api";

export interface ImportSummaryProps {
  results: ImportResult[];
  unavailable?: boolean;
  /**
   * 任务 10：后端计算的本次导入可管理来源副本数。CTA 只由它与失败数
   * 决定；缺省按 0 处理（online-only 导入不提供整理入口）。
   */
  manageableSourceCount?: number;
  onOpenGovernance?: () => void;
  onContinueLater?: () => void;
  /** 任务 10：有失败/待办时，主操作回到向导重新发起（绝不静默重复提交）。 */
  onRetryFailed?: () => void;
  onOpenGovernanceTask?: (task: NonNullable<ImportResult["governanceTasks"]>[number]) => void;
}

/** 导入结果摘要：统计、逐项结果与明细展开；重试/打开库在向导底部操作区。 */
export function ImportSummary({
  results,
  unavailable = false,
  manageableSourceCount,
  onOpenGovernance,
  onContinueLater,
  onRetryFailed,
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
  // 任务 10：治理资格只看后端计数；originalsPreserved 只是事实展示，不作判断。
  const manageableCount = manageableSourceCount ?? 0;
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
          {t("importWorkflow.summary.originalsPreserved")}
        </p>
      ) : null}

      {hasAttention || manageableCount > 0 ? (
        <section aria-label={t("importWorkflow.summary.governanceNextLabel")} className="sh-import-summary__governance-next">
          <p>{t("importWorkflow.summary.governanceNextDescription")}</p>
          <div className="sh-button-row">
            {hasAttention ? (
              <Button onClick={onRetryFailed} disabled={!onRetryFailed}>
                {t("importWorkflow.summary.retryFailed")}
              </Button>
            ) : (
              <Button onClick={onOpenGovernance} disabled={!onOpenGovernance}>
                {t("importWorkflow.summary.organizeNow")}
              </Button>
            )}
            {hasAttention && manageableCount > 0 ? (
              <Button onClick={onOpenGovernance} disabled={!onOpenGovernance} variant="secondary">
                {t("importWorkflow.summary.organizeNow")}
              </Button>
            ) : null}
            {!hasAttention && manageableCount > 0 ? (
              <Button onClick={onContinueLater} disabled={!onContinueLater} variant="secondary">
                {t("importWorkflow.summary.organizeLater")}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {governanceTasks.length > 0 && onOpenGovernanceTask ? (
        <div aria-label={t("importWorkflow.summary.governanceTasksLabel")}>
          {governanceTasks.map((task) => (
            <Button key={task.task_id} onClick={() => onOpenGovernanceTask(task)} variant="ghost">
              {t("importWorkflow.summary.openGovernanceTask", { taskId: task.task_id })}
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
                {result.provenance.sourceKind === "https" || result.provenance.sourceKind === "git" ? (
                  // 在线来源只展示服务/仓库地址，绝不显示本机缓存路径。
                  <>
                    {t("importWorkflow.summary.provenanceOnline")}{" "}
                    <strong>{result.provenance.sourceLocator ?? "—"}</strong>
                  </>
                ) : (
                  <>
                    {result.provenance.agentClientId ? (
                      <>
                        {t("importWorkflow.summary.provenanceAgent")}{" "}
                        <AgentPresentation agentId={result.provenance.agentClientId} />
                      </>
                    ) : (
                      t("importWorkflow.summary.provenanceLocal")
                    )}{" "}
                    <strong>{t("agents.pathLabel")}</strong>{" "}
                    {displayPath(result.provenance.originalPath)}
                  </>
                )}
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
