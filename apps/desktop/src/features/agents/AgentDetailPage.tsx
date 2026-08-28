import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DataState } from "../../ui/DataState";
import { StatusBadge } from "../../ui/StatusBadge";
import { type AgentFacade, type AgentView, unavailableAgentFacade } from "./api";
import { RelationsView } from "./RelationsView";
import { UsageEvidencePanel } from "./UsageEvidencePanel";

export interface AgentDetailPageProps {
  agentId?: string;
  facade?: AgentFacade;
}

export function AgentDetailPage({ agentId = "default", facade = unavailableAgentFacade }: AgentDetailPageProps) {
  const { t } = useTranslation();
  const [agent, setAgent] = useState<AgentView>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void facade.get(agentId).then((value) => {
      if (active) setAgent(value);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    });
    return () => { active = false; };
  }, [agentId, facade, t]);

  if (error) return <DataState message={error} state="unavailable" />;
  if (!agent) return <DataState message={t("agents.loading")} state="loading" />;

  return (
    <div className="sh-agent-detail">
      <header className="sh-agent-detail__header">
        <div>
          <p className="sh-agent-eyebrow">{t("agents.detail.eyebrow")}</p>
          <h1>{agent.brand} · {agent.instance}</h1>
          <p>{t("agents.detail.discoveredFact")}</p>
        </div>
        <StatusBadge tone="info">{t("agents.detail.observed")}</StatusBadge>
      </header>
      <section className="sh-agent-facts" aria-label={t("agents.detail.identity")}>
        <div><dt>{t("agents.detail.brand")}</dt><dd>{agent.brand}</dd></div>
        <div><dt>{t("agents.detail.client")}</dt><dd>{agent.client}</dd></div>
        <div><dt>{t("agents.detail.instance")}</dt><dd>{agent.instance}</dd></div>
        <div><dt>{t("agents.detail.paths")}</dt><dd>{agent.discoveredPaths.join("、")}</dd></div>
      </section>
      <RelationsView relations={agent.relations} />
      <div className="sh-agent-detail__capabilities">
        <StatusBadge tone="neutral">
          <span>{t("agents.runtimeHook")}</span>
          <span aria-label={t("agents.runtimeHookStatus")}>{t("agents.runtimeHookStatus")}</span>
        </StatusBadge>
      </div>
      <UsageEvidencePanel />
    </div>
  );
}
