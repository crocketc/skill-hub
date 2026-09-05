import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import { Button } from "../../ui/Button";
import { type ProjectAssemblyPlanView, type ProjectFacade, type ProjectPhysicalTargetView, type ProjectView, unavailableProjectFacade } from "./api";
import { ProjectAccessPanel } from "./ProjectAccessPanel";
import { ProjectAssemblyPlanGroups } from "./ProjectAssemblyPlanGroups";
import { SharedConfigPanel } from "./SharedConfigPanel";

export interface ProjectDetailPageProps {
  projectId?: string;
  facade?: ProjectFacade;
}

export function ProjectDetailPage({ projectId = "default", facade = unavailableProjectFacade }: ProjectDetailPageProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [project, setProject] = useState<ProjectView>();
  const [agentCandidates, setAgentCandidates] = useState<Awaited<ReturnType<ProjectFacade["listAgentCandidates"]>>>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [assemblyPlan, setAssemblyPlan] = useState<ProjectAssemblyPlanView | null>(null);
  const [assemblyPlanFailed, setAssemblyPlanFailed] = useState(false);
  const [physicalTargets, setPhysicalTargets] = useState<ProjectPhysicalTargetView[]>([]);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const [savingAgents, setSavingAgents] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void facade.get(projectId).then((value) => {
      if (!active) return;
      setProject(value);
      setAgentIds(value.agentIds);
    }).catch(() => { if (active) setError(true); });
    void facade.listAgentCandidates().then((value) => { if (active) setAgentCandidates(value); }).catch(() => { if (active) setAgentCandidates([]); });
    void facade.getAssemblyPlan(projectId).then((value) => {
      if (!active) return;
      setAssemblyPlan(value);
      setAssemblyPlanFailed(false);
    }).catch(() => { if (active) setAssemblyPlanFailed(true); });
    void facade.listPhysicalTargets().then((value) => {
      if (!active) return;
      setPhysicalTargets(value);
      setSnapshotFailed(false);
    }).catch(() => { if (active) setSnapshotFailed(true); });
    return () => { active = false; };
  }, [facade, projectId]);
  if (error) return <DataState message={t("projects.unavailable")} state="unavailable" />;
  if (!project) return <DataState message={t("projects.loading")} state="loading" />;
  const saveAgentAssociations = async () => {
    setSavingAgents(true);
    setSaveError(false);
    setSaved(false);
    try {
      const updated = await facade.updateAgentIds(project.id, agentIds);
      setProject((current) => current ? { ...current, agentIds: updated.agentIds } : updated);
      setAgentIds(updated.agentIds);
      setSaved(true);
    } catch {
      setSaveError(true);
    } finally {
      setSavingAgents(false);
    }
  };
  return (
    <div className="sh-project-detail">
      <header className="sh-project-detail__header"><p className="sh-project-eyebrow">{t("projects.detail.eyebrow")}</p><h1>{project.name}</h1><p>{project.description}</p><Button onClick={() => navigate("/library", { state: { deployTarget: { id: project.id, label: project.name } } })} variant="secondary">{t("projects.detail.launchDeployment")}</Button></header>
      <ProjectAccessPanel project={project} snapshotFailed={snapshotFailed} targets={physicalTargets} />
      <section aria-labelledby="project-agent-associations" className="sh-project-detail__panel">
        <div className="sh-project-section-heading"><div><p className="sh-project-eyebrow">{t("projects.detail.agentAssociations.eyebrow")}</p><h2 id="project-agent-associations">{t("projects.detail.agentAssociations.title")}</h2></div></div>
        <p>{t("projects.detail.agentAssociations.description")}</p>
        {agentCandidates.length ? <fieldset><legend>{t("projects.detail.agentAssociations.legend")}</legend>{agentCandidates.map((agent) => <label key={agent.id}><input aria-label={agent.label} checked={agentIds.includes(agent.id)} disabled={savingAgents || !agent.available} onChange={() => { setSaved(false); setAgentIds((current) => current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id]); }} type="checkbox" />{agent.label}</label>)}</fieldset> : <p>{t("projects.detail.agentAssociations.none")}</p>}
        <Button disabled={savingAgents} loading={savingAgents} onClick={() => void saveAgentAssociations()} variant="secondary">{t("projects.detail.agentAssociations.save")}</Button>
        {saved ? <p aria-live="polite" role="status">{t("projects.detail.agentAssociations.saved")}</p> : null}
        {saveError ? <p aria-live="polite" role="status">{t("projects.detail.agentAssociations.saveFailed")}</p> : null}
      </section>
      <SharedConfigPanel config={project.sharedConfig} />
      <ProjectAssemblyPlanGroups failed={assemblyPlanFailed} plan={assemblyPlan} />
    </div>
  );
}
