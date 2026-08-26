import { useTranslation } from "react-i18next";
import type { SkillRequirementFact } from "./api";

export function RequirementsPanel({ requirements }: { requirements: SkillRequirementFact[] }) {
  const { t } = useTranslation();
  return (
    <div className="sh-detail-requirements">
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
