import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { RemovalChoice, RemovalImpact } from "./api";

export function RemovalImpactDialog({ impact, onConfirm }: { impact: RemovalImpact; onConfirm: (choices: Record<string, RemovalChoice>) => void }) {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<Record<string, RemovalChoice>>({});
  const complete = impact.deployments.every((deployment) => choices[deployment.id]);
  return (
    <section aria-labelledby="removal-impact-heading" className="sh-workflow-card sh-removal-impact">
      <p className="sh-eyebrow">{t("removal.eyebrow")}</p>
      <h2 id="removal-impact-heading">{t("removal.heading", { name: impact.skillName })}</h2>
      <p>{t("removal.description")}</p>
      {impact.dependentProjects.length > 0 ? <p className="sh-notice">{t("removal.dependents", { projects: impact.dependentProjects.join(", ") })}</p> : null}
      <div className="sh-workflow-list">
        {impact.deployments.map((deployment) => (
          <label className="sh-workflow-list__item" key={deployment.id}>
            <span><strong>{deployment.label}</strong><small>{deployment.path}</small></span>
            <select aria-label={`${t("removal.choiceLabel")}：${deployment.label}`} value={choices[deployment.id] ?? ""} onChange={(event) => setChoices((current) => ({ ...current, [deployment.id]: event.target.value as RemovalChoice }))}>
              <option value="">{t("removal.choose")}</option>
              <option value="keep_deployed">{t("removal.choices.keep")}</option>
              <option value="remove_deployment">{t("removal.choices.remove")}</option>
              <option value="convert_to_copy">{t("removal.choices.convert")}</option>
            </select>
          </label>
        ))}
      </div>
      <div className="sh-workflow-actions"><Button disabled={!complete} onClick={() => onConfirm(choices)} variant="danger">{t("removal.confirm")}</Button></div>
    </section>
  );
}
