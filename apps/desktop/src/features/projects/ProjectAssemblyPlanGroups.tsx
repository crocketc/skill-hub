import { useTranslation } from "react-i18next";
import { groupAssemblyItems, type ProjectAssemblyPlanView } from "./api";

export interface ProjectAssemblyPlanGroupsProps {
  failed?: boolean;
  plan: ProjectAssemblyPlanView | null;
}

export function ProjectAssemblyPlanGroups({ failed = false, plan }: ProjectAssemblyPlanGroupsProps) {
  const { t } = useTranslation();
  const groups = plan ? groupAssemblyItems(plan.items) : [];
  return (
    <section aria-labelledby="assembly-plan-title" className="sh-project-detail__panel">
      <div className="sh-project-section-heading"><div><p className="sh-project-eyebrow">{t("projects.assemblyPlan.eyebrow")}</p><h2 id="assembly-plan-title">{t("projects.assemblyPlan.title")}</h2></div></div>
      {failed ? <p role="alert">{t("projects.assemblyPlan.unavailable")}</p> : null}
      {!failed && !plan ? <p role="status">{t("projects.assemblyPlan.empty")}</p> : null}
      {!failed && plan && !plan.items.length ? <p role="status">{t("projects.assemblyPlan.emptyItems")}</p> : null}
      {groups.map((group) => {
        const label = t(`projects.assemblyPlan.groups.${group.status}`);
        return (
          <div className="sh-project-assembly-plan__group" key={group.status}>
            <h3><span>{label}</span><span>{t("projects.assemblyPlan.groupCount", { count: group.items.length })}</span></h3>
            <ul aria-label={label}>
              {group.items.map((item, index) => <li key={`${item.skillId}-${index}`} title={item.reasons.join("；")}>{item.name}</li>)}
            </ul>
          </div>
        );
      })}
      <p className="sh-project-assembly-plan__note">{t("projects.assemblyPlan.detachNote")}</p>
    </section>
  );
}
