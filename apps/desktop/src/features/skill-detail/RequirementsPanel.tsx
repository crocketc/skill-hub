import { useTranslation } from "react-i18next";
import { InvocationBadge } from "../skills/InvocationBadge";
import type { InvocationPolicy } from "../skills/api";
import type { SkillRequirementFact } from "./api";

interface RequirementsPanelProps {
  invocationPolicy?: InvocationPolicy;
  requirements: SkillRequirementFact[];
}

export function RequirementsPanel({ invocationPolicy, requirements }: RequirementsPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="sh-detail-requirements">
      <section className="sh-detail-requirements__invocation">
        <h3>{t("skillDetail.requirements.invocation")}</h3>
        <p><InvocationBadge policy={invocationPolicy} /></p>
      </section>
      {requirements.length > 0 ? requirements.map((requirement) => (
        <article key={requirement.id}>
          <h3>{requirement.name}</h3>
          <p>{requirement.declaration}</p>
          <p>{t("skillDetail.requirements.declaredOnly")}</p>
        </article>
      )) : (
        <p role="status">{t("skillDetail.requirements.empty")}</p>
      )}
    </div>
  );
}
