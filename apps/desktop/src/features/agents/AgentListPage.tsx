import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { desktopDirectoryPicker, type DirectoryPicker } from "../../platform/directoryPicker";
import { Button } from "../../ui/Button";
import { BrandTag } from "../../ui/BrandTag";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DataState } from "../../ui/DataState";
import { Drawer } from "../../ui/Drawer";
import { StatusBadge } from "../../ui/StatusBadge";
import { type AgentFacade, type AgentView, unavailableAgentFacade } from "./api";
import { CustomAgentForm } from "./CustomAgentForm";

export interface AgentListPageProps {
  facade?: AgentFacade;
  picker?: DirectoryPicker;
}

type CustomAgentFormState = { mode: "create" } | { agent: AgentView; mode: "edit" };

export function AgentListPage({ facade = unavailableAgentFacade, picker = desktopDirectoryPicker }: AgentListPageProps) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentView[]>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [formState, setFormState] = useState<CustomAgentFormState>();
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

  const removeAgent = async (id: string) => {
    setError(undefined);
    try {
      await facade.removeCustomAgent(id);
      setRevision((current) => current + 1);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    }
  };

  if (error) return <DataState message={t("agents.unavailable")} state="unavailable" />;
  if (!agents) return <DataState message={t("agents.loading")} state="loading" />;

  return (
    <div className="sh-agent-list">
      <header className="sh-agent-list__header">
        <div><p className="sh-agent-eyebrow">{t("agents.eyebrow")}</p><h1>{t("agents.title")}</h1><p>{t("agents.description")}</p></div>
        <div className="sh-agent-list__header-actions">
          <Button onClick={() => setFormState({ mode: "create" })} variant="secondary">{t("agents.actions.addCustom")}</Button>
          <Button loading={refreshing} onClick={() => void rescan()} variant="secondary">{t("agents.actions.rescan")}</Button>
        </div>
      </header>
      {agentGroups.map(([brand, groupedAgents]) => (
        <section aria-labelledby={`agent-brand-${brand}`} className="sh-agent-list__brand" key={brand}>
          <h2 id={`agent-brand-${brand}`}><BrandTag brand={brand} /></h2>
          <ul className="sh-agent-list__items">
            {groupedAgents.map((agent) => (
              <li key={agent.id}>
                <Link to={`/agents/${agent.id}`}>
                  <strong>{agent.instance}</strong>
                  <span>{agent.discoveredPaths[0] ?? t("agents.status.directory_only")}</span>
                  <div className="sh-agent-list__summary">
                    <StatusBadge tone={statusTone(agent.status)}>{t(`agents.status.${agent.status}`)}</StatusBadge>
                    <span>{t("agents.managedDeploymentSummary", { relations: agent.managedDeploymentRelationCount, skills: agent.managedDeploymentCount })}</span>
                  </div>
                </Link>
                {agent.status === "custom" ? (
                  <div className="sh-agent-list__actions">
                    <Button onClick={() => setFormState({ agent, mode: "edit" })} size="sm" variant="secondary">{t("agents.actions.edit")}</Button>
                    <ConfirmDialog
                      cancelLabel={t("agents.removeDialog.cancel")}
                      confirmLabel={t("agents.removeDialog.confirm")}
                      description={t("agents.removeDialog.description", { name: agent.instance })}
                      onConfirm={() => void removeAgent(agent.id)}
                      title={t("agents.removeDialog.title")}
                      trigger={<Button size="sm" variant="danger">{t("agents.actions.remove")}</Button>}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <Drawer
        onOpenChange={(open) => { if (!open) setFormState(undefined); }}
        open={formState !== undefined}
        returnFocusRef={{ current: null }}
        title={formState?.mode === "edit" ? t("agents.customForm.editTitle") : t("agents.customForm.addTitle")}
      >
        {formState ? (
          <CustomAgentForm
            agent={formState.mode === "edit" ? formState.agent : undefined}
            facade={facade}
            onCancel={() => setFormState(undefined)}
            onSaved={() => {
              setFormState(undefined);
              setRevision((current) => current + 1);
            }}
            picker={picker}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

function statusTone(status: AgentView["status"]): "info" | "neutral" | "success" | "warning" {
  if (status === "accessible") return "success";
  if (status === "inaccessible") return "warning";
  if (status === "custom") return "info";
  return "neutral";
}
