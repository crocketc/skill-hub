import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { UndeployDecision, UndeployImpact } from "./api";
import { RemovalShell } from "./RemovalShell";

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
    <RemovalShell
      eyebrow={t("undeploy.eyebrow")}
      footer={
        <>
          <div className="sh-removal-flow__actions-group">
            <Button disabled={submitting} onClick={onCancel} variant="secondary">{t("actions.cancel")}</Button>
          </div>
          <div className="sh-removal-flow__actions-group sh-removal-flow__actions-group--primary">
            <Button
              disabled={!decision || submitting}
              onClick={() => decision && void onConfirm(decision)}
              size="lg"
              variant="danger"
            >
              {submitting ? t("undeploy.submitting") : t("undeploy.confirm")}
            </Button>
          </div>
        </>
      }
      status={submitting ? { kind: "info", text: t("undeploy.submitting") } : null}
      title={t("undeploy.heading", { target: impact.label })}
    >
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
      {/* P1-15：固定说明保留什么（库中 Skill 与其他关系）与恢复方式（重新部署）。 */}
      <div className="sh-removal-flow__disclaimer">
        <p>{t("undeploy.retained")}</p>
        <p>{t("undeploy.recovery")}</p>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </RemovalShell>
  );
}
