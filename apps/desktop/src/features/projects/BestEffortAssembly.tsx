import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import type { ProjectAssemblyItem, ProjectAssemblyStatus } from "./api";

export interface BestEffortAssemblyProps {
  items: ProjectAssemblyItem[];
}

const tone: Record<ProjectAssemblyStatus, "success" | "neutral" | "warning" | "danger"> = {
  satisfied: "success",
  skipped: "neutral",
  conflict: "warning",
  failed: "danger",
};

export function BestEffortAssembly({ items }: BestEffortAssemblyProps) {
  const { t } = useTranslation();
  const mixed = new Set(items.map((item) => item.status)).size > 1;
  return (
    <section className="sh-project-detail__panel" aria-labelledby="assembly-title">
      <div className="sh-project-section-heading"><div><p className="sh-project-eyebrow">{t("projects.assembly.eyebrow")}</p><h2 id="assembly-title">{t("projects.assembly.title")}</h2></div><span>{t(mixed ? "projects.assembly.bestEffort" : "projects.assembly.singleState")}</span></div>
      <ul className="sh-project-assembly__list">
        {items.map((item) => <li className="sh-project-assembly__item" key={item.skillId}><div><strong>{item.skillName}</strong><p>{item.message}</p></div><StatusBadge tone={tone[item.status]}>{t(`projects.assembly.status.${item.status}`)}</StatusBadge></li>)}
      </ul>
    </section>
  );
}
