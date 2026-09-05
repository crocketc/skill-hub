import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { RemovalChoice, RemovalImpact } from "./api";

interface BatchRemovalImpactDialogProps {
  error?: string;
  impacts: RemovalImpact[];
  onCancel: () => void;
  onConfirm: (choices: Record<string, Record<string, RemovalChoice>>) => void | Promise<void>;
  submitting?: boolean;
}

export function BatchRemovalImpactDialog({
  error,
  impacts,
  onCancel,
  onConfirm,
  submitting = false,
}: BatchRemovalImpactDialogProps) {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<Record<string, Record<string, RemovalChoice>>>({});
  const [showForceConfirmation, setShowForceConfirmation] = useState(false);
  const [forceConfirmed, setForceConfirmed] = useState(false);
  const complete = impacts.every((impact) => impact.deployments.every((deployment) => choices[impact.operationId ?? ""]?.[deployment.id]));
  const count = impacts.length;

  if (showForceConfirmation) {
    return (
      <section aria-labelledby="batch-force-delete-title" className="sh-workflow-card sh-removal-impact" role="alertdialog">
        <p className="sh-eyebrow">{t("removal.batch.eyebrow")}</p>
        <h2 id="batch-force-delete-title">{t("removal.batch.forceTitle")}</h2>
        <p>{t("removal.batch.forceDescription", { count })}</p>
        <label className="sh-onboarding__check">
          {t("removal.batch.forceInputLabel")}
          <input
            aria-label={t("removal.batch.forceInputLabel")}
            onChange={(event) => setForceConfirmed(event.currentTarget.value === "FORCE DELETE")}
            type="text"
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <div className="sh-workflow-actions">
          <Button disabled={submitting} onClick={() => setShowForceConfirmation(false)} variant="secondary">{t("onboarding.back")}</Button>
          <Button
            disabled={!forceConfirmed || submitting}
            onClick={() => void onConfirm(Object.fromEntries(
              impacts.map((impact) => [impact.operationId ?? "", choices[impact.operationId ?? ""] ?? {}]),
            ))}
            variant="danger"
          >
            {submitting ? t("removal.submitting") : t("removal.batch.forceConfirm", { count })}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="batch-removal-impact-heading" className="sh-workflow-card sh-removal-impact" role="dialog">
      <p className="sh-eyebrow">{t("removal.batch.eyebrow")}</p>
      <h2 id="batch-removal-impact-heading">{t("removal.batch.heading")}</h2>
      <p>{t("removal.batch.description", { count })}</p>
      {impacts.map((impact) => (
        <section className="sh-removal-impact__skill" key={impact.operationId ?? impact.skillId}>
          <h3>{impact.skillName}</h3>
          {impact.dependentProjects.length > 0 ? <p className="sh-notice">{t("removal.dependents", { projects: impact.dependentProjects.join(", ") })}</p> : null}
          {impact.deployments.length === 0 ? <p>{t("removal.batch.noDeployments")}</p> : null}
          {impact.deployments.map((deployment) => (
            <label className="sh-workflow-list__item" key={deployment.id}>
              <span><strong>{deployment.label}</strong><small>{deployment.path}</small></span>
              <select
                aria-label={`${t("removal.choiceLabel")}: ${deployment.label}`}
                onChange={(event) => setChoices((current) => ({
                  ...current,
                  [impact.operationId ?? ""]: {
                    ...current[impact.operationId ?? ""],
                    [deployment.id]: event.target.value as RemovalChoice,
                  },
                }))}
                value={choices[impact.operationId ?? ""]?.[deployment.id] ?? ""}
              >
                <option value="">{t("removal.choose")}</option>
                <option value="keep_deployed">{t("removal.choices.keep")}</option>
                <option value="remove_deployment">{t("removal.choices.remove")}</option>
                <option value="convert_to_copy">{t("removal.choices.convert")}</option>
              </select>
            </label>
          ))}
        </section>
      ))}
      {error ? <p role="alert">{error}</p> : null}
      <div className="sh-workflow-actions">
        <Button disabled={submitting} onClick={onCancel} variant="secondary">{t("actions.cancel")}</Button>
        <Button disabled={!complete || submitting} onClick={() => setShowForceConfirmation(true)} variant="danger">
          {t("removal.batch.continue")}
        </Button>
      </div>
    </section>
  );
}
