import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import type { SkillDetailInsights, SkillDetailSummary } from "./api";

export function SecurityEvidence({ summary }: { summary: SkillDetailSummary }) {
  const { t } = useTranslation();
  return (
    <div className="sh-detail-insights">
      <h3>{t("skillDetail.insights.basicSecurity")}</h3>
      <StatusBadge tone={summary.basicCheck === "passed" ? "success" : "warning"}>
        {t(`skillLibrary.table.checkStates.${summary.basicCheck === "not_run" ? "notRun" : summary.basicCheck}`)}
      </StatusBadge>
      <p>{t("skillDetail.insights.riskSummary", { high: summary.highRiskCount, pending: summary.pendingCount })}</p>
    </div>
  );
}

export function ConnectionEvidence({ insights }: { insights: SkillDetailInsights }) {
  const { t } = useTranslation();
  const values = [...insights.dependencies, ...insights.deterministicDuplicates, ...insights.semanticDuplicates, ...insights.combinations];
  return (
    <div className="sh-detail-insights">
      <h3>{t("skillDetail.insights.connections")}</h3>
      {values.length ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <p>{t("skillDetail.insights.none")}</p>}
    </div>
  );
}

export function ExternalHistoryEvidence({ insights }: { insights: SkillDetailInsights }) {
  const { t } = useTranslation();
  return (
    <div className="sh-detail-insights">
      <h3>{t("skillDetail.insights.externalHistory")}</h3>
      <ul>
        {insights.externalChanges.map((value) => <li key={value}>{value}</li>)}
        {insights.operationHistory.map((entry) => <li key={entry.id}>{entry.label}</li>)}
      </ul>
      {insights.usageEvidence ? (
        <section>
          <h3>{t("skillDetail.insights.usageEvidence")}</h3>
          <p>{t("skillDetail.insights.invocations", { count: insights.usageEvidence.invocationCount })}</p>
        </section>
      ) : null}
    </div>
  );
}
