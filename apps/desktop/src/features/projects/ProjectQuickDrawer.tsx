import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Drawer } from "../../ui/Drawer";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { projectAccessTone } from "./ProjectAccessPanel";
import type { ProjectAccessFact, ProjectNextStep, ProjectView } from "./api";

export interface ProjectQuickDrawerProps {
  /** Same-source access fact as the card (undefined until facts are loaded). */
  accessState?: ProjectAccessFact;
  /** Same-source next-step rule as the card. */
  nextStep?: ProjectNextStep;
  project?: ProjectView;
  open: boolean;
  onClose: () => void;
  onOpenProject?: (projectId: string) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function ProjectQuickDrawer({ project, open, accessState, nextStep, onClose, onOpenProject, returnFocusRef }: ProjectQuickDrawerProps) {
  const { t } = useTranslation();
  if (!project) return null;
  return (
    <Drawer
      description={project.description}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      open={open}
      returnFocusRef={returnFocusRef ?? { current: null }}
      title={project.name}
    >
      <dl className="sh-project-drawer__facts">
        <div><dt>{t("projects.drawer.identity")}</dt><dd>{project.sharedConfig.identityHint}</dd></div>
        {accessState ? (
          <div><dt>{t("projects.drawer.access")}</dt><dd><StatusBadge tone={accessState === "unknown" ? "neutral" : projectAccessTone[accessState]}>{t(`projects.card.access.${accessState}`)}</StatusBadge></dd></div>
        ) : null}
        <div><dt>{t("projects.drawer.agents")}</dt><dd>{t("projects.card.agentCount", { count: project.agentIds.length })}</dd></div>
        <div><dt>{t("projects.drawer.tags")}</dt><dd>{project.tags.join(" · ")}</dd></div>
        <div><dt>{t("projects.drawer.targets")}</dt><dd>{project.sharedConfig.targetIds.join(" · ")}</dd></div>
        {nextStep ? <div><dt>{t("projects.card.nextStep.label")}</dt><dd>{nextStep.kind === "resolve_conflicts" ? t("projects.card.nextStep.resolve_conflicts", { count: nextStep.conflicts }) : t(`projects.card.nextStep.${nextStep.kind}`)}</dd></div> : null}
      </dl>
      {onOpenProject ? <Button onClick={() => onOpenProject(project.id)} variant="secondary">{t("projects.drawer.manage")}</Button> : null}
    </Drawer>
  );
}
