import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Drawer } from "../../ui/Drawer";
import type { ProjectView } from "./api";

export interface ProjectQuickDrawerProps {
  project?: ProjectView;
  open: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function ProjectQuickDrawer({ project, open, onClose, returnFocusRef }: ProjectQuickDrawerProps) {
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
        <div><dt>{t("projects.drawer.tags")}</dt><dd>{project.tags.join(" · ")}</dd></div>
        <div><dt>{t("projects.drawer.targets")}</dt><dd>{project.sharedConfig.targetIds.join(" · ")}</dd></div>
      </dl>
    </Drawer>
  );
}
