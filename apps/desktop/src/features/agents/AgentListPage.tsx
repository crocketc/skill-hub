import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import { type AgentFacade, type AgentView, unavailableAgentFacade } from "./api";

export interface AgentListPageProps {
  facade?: AgentFacade;
}

export function AgentListPage({ facade = unavailableAgentFacade }: AgentListPageProps) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentView[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void facade.list().then((value) => {
      if (active) setAgents(value);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    });
    return () => { active = false; };
  }, [facade, t]);

  if (error) return <DataState message={t("agents.unavailable")} state="unavailable" />;
  if (!agents) return <DataState message={t("agents.loading")} state="loading" />;

  return (
    <div className="sh-agent-list">
      <header className="sh-agent-list__header">
        <div><p className="sh-agent-eyebrow">{t("agents.eyebrow")}</p><h1>{t("agents.title")}</h1><p>{t("agents.description")}</p></div>
      </header>
      <ul className="sh-agent-list__items">
        {agents.map((agent) => <li key={agent.id}><Link to={`/agents/${agent.id}`}><strong>{agent.brand} · {agent.instance}</strong><span>{agent.discoveredPaths[0]}</span></Link></li>)}
      </ul>
    </div>
  );
}
