import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Drawer } from "../../ui/Drawer";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Input } from "../../ui/Input";
import { StatusBadge } from "../../ui/StatusBadge";
import { projectAccessTone } from "./ProjectAccessPanel";
import type { ProjectAccessFact, ProjectFacade, ProjectNextStep, ProjectView } from "./api";

export interface ProjectQuickDrawerProps {
  /** Same-source access fact as the card (undefined until facts are loaded). */
  accessState?: ProjectAccessFact;
  /** Same-source next-step rule as the card. */
  nextStep?: ProjectNextStep;
  /**
   * Edit contract over the existing update_project / set_project_tags
   * commands. Without a facade the drawer stays read-only (no fake edit).
   */
  facade?: ProjectFacade;
  /** Receives the saved project so the host list can update in place. */
  onProjectChanged?: (project: ProjectView) => void;
  project?: ProjectView;
  open: boolean;
  onClose: () => void;
  onOpenProject?: (projectId: string) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function ProjectQuickDrawer({ project, open, accessState, nextStep, facade, onProjectChanged, onClose, onOpenProject, returnFocusRef }: ProjectQuickDrawerProps) {
  const { t } = useTranslation();
  const translate = (key: string, options?: Record<string, unknown>) => String(t(key as never, options as never));
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editError, setEditError] = useState<string>();
  const [tagsError, setTagsError] = useState<string>();

  if (!project) return null;

  const startEdit = () => {
    setDraftName(project.name);
    setDraftNote(project.description);
    setDraftTags(project.tags.join(", "));
    setSaved(false);
    setEditError(undefined);
    setTagsError(undefined);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setEditError(undefined);
    setTagsError(undefined);
  };
  const saveEdit = async () => {
    if (!facade || !draftName.trim() || saving) return;
    setSaving(true);
    setSaved(false);
    setEditError(undefined);
    setTagsError(undefined);
    try {
      const withDetails = await facade.updateDetails(project.id, { name: draftName.trim(), note: draftNote });
      const nextTags = draftTags.split(",").map((tag) => tag.trim()).filter(Boolean);
      try {
        const withTags = await facade.setTags(project.id, nextTags);
        setEditing(false);
        setSaved(true);
        onProjectChanged?.({ ...withDetails, tags: withTags.tags });
      } catch (reason) {
        // Details landed, tags did not: keep the form open so tags can be
        // retried, and still report the saved details to the host list.
        setTagsError(describeNativeError(reason, translate, "projects.drawer.tagsFailed"));
        onProjectChanged?.(withDetails);
      }
    } catch (reason) {
      setEditError(describeNativeError(reason, translate, "projects.drawer.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const nextStepText = nextStep ? (nextStep.kind === "resolve_conflicts" ? t("projects.card.nextStep.resolve_conflicts", { count: nextStep.conflicts }) : t(`projects.card.nextStep.${nextStep.kind}`)) : undefined;
  return (
    <Drawer
      description={project.description}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      open={open}
      returnFocusRef={returnFocusRef ?? { current: null }}
      title={project.name}
    >
      {editing ? (
        <div className="sh-project-drawer__edit">
          <Field label={t("projects.registration.name")}>
            <Input
              autoComplete="off"
              disabled={saving}
              name="project-drawer-name"
              onChange={(event) => setDraftName(event.currentTarget.value)}
              value={draftName}
            />
          </Field>
          <Field label={t("projects.drawer.note")}>
            <Input
              autoComplete="off"
              disabled={saving}
              name="project-drawer-note"
              onChange={(event) => setDraftNote(event.currentTarget.value)}
              value={draftNote}
            />
          </Field>
          <Field help={t("projects.registration.tagsHint")} label={t("projects.filters.tags")}>
            <Input
              autoComplete="off"
              disabled={saving}
              name="project-drawer-tags"
              onChange={(event) => setDraftTags(event.currentTarget.value)}
              value={draftTags}
            />
          </Field>
          {editError ? <p className="sh-project-registration__preview-error" role="alert">{editError}</p> : null}
          {tagsError ? <p className="sh-project-registration__preview-error" role="alert">{tagsError}</p> : null}
          <div className="sh-project-drawer__edit-actions">
            <Button disabled={saving} onClick={() => cancelEdit()} variant="ghost">{t("actions.cancel")}</Button>
            <Button disabled={saving || !draftName.trim()} loading={saving} onClick={() => void saveEdit()}>{t("projects.drawer.save")}</Button>
          </div>
        </div>
      ) : (
        <>
          <dl className="sh-project-drawer__facts">
            <div><dt>{t("projects.drawer.identity")}</dt><dd>{project.sharedConfig.identityHint}</dd></div>
            {accessState ? (
              <div><dt>{t("projects.drawer.access")}</dt><dd><StatusBadge tone={accessState === "unknown" ? "neutral" : projectAccessTone[accessState]}>{t(`projects.card.access.${accessState}`)}</StatusBadge></dd></div>
            ) : null}
            <div><dt>{t("projects.drawer.agents")}</dt><dd>{t("projects.card.agentCount", { count: project.agentIds.length })}</dd></div>
            <div><dt>{t("projects.drawer.tags")}</dt><dd>{project.tags.join(" · ")}</dd></div>
            <div><dt>{t("projects.drawer.targets")}</dt><dd>{project.sharedConfig.targetIds.join(" · ")}</dd></div>
            {nextStepText ? <div><dt>{t("projects.card.nextStep.label")}</dt><dd>{nextStepText}</dd></div> : null}
          </dl>
          {saved ? <p aria-live="polite" role="status">{t("projects.drawer.saved")}</p> : null}
          <div className="sh-project-drawer__actions">
            {facade ? <Button onClick={() => startEdit()} variant="secondary">{t("projects.drawer.edit")}</Button> : null}
            {onOpenProject ? <Button onClick={() => onOpenProject(project.id)} variant="secondary">{t("projects.drawer.manage")}</Button> : null}
          </div>
        </>
      )}
    </Drawer>
  );
}
