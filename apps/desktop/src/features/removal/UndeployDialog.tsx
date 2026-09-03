import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { UndeployDecision, UndeployImpact } from "./api";

interface UndeployDialogProps {
  error?: string;
  impact: UndeployImpact;
  onCancel: () => void;
  onConfirm: (decision: UndeployDecision) => void | Promise<void>;
  submitting?: boolean;
}

export function UndeployDialog({
  error,
  impact,
  onCancel,
  onConfirm,
  submitting = false,
}: UndeployDialogProps) {
  const { t } = useTranslation();
  const [decision, setDecision] = useState<UndeployDecision | "">("");

  return (
    <section aria-labelledby="undeploy-heading" className="sh-workflow-card" role="dialog">
      <p className="sh-eyebrow">{t("undeploy.eyebrow")}</p>
      <h2 id="undeploy-heading">{t("undeploy.heading", { target: impact.label })}</h2>
      <p>{impact.sharedTarget ? t("undeploy.sharedNotice") : t("undeploy.description")}</p>
      <label>
        <span>{t("undeploy.choiceLabel")}</span>
        <select
          aria-label={t("undeploy.choiceLabel")}
          disabled={submitting}
          onChange={(event) => setDecision(event.target.value as UndeployDecision | "")}
          value={decision}
        >
          <option value="">{t("undeploy.choose")}</option>
          {impact.sharedTarget ? (
            <option value="keep_shared_deployment">{t("undeploy.choices.keepShared")}</option>
          ) : (
            <>
              <option value="remove_owned_target">{t("undeploy.choices.remove")}</option>
              <option value="remove_relation_only">{t("undeploy.choices.keepCopy")}</option>
            </>
          )}
        </select>
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="sh-workflow-actions">
        <Button disabled={submitting} onClick={onCancel} variant="secondary">{t("actions.cancel")}</Button>
        <Button
          disabled={!decision || submitting}
          onClick={() => decision && void onConfirm(decision)}
          variant="danger"
        >
          {submitting ? t("undeploy.submitting") : t("undeploy.confirm")}
        </Button>
      </div>
    </section>
  );
}
