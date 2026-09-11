import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { desktopDirectoryPicker, normalizeWindowsPath, type DirectoryPicker } from "../../platform/directoryPicker";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { CheckboxField } from "../../ui/CheckboxField";
import { DataState } from "../../ui/DataState";
import { Drawer } from "../../ui/Drawer";
import { Field } from "../../ui/Field";
import { Input } from "../../ui/Input";
import { PageHeader } from "../../ui/PageHeader";
import { StatusBadge } from "../../ui/StatusBadge";
import { projectAccessTone } from "./ProjectAccessPanel";
import { ProjectQuickDrawer } from "./ProjectQuickDrawer";
import {
  resolveProjectAccessState,
  resolveProjectNextStep,
  sortSkillCandidatesByTraceAffinity,
  type ProjectAccessFact,
  type ProjectAgentCandidate,
  type ProjectDirectoryPreview,
  type ProjectFacade,
  type ProjectNextStep,
  type ProjectPhysicalTargetView,
  type ProjectView,
  unavailableProjectFacade,
} from "./api";
import "./projects.css";

export function matchesProjectFilters(project: ProjectView, text: string, selectedTags: string[]) {
  const normalizedText = text.trim().toLocaleLowerCase();
  const textMatches = !normalizedText || `${project.name} ${project.description}`.toLocaleLowerCase().includes(normalizedText);
  return textMatches && selectedTags.every((tag) => project.tags.includes(tag));
}

export interface ProjectListPageProps {
  directoryPicker?: DirectoryPicker;
  facade?: ProjectFacade;
  onOpenProject?: (projectId: string) => void;
}

function inferredProjectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function newProjectId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `project-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Registration tags are optional, comma separated, trimmed and deduplicated. */
export function parseRegistrationTags(input: string): string[] {
  return [...new Set(input.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
}

export function ProjectListPage({
  directoryPicker = desktopDirectoryPicker,
  facade = unavailableProjectFacade,
  onOpenProject,
}: ProjectListPageProps) {
  const { t } = useTranslation();
  const translate = (key: string, options?: Record<string, unknown>) => String(t(key as never, options as never));
  const [projects, setProjects] = useState<ProjectView[]>();
  const [error, setError] = useState(false);
  const [text, setText] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectView>();
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [registrationPath, setRegistrationPath] = useState("");
  const [registrationName, setRegistrationName] = useState("");
  const [registrationTags, setRegistrationTags] = useState("");
  const [registrationError, setRegistrationError] = useState<string>();
  const [registeredProject, setRegisteredProject] = useState<ProjectView>();
  const [tagsError, setTagsError] = useState<string>();
  const [registering, setRegistering] = useState(false);
  const [agentCandidates, setAgentCandidates] = useState<ProjectAgentCandidate[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<ProjectDirectoryPreview>();
  const [previewPending, setPreviewPending] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [targets, setTargets] = useState<ProjectPhysicalTargetView[]>();
  const [targetsFailed, setTargetsFailed] = useState(false);
  const [plans, setPlans] = useState<Record<string, Awaited<ReturnType<ProjectFacade["getAssemblyPlan"]>>>>({});
  const quickDrawerTriggerRef = useRef<HTMLElement | null>(null);
  const registrationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const registeringRef = useRef(false);

  useEffect(() => {
    let active = true;
    void facade.list().then((value) => { if (active) setProjects(value); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [facade, revision]);

  // Card facts come from existing queries only: one discovery snapshot for the
  // access states, and the stored assembly plan per project for next-step
  // guidance. A failed per-project plan query keeps that card's guidance
  // hidden instead of guessing; the detail page reports plan errors.
  useEffect(() => {
    if (!projects) return;
    let active = true;
    setTargets(undefined);
    setTargetsFailed(false);
    setPlans({});
    void facade.listPhysicalTargets().then((value) => {
      if (active) setTargets(value);
    }).catch(() => { if (active) setTargetsFailed(true); });
    for (const project of projects) {
      void facade.getAssemblyPlan(project.id).then((plan) => {
        if (active) setPlans((current) => ({ ...current, [project.id]: plan }));
      }).catch(() => { /* no plan facts: no next-step claim on the card */ });
    }
    return () => { active = false; };
  }, [facade, projects]);

  const tags = useMemo(() => Array.from(new Set(projects?.flatMap((project) => project.tags) ?? [])).sort(), [projects]);
  const visibleProjects = useMemo(() => projects?.filter((project) => matchesProjectFilters(project, text, selectedTags)) ?? [], [projects, selectedTags, text]);

  const resetPreview = () => {
    setPreview(undefined);
    setPreviewPending(false);
    setPreviewFailed(false);
  };

  const closeRegistration = () => {
    setRegistrationOpen(false);
    setRegisteredProject(undefined);
    setTagsError(undefined);
    resetPreview();
  };

  const chooseDirectory = async () => {
    setRegistrationError(undefined);
    try {
      const path = await directoryPicker.pickDirectory();
      if (!path) return;
      const normalized = normalizeWindowsPath(path);
      setRegistrationPath(normalized);
      setRegistrationName(inferredProjectName(normalized));
      resetPreview();
      setPreviewPending(true);
      try {
        const result = await facade.previewDirectory(normalized);
        setPreview(result);
        const tracedLabels = new Set(result.agentTraces.map((trace) => trace.label));
        setSelectedAgentIds((current) => [
          ...new Set([
            ...current,
            ...agentCandidates
              .filter((candidate) => tracedLabels.has(candidate.label))
              .map((candidate) => candidate.id),
          ]),
        ]);
      } catch {
        setPreviewFailed(true);
      } finally {
        setPreviewPending(false);
      }
    } catch (reason) {
      setRegistrationError(reason instanceof Error ? reason.message : t("projects.registration.pickFailed"));
    }
  };

  const registerProject = async () => {
    if (!registrationPath.trim() || !registrationName.trim() || previewPending || previewFailed || !preview) return;
    // Synchronous re-entry guard: rapid double activation must not register twice.
    if (registeringRef.current) return;
    registeringRef.current = true;
    setRegistering(true);
    setRegistrationError(undefined);
    setTagsError(undefined);
    try {
      const registered = await facade.register({
        id: newProjectId(),
        name: registrationName.trim(),
        path: registrationPath,
        tags: [], agentIds: selectedAgentIds,
      });
      // Tags ride on the existing set_project_tags command after the
      // registration itself; a tag failure never rolls back the project.
      const nextTags = parseRegistrationTags(registrationTags);
      if (nextTags.length) {
        try {
          await facade.setTags(registered.id, nextTags);
        } catch (reason) {
          setTagsError(describeNativeError(reason, translate, "projects.registration.tagsFailed"));
        }
      }
      setRegisteredProject(registered);
      setRegistrationPath("");
      setRegistrationName("");
      setRegistrationTags("");
      setSelectedAgentIds([]);
      resetPreview();
      setRevision((current) => current + 1);
    } catch (reason) {
      setRegistrationError(describeNativeError(reason, translate, "projects.registration.failed"));
    } finally {
      registeringRef.current = false;
      setRegistering(false);
    }
  };

  if (error) return <DataState message={t("projects.unavailable")} state="unavailable" />;
  if (!projects) return <DataState message={t("projects.loading")} state="loading" />;

  // One facts helper keeps the card and the quick drawer on the same source:
  // same access state, same next-step rule, same wording.
  const projectFacts = (project: ProjectView): { accessState: ProjectAccessFact | undefined; nextStep: ProjectNextStep | undefined } => {
    const accessState: ProjectAccessFact | undefined = targetsFailed
      ? "unknown"
      : targets
        ? resolveProjectAccessState(project.physicalId, targets)
        : undefined;
    const plan = plans[project.id];
    return {
      accessState,
      nextStep: plan !== undefined ? resolveProjectNextStep(accessState ?? "unknown", plan) : undefined,
    };
  };
  const nextStepLabel = (nextStep: ProjectNextStep) => (
    nextStep.kind === "resolve_conflicts" ? t("projects.card.nextStep.resolve_conflicts", { count: nextStep.conflicts }) : t(`projects.card.nextStep.${nextStep.kind}`)
  );

  return (
    <div className="sh-projects-page">
      <PageHeader
        actions={(
          <Button
            onClick={() => { setRegistrationError(undefined); setRegisteredProject(undefined); setTagsError(undefined); setRegistrationOpen(true); void facade.listAgentCandidates().then(setAgentCandidates).catch(() => setAgentCandidates([])); }}
            ref={registrationTriggerRef}
            variant="secondary"
          >
            {t("projects.actions.register")}
          </Button>
        )}
        description={t("projects.description")}
        headingLevel="h1"
        title={t("projects.title")}
      />
      <Drawer
        closeLabel={t("actions.close")}
        description={t("projects.registration.description")}
        onOpenChange={(open) => { if (!open) closeRegistration(); }}
        open={registrationOpen}
        returnFocusRef={registrationTriggerRef}
        title={t("projects.registration.title")}
      >
        {registrationOpen && registeredProject ? (
          <div className="sh-project-registration__success">
            <p aria-live="polite" role="status"><strong>{t("projects.registration.success.title")}</strong></p>
            <p>{t("projects.registration.success.detail", { name: registeredProject.name })}</p>
            {tagsError ? <p className="sh-project-registration__preview-error" role="alert">{tagsError}</p> : null}
            <div className="sh-project-registration__actions">
              {onOpenProject ? (
                <Button
                  onClick={() => { const projectId = registeredProject.id; closeRegistration(); onOpenProject(projectId); }}
                  variant="secondary"
                >
                  {t("projects.registration.success.openDetail")}
                </Button>
              ) : null}
              <Button onClick={() => closeRegistration()}>{t("projects.registration.success.finish")}</Button>
            </div>
          </div>
        ) : null}
        {registrationOpen && !registeredProject ? (
          <div className="sh-project-registration">
            <Button disabled={registering} onClick={() => void chooseDirectory()} variant="secondary">{t("projects.registration.pickDirectory")}</Button>
            {registrationPath ? <p className="sh-project-registration__path">{registrationPath}</p> : null}
            {previewPending ? <p role="status">{t("projects.registration.preview.loading")}</p> : null}
            {previewFailed ? <p className="sh-project-registration__preview-error" role="alert">{t("projects.registration.preview.error")}</p> : null}
            {preview ? (
              <section aria-labelledby="project-preview-heading" className="sh-project-registration__preview">
                <h3 id="project-preview-heading">{t("projects.registration.preview.title")}</h3>
                <p>{t("projects.registration.preview.boundary")}</p>
                <h4>{t("projects.registration.preview.agents")}</h4>
                {preview.agentTraces.length ? (
                  <ul>
                    {preview.agentTraces.map((trace) => <li key={trace.targetId}><strong>{trace.label}</strong><small>{trace.path}</small></li>)}
                  </ul>
                ) : <p>{t("projects.registration.preview.agentsEmpty")}</p>}
                <h4 title={t("projects.registration.preview.skillsSortHint")}>{t("projects.registration.preview.skills")}</h4>
                {preview.skillCandidates.length ? (
                  <ul aria-label={t("projects.registration.preview.skills")}>
                    {sortSkillCandidatesByTraceAffinity(preview.skillCandidates, preview.agentTraces).map((candidate) => <li key={candidate.path}>{candidate.name}<small>{candidate.path}</small></li>)}
                  </ul>
                ) : <p>{t("projects.registration.preview.skillsEmpty")}</p>}
              </section>
            ) : null}
            <Field label={t("projects.registration.name")}>
              <Input
                autoComplete="off"
                disabled={registering}
                name="project-registration-name"
                onChange={(event) => setRegistrationName(event.currentTarget.value)}
                value={registrationName}
              />
            </Field>
            <Field help={t("projects.registration.tagsHint")} label={t("projects.registration.tags")}>
              <Input
                autoComplete="off"
                disabled={registering}
                name="project-registration-tags"
                onChange={(event) => setRegistrationTags(event.currentTarget.value)}
                value={registrationTags}
              />
            </Field>
            {agentCandidates.length ? (
              <fieldset><legend>{t("projects.registration.agents")}</legend>{agentCandidates.map((agent) => <CheckboxField key={agent.id} checked={selectedAgentIds.includes(agent.id)} disabled={registering || !agent.available} label={agent.label} onChange={() => setSelectedAgentIds((current) => current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id])} />)}</fieldset>
            ) : null}
            {registrationError ? <p aria-live="polite" role="status">{registrationError}</p> : null}
            <div className="sh-project-registration__actions">
              <Button disabled={registering} onClick={() => closeRegistration()} variant="ghost">{t("actions.cancel")}</Button>
              <Button disabled={registering || previewPending || previewFailed || !preview || !registrationPath.trim() || !registrationName.trim()} loading={registering} onClick={() => void registerProject()}>{t("projects.registration.confirm")}</Button>
            </div>
          </div>
        ) : null}
      </Drawer>
      <section className="sh-projects-page__filters" aria-label={t("projects.filters.label")}>
        <Field label={t("projects.filters.search")}>
          <Input
            autoComplete="off"
            name="project-search"
            onChange={(event) => setText(event.currentTarget.value)}
            value={text}
          />
        </Field>
        <fieldset><legend>{t("projects.filters.tags")}</legend><div>{tags.map((tag) => <CheckboxField key={tag} checked={selectedTags.includes(tag)} label={tag} onChange={() => setSelectedTags((current) => current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag])} />)}</div></fieldset>
      </section>
      <ul className="sh-projects-page__cards">
        {visibleProjects.map((project) => {
          const { accessState, nextStep } = projectFacts(project);
          return (
            <li className="sh-project-card" key={project.id}>
              <Button
                className="sh-project-card__title"
                onClick={(event) => { quickDrawerTriggerRef.current = event.currentTarget; setSelectedProject(project); }}
                variant="ghost"
              >
                {project.name}
              </Button>
              {project.description ? <p className="sh-project-card__description">{project.description}</p> : null}
              <code className="sh-project-card__path">{project.devicePath}</code>
              {accessState ? (
                <p className="sh-project-card__meta">
                  <StatusBadge tone={accessState === "unknown" ? "neutral" : projectAccessTone[accessState]}>{t(`projects.card.access.${accessState}`)}</StatusBadge>
                  <span className="sh-project-card__agents">{t("projects.card.agentCount", { count: project.agentIds.length })}</span>
                </p>
              ) : null}
              {project.tags.length ? <ul className="sh-project-card__tags" aria-label={t("projects.filters.tags")}>{project.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul> : null}
              {nextStep ? (onOpenProject ? (
                <Button className="sh-project-card__next" onClick={() => onOpenProject(project.id)} size="sm" variant="secondary">
                  {nextStepLabel(nextStep)}
                </Button>
              ) : (
                <p className="sh-project-card__next">{nextStepLabel(nextStep)}</p>
              )) : null}
            </li>
          );
        })}
      </ul>
      {!visibleProjects.length ? <DataState message={t("projects.empty")} state="empty" /> : null}
      <ProjectQuickDrawer
        accessState={selectedProject ? projectFacts(selectedProject).accessState : undefined}
        nextStep={selectedProject ? projectFacts(selectedProject).nextStep : undefined}
        onClose={() => setSelectedProject(undefined)}
        onOpenProject={onOpenProject}
        open={Boolean(selectedProject)}
        project={selectedProject}
        returnFocusRef={quickDrawerTriggerRef}
      />
    </div>
  );
}
