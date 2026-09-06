import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { desktopDirectoryPicker, type DirectoryPicker } from "../../platform/directoryPicker";
import { Button } from "../../ui/Button";
import { BrandTag } from "../../ui/BrandTag";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DataState } from "../../ui/DataState";
import { Drawer } from "../../ui/Drawer";
import { StatusBadge } from "../../ui/StatusBadge";
import { type AgentFacade, type AgentStatus, type AgentView, unavailableAgentFacade } from "./api";
import { CustomAgentForm } from "./CustomAgentForm";
import { RelationsView } from "./RelationsView";
import { UsageEvidencePanel } from "./UsageEvidencePanel";

export interface AgentDetailPageProps {
  agentId?: string;
  facade?: AgentFacade;
  picker?: DirectoryPicker;
}

export function AgentDetailPage({ agentId = "default", facade = unavailableAgentFacade, picker = desktopDirectoryPicker }: AgentDetailPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<AgentView>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    void facade.get(agentId).then((value) => {
      if (active) setAgent(value);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    });
    return () => { active = false; };
  }, [agentId, facade, revision, t]);

  const removeAgent = async (id: string) => {
    setError(undefined);
    try {
      await facade.removeCustomAgent(id);
      navigate("/agents");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    }
  };

  if (error) return <DataState message={error} state="unavailable" />;
  if (!agent) return <DataState message={t("agents.loading")} state="loading" />;

  return (
    <div className="sh-agent-detail">
      <header className="sh-agent-detail__header">
        <div>
          <p className="sh-agent-eyebrow">{t("agents.detail.eyebrow")}</p>
          <h1><BrandTag brand={agent.brand} /> · {agent.instance}</h1>
          <p>{t("agents.detail.discoveredFact")}</p>
        </div>
        <div className="sh-agent-detail__header-side">
          <StatusBadge tone={statusTone(agent.status)}>{t(`agents.status.${agent.status}`)}</StatusBadge>
          <Button
            onClick={() => navigate("/library", { state: { deployTarget: { id: agent.id, label: `${agent.brand} · ${agent.instance}` } } })}
            variant="secondary"
          >
            {t("agents.launchDeployment")}
          </Button>
          {agent.status === "custom" ? (
            <div className="sh-agent-detail__actions">
              <Button onClick={() => setEditing(true)} size="sm" variant="secondary">{t("agents.actions.edit")}</Button>
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
        </div>
      </header>
      <section className="sh-agent-facts" aria-label={t("agents.detail.identity")}>
        <div><dt>{t("agents.detail.brand")}</dt><dd><BrandTag brand={agent.brand} /></dd></div>
        <div><dt>{t("agents.detail.client")}</dt><dd>{agent.client}</dd></div>
        <div><dt>{t("agents.detail.instance")}</dt><dd>{agent.instance}</dd></div>
        <div><dt>{t("agents.detail.paths")}</dt><dd>{agent.discoveredPaths.join("、")}</dd></div>
        <div>
          <dt>{t("agents.detail.managedDeployments")}</dt>
          <dd>{t("agents.managedDeploymentSummary", { relations: agent.managedDeploymentRelationCount, skills: agent.managedDeploymentCount })}</dd>
        </div>
      </section>
      <RelationsView relations={agent.relations} />
      <section className="sh-agent-limits" aria-labelledby="agent-limits-title">
        <div className="sh-agent-section-heading">
          <div>
            <p className="sh-agent-eyebrow">{t("agents.limits.eyebrow")}</p>
            <h2 id="agent-limits-title">{t("agents.limits.title")}</h2>
          </div>
        </div>
        <ul>
          {agent.status === "custom" ? <li data-testid="agent-limit-relocate">{t("agents.limits.relocateUnsupported")}</li> : null}
          <li data-testid="agent-limit-ignore">{t("agents.limits.ignoreUnsupported")}</li>
        </ul>
      </section>
      <div className="sh-agent-detail__capabilities">
        <StatusBadge tone="neutral">
          <span>{t("agents.runtimeHook")}</span>
          <span aria-label={t("agents.runtimeHookStatus")}>{t("agents.runtimeHookStatus")}</span>
        </StatusBadge>
      </div>
      <UsageEvidencePanel />
      <Drawer
        onOpenChange={(open) => { if (!open) setEditing(false); }}
        open={editing}
        returnFocusRef={{ current: null }}
        title={t("agents.customForm.editTitle")}
      >
        {editing ? (
          <CustomAgentForm
            agent={agent}
            facade={facade}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              setRevision((current) => current + 1);
            }}
            picker={picker}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

function statusTone(status: AgentStatus): "info" | "neutral" | "success" | "warning" {
  if (status === "accessible") return "success";
  if (status === "inaccessible") return "warning";
  if (status === "custom") return "info";
  return "neutral";
}
