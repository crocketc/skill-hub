import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { desktopDirectoryPicker, normalizeWindowsPath, type DirectoryPicker } from "../../platform/directoryPicker";
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
  directoryPicker?: DirectoryPicker;
  facade?: ProjectFacade;
}

function inferredProjectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function newProjectId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `project-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ProjectListPage({
  directoryPicker = desktopDirectoryPicker,
  facade = unavailableProjectFacade,
}: ProjectListPageProps) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectView[]>();
  const [error, setError] = useState(false);
  const [text, setText] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectView>();
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [registrationPath, setRegistrationPath] = useState("");
  const [registrationName, setRegistrationName] = useState("");
  const [registrationError, setRegistrationError] = useState<string>();
  const [registering, setRegistering] = useState(false);
  const [revision, setRevision] = useState(0);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    void facade.list().then((value) => { if (active) setProjects(value); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [facade, revision]);

  const tags = useMemo(() => Array.from(new Set(projects?.flatMap((project) => project.tags) ?? [])).sort(), [projects]);
  const visibleProjects = useMemo(() => projects?.filter((project) => matchesProjectFilters(project, text, selectedTags)) ?? [], [projects, selectedTags, text]);

  const chooseDirectory = async () => {
    setRegistrationError(undefined);
    try {
      const path = await directoryPicker.pickDirectory();
      if (!path) return;
      const normalized = normalizeWindowsPath(path);
      setRegistrationPath(normalized);
      setRegistrationName(inferredProjectName(normalized));
    } catch (reason) {
      setRegistrationError(reason instanceof Error ? reason.message : t("projects.registration.pickFailed"));
    }
  };

  const registerProject = async () => {
    if (!registrationPath.trim() || !registrationName.trim()) return;
    setRegistering(true);
    setRegistrationError(undefined);
    try {
      await facade.register({
        id: newProjectId(),
        name: registrationName.trim(),
        path: registrationPath,
        tags: [],
      });
      setRegistrationOpen(false);
      setRegistrationPath("");
      setRegistrationName("");
      setRevision((current) => current + 1);
    } catch (reason) {
      setRegistrationError(reason instanceof Error ? reason.message : t("projects.registration.failed"));
    } finally {
      setRegistering(false);
    }
  };

  if (error) return <DataState message={t("projects.unavailable")} state="unavailable" />;
  if (!projects) return <DataState message={t("projects.loading")} state="loading" />;

  return (
    <div className="sh-project-list">
      <header className="sh-project-list__header">
        <div><p className="sh-project-eyebrow">{t("projects.eyebrow")}</p><h1>{t("projects.title")}</h1><p>{t("projects.description")}</p></div>
        <Button onClick={() => { setRegistrationError(undefined); setRegistrationOpen(true); }} variant="secondary">{t("projects.actions.register")}</Button>
      </header>
      {registrationOpen ? (
        <section aria-labelledby="project-registration-heading" className="sh-project-registration">
          <div>
            <h2 id="project-registration-heading">{t("projects.registration.title")}</h2>
            <p>{t("projects.registration.description")}</p>
          </div>
          <Button disabled={registering} onClick={() => void chooseDirectory()} variant="secondary">{t("projects.registration.pickDirectory")}</Button>
          {registrationPath ? <p className="sh-project-registration__path">{registrationPath}</p> : null}
          <label><span>{t("projects.registration.name")}</span><input aria-label={t("projects.registration.name")} disabled={registering} onChange={(event) => setRegistrationName(event.currentTarget.value)} value={registrationName} /></label>
          {registrationError ? <p aria-live="polite" role="status">{registrationError}</p> : null}
          <div className="sh-project-registration__actions">
            <Button disabled={registering} onClick={() => setRegistrationOpen(false)} variant="ghost">{t("actions.cancel")}</Button>
            <Button disabled={registering || !registrationPath.trim() || !registrationName.trim()} loading={registering} onClick={() => void registerProject()}>{t("projects.registration.confirm")}</Button>
          </div>
        </section>
      ) : null}
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
