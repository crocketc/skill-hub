import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { RemovalChoice, RemovalImpact } from "./api";
import { RemovalShell } from "./RemovalShell";

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
    <RemovalShell
      eyebrow={t("removal.eyebrow")}
      footer={
        <>
          {onCancel ? (
            <div className="sh-removal-flow__actions-group">
              <Button disabled={submitting} onClick={onCancel} variant="secondary">{t("actions.cancel")}</Button>
            </div>
          ) : null}
          <div className="sh-removal-flow__actions-group sh-removal-flow__actions-group--primary">
            <Button
              disabled={!complete || submitting}
              onClick={() => void onConfirm(choices)}
              size="lg"
              variant="danger"
            >
              {submitting ? t("removal.submitting") : t("removal.confirm")}
            </Button>
          </div>
        </>
      }
      status={submitting ? { kind: "info", text: t("removal.submitting") } : null}
      title={t("removal.heading", { name: impact.skillName })}
    >
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
    </RemovalShell>
  );
}
