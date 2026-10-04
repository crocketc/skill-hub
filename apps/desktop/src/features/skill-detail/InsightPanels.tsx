import { useTranslation } from "react-i18next";
import { readableAgentIdName } from "../../ui/AgentPresentation";
import type { SkillDetailInsights } from "./api";

export function ConnectionEvidence({ insights }: { insights: SkillDetailInsights }) {
  const { t } = useTranslation();
  // P1-12：确定性重复候选不再混入合并列表——它们在语义重复面板的
  // "确定性重复候选"小节常显（来自 getInsights，无需 AI）。其余证据各归其位。
  // G-18：组合与依赖渲染为结构化事实——成员标签、关系形态、代理可读名与路径。
  const hasEntries = insights.dependencies.length > 0 || insights.combinations.length > 0;
  return (
    <div className="sh-detail-insights">
      <h3>{t("skillDetail.insights.connections")}</h3>
      {hasEntries ? (
        <ul>
          {insights.dependencies.map((dependency) => (
            <li key={dependency.id}>
              {`${dependency.shapeLabel} · ${dependency.path}`}
              {dependency.agentClientId ? ` · ${readableAgentIdName(dependency.agentClientId)}` : ""}
            </li>
          ))}
          {insights.combinations.map((combination) => (
            <li key={combination.name}>
              {combination.otherMemberLabels.length
                ? `${combination.name} · ${combination.otherMemberLabels.join("、")}`
                : combination.name}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("skillDetail.insights.none")}</p>
      )}
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
          {insights.externalChanges.map((change) => (
            <li key={change.id}>{`${change.path} · ${change.stateLabel}`}</li>
          ))}
          {insights.operationHistory.map((entry) => (
            <li key={entry.id}>{entry.at ? `${entry.label} · ${entry.at}` : entry.label}</li>
          ))}
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
