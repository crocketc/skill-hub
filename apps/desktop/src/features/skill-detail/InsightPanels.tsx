import { useTranslation } from "react-i18next";
import type { SkillDetailInsights } from "./api";

export function ConnectionEvidence({ insights }: { insights: SkillDetailInsights }) {
  const { t } = useTranslation();
  // P1-12：确定性重复候选不再混入合并列表——它们在语义重复面板的
  // "确定性重复候选"小节常显（来自 getInsights，无需 AI）。其余证据各归其位。
  const values = [...insights.dependencies, ...insights.combinations];
  return (
    <div className="sh-detail-insights">
      <h3>{t("skillDetail.insights.connections")}</h3>
      {values.length ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <p>{t("skillDetail.insights.none")}</p>}
    </div>
  );
}

export function ExternalHistoryEvidence({ insights }: { insights: SkillDetailInsights }) {
  const { t } = useTranslation();
  const hasEntries = insights.externalChanges.length > 0 || insights.operationHistory.length > 0;
  // P1-12：块标题"外部变更"是该区块唯一导航标题，面板内部不再重复。
  return (
    <div className="sh-detail-insights">
      {insights.operationHistoryLimitation ? (
        <p>{t("skillDetail.insights.operationHistoryLimitation")}</p>
      ) : null}
      {hasEntries ? (
        <ul>
          {insights.externalChanges.map((value) => <li key={value}>{value}</li>)}
          {insights.operationHistory.map((entry) => <li key={entry.id}>{entry.label}</li>)}
        </ul>
      ) : (
        <p>{t("skillDetail.insights.operationHistoryEmpty")}</p>
      )}
      {insights.usageEvidence ? (
        <section>
          <h3>{t("skillDetail.insights.usageEvidence")}</h3>
          <p>{t("skillDetail.insights.invocations", { count: insights.usageEvidence.invocationCount })}</p>
        </section>
      ) : null}
    </div>
  );
}
