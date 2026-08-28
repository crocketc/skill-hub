import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { ProjectQuickDrawer } from "./ProjectQuickDrawer";
import { type ProjectFacade, type ProjectView, unavailableProjectFacade } from "./api";

export function matchesProjectFilters(project: ProjectView, text: string, selectedTags: string[]) {
  const normalizedText = text.trim().toLocaleLowerCase();
  const textMatches = !normalizedText || `${project.name} ${project.description}`.toLocaleLowerCase().includes(normalizedText);
  return textMatches && selectedTags.every((tag) => project.tags.includes(tag));
}

export interface ProjectListPageProps {
  facade?: ProjectFacade;
}

export function ProjectListPage({ facade = unavailableProjectFacade }: ProjectListPageProps) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectView[]>();
  const [error, setError] = useState(false);
  const [text, setText] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectView>();
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    void facade.list().then((value) => { if (active) setProjects(value); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [facade]);

  const tags = useMemo(() => Array.from(new Set(projects?.flatMap((project) => project.tags) ?? [])).sort(), [projects]);
  const visibleProjects = useMemo(() => projects?.filter((project) => matchesProjectFilters(project, text, selectedTags)) ?? [], [projects, selectedTags, text]);

  if (error) return <DataState message={t("projects.unavailable")} state="unavailable" />;
  if (!projects) return <DataState message={t("projects.loading")} state="loading" />;

  return (
    <div className="sh-project-list">
      <header className="sh-project-list__header">
        <div><p className="sh-project-eyebrow">{t("projects.eyebrow")}</p><h1>{t("projects.title")}</h1><p>{t("projects.description")}</p></div>
      </header>
      <section className="sh-project-list__filters" aria-label={t("projects.filters.label")}>
        <label><span>{t("projects.filters.search")}</span><input aria-label={t("projects.filters.search")} onChange={(event) => setText(event.currentTarget.value)} value={text} /></label>
        <fieldset><legend>{t("projects.filters.tags")}</legend><div>{tags.map((tag) => <label key={tag}><input aria-label={tag} checked={selectedTags.includes(tag)} onChange={() => setSelectedTags((current) => current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag])} type="checkbox" />{tag}</label>)}</div></fieldset>
      </section>
      <ul className="sh-project-list__items">
        {visibleProjects.map((project) => <li key={project.id}><Button aria-label={project.name} onClick={(event) => { triggerRef.current = event.currentTarget; setSelectedProject(project); }} variant="ghost"><span>{project.name}</span><small>{project.tags.join(" · ")}</small></Button></li>)}
      </ul>
      {!visibleProjects.length ? <p role="status">{t("projects.empty")}</p> : null}
      <ProjectQuickDrawer onClose={() => setSelectedProject(undefined)} open={Boolean(selectedProject)} project={selectedProject} returnFocusRef={triggerRef} />
    </div>
  );
}
