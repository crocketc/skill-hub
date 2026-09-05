import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { StatusBadge } from "../../ui/StatusBadge";
import { type AgentFacade, type AgentView, unavailableAgentFacade } from "./api";

export interface AgentListPageProps {
  facade?: AgentFacade;
}

export function AgentListPage({ facade = unavailableAgentFacade }: AgentListPageProps) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentView[]>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    void facade.list().then((value) => {
      if (active) setAgents(value);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    });
    return () => { active = false; };
  }, [facade, revision, t]);

  const agentGroups = useMemo(() => {
    const grouped = new Map<string, AgentView[]>();
    for (const agent of agents ?? []) {
      grouped.set(agent.brand, [...(grouped.get(agent.brand) ?? []), agent]);
    }
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [agents]);

  const rescan = async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      await facade.rescan();
      setRevision((current) => current + 1);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    } finally {
      setRefreshing(false);
    }
  };

  if (error) return <DataState message={t("agents.unavailable")} state="unavailable" />;
  if (!agents) return <DataState message={t("agents.loading")} state="loading" />;

  return (
    <div className="sh-agent-list">
      <header className="sh-agent-list__header">
        <div><p className="sh-agent-eyebrow">{t("agents.eyebrow")}</p><h1>{t("agents.title")}</h1><p>{t("agents.description")}</p></div>
        <Button loading={refreshing} onClick={() => void rescan()} variant="secondary">{t("agents.actions.rescan")}</Button>
      </header>
      {agentGroups.map(([brand, groupedAgents]) => (
        <section aria-labelledby={`agent-brand-${brand}`} className="sh-agent-list__brand" key={brand}>
          <h2 id={`agent-brand-${brand}`}>{brand}</h2>
          <ul className="sh-agent-list__items">
            {groupedAgents.map((agent) => <li key={agent.id}><Link to={`/agents/${agent.id}`}><strong>{agent.instance}</strong><span>{agent.discoveredPaths[0] ?? t("agents.status.directory_only")}</span><div className="sh-agent-list__summary"><StatusBadge tone={statusTone(agent.status)}>{t(`agents.status.${agent.status}`)}</StatusBadge><span>{t("agents.managedDeploymentCount", { count: agent.managedDeploymentCount })}</span></div></Link></li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}

function statusTone(status: AgentView["status"]): "info" | "neutral" | "success" | "warning" {
  if (status === "accessible") return "success";
  if (status === "inaccessible") return "warning";
  if (status === "custom") return "info";
  return "neutral";
}
