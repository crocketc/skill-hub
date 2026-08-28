import { useTranslation } from "react-i18next";
import type { SkillRequirementFact } from "./api";

interface RequirementsPanelProps {
  invocation?: string;
  requirements: SkillRequirementFact[];
}

export function RequirementsPanel({ invocation, requirements }: RequirementsPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="sh-detail-requirements">
      <section className="sh-detail-requirements__invocation">
        <h3>{t("skillDetail.requirements.invocation")}</h3>
        <p>{invocation || t("skillDetail.requirements.empty")}</p>
      </section>
      {requirements.map((requirement) => (
        <article key={requirement.id}>
          <h3>{requirement.name}</h3>
          <p>{requirement.declaration}</p>
          <p>{t("skillDetail.requirements.declaredOnly")}</p>
        </article>
      ))}
    </div>
  );
}
