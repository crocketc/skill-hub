import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import {
  resolveProjectAccessState,
  type ProjectAccessState,
  type ProjectPhysicalTargetView,
  type ProjectView,
} from "./api";

const accessTone: Record<ProjectAccessState, "danger" | "neutral" | "success" | "warning"> = {
  accessible: "success",
  inaccessible: "danger",
  read_only: "warning",
  untracked: "neutral",
};

export interface ProjectAccessPanelProps {
  project: ProjectView;
  snapshotFailed: boolean;
  targets: ProjectPhysicalTargetView[];
}

export function ProjectAccessPanel({ project, snapshotFailed, targets }: ProjectAccessPanelProps) {
  const { t } = useTranslation();
  const accessState = resolveProjectAccessState(project.physicalId, targets);
  const stateLabel = snapshotFailed
    ? t("projects.detail.access.states.unknown")
    : t(`projects.detail.access.states.${accessState}`);
  return (
    <section aria-labelledby="project-access-title" className="sh-project-detail__panel">
      <div className="sh-project-section-heading"><div><p className="sh-project-eyebrow">{t("projects.detail.access.eyebrow")}</p><h2 id="project-access-title">{t("projects.detail.access.title")}</h2></div></div>
      <dl className="sh-project-detail__facts">
        <div><dt>{t("projects.detail.access.path")}</dt><dd>{project.devicePath}</dd></div>
        <div><dt>{t("projects.detail.access.state")}</dt><dd><StatusBadge tone={accessTone[accessState]}>{stateLabel}</StatusBadge></dd></div>
      </dl>
      {accessState === "untracked" && !snapshotFailed ? <p role="status">{t("projects.detail.access.untrackedNote")}</p> : null}
      {snapshotFailed ? <p role="alert">{t("projects.detail.access.snapshotFailed")}</p> : null}
    </section>
  );
}
