import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DataState } from "../../ui/DataState";
import { BestEffortAssembly } from "./BestEffortAssembly";
import { type ProjectFacade, type ProjectView, unavailableProjectFacade } from "./api";
import { SharedConfigPanel } from "./SharedConfigPanel";

export interface ProjectDetailPageProps {
  projectId?: string;
  facade?: ProjectFacade;
}

export function ProjectDetailPage({ projectId = "default", facade = unavailableProjectFacade }: ProjectDetailPageProps) {
  const { t } = useTranslation();
  const [project, setProject] = useState<ProjectView>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void facade.get(projectId).then((value) => { if (active) setProject(value); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [facade, projectId]);
  if (error) return <DataState message={t("projects.unavailable")} state="unavailable" />;
  if (!project) return <DataState message={t("projects.loading")} state="loading" />;
  return (
    <div className="sh-project-detail">
      <header className="sh-project-detail__header"><p className="sh-project-eyebrow">{t("projects.detail.eyebrow")}</p><h1>{project.name}</h1><p>{project.description}</p></header>
      <SharedConfigPanel config={project.sharedConfig} />
      <BestEffortAssembly items={project.assembly} />
    </div>
  );
}
