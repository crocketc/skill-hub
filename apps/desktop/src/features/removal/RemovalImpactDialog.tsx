import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { RemovalChoice, RemovalImpact } from "./api";

interface RemovalImpactDialogProps {
  error?: string;
  impact: RemovalImpact;
  onCancel?: () => void;
  onConfirm: (choices: Record<string, RemovalChoice>) => void | Promise<void>;
  submitting?: boolean;
}

export function RemovalImpactDialog({ error, impact, onCancel, onConfirm, submitting = false }: RemovalImpactDialogProps) {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<Record<string, RemovalChoice>>({});
  const complete = impact.deployments.every((deployment) => choices[deployment.id]);
  return (
    <section aria-labelledby="removal-impact-heading" className="sh-workflow-card sh-removal-impact" role="dialog">
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
      {error ? <p role="alert">{error}</p> : null}
      <div className="sh-workflow-actions">
        {onCancel ? <Button disabled={submitting} onClick={onCancel} variant="secondary">{t("actions.cancel")}</Button> : null}
        <Button disabled={!complete || submitting} onClick={() => void onConfirm(choices)} variant="danger">
          {submitting ? t("removal.submitting") : t("removal.confirm")}
        </Button>
      </div>
    </section>
  );
}
