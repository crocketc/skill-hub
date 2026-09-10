import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { RemovalChoice, RemovalImpact } from "./api";
import { RemovalShell } from "./RemovalShell";

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
  // QA-001：二次点击确认取代 FORCE DELETE 文本输入——第一次点击
  // 只改变按钮文案要求再次确认，第二次点击才真正提交。
  const [armed, setArmed] = useState(false);
  const complete = impacts.every((impact) => impact.deployments.every((deployment) => choices[impact.operationId ?? ""]?.[deployment.id]));
  const count = impacts.length;
  const confirmChoices = () => {
    void onConfirm(Object.fromEntries(
      impacts.map((impact) => [impact.operationId ?? "", choices[impact.operationId ?? ""] ?? {}]),
    ));
  };

  return (
    <RemovalShell
      eyebrow={t("removal.batch.eyebrow")}
      footer={
        <>
          <div className="sh-removal-flow__actions-group">
            <Button disabled={submitting} onClick={onCancel} variant="secondary">{t("actions.cancel")}</Button>
          </div>
          <div className="sh-removal-flow__actions-group sh-removal-flow__actions-group--primary">
            {/* 非原子批量风险提示紧邻提交动作，与危险主操作同处一行。 */}
            <small className="sh-removal-flow__risk">{t("removal.batch.nonAtomicNotice")}</small>
            {armed ? (
              <Button
                disabled={submitting}
                onClick={confirmChoices}
                size="lg"
                variant="danger"
              >
                {t("removal.batch.armConfirm", { count })}
              </Button>
            ) : (
              <Button disabled={!complete || submitting} onClick={() => setArmed(true)} size="lg" variant="danger">
                {t("removal.batch.continue")}
              </Button>
            )}
          </div>
        </>
      }
      status={submitting ? { kind: "info", text: t("removal.batch.busy", { count }) } : null}
      title={t("removal.batch.heading")}
    >
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
          {/* QA-001：完整影响矩阵逐项提示；未知外部内容只提示、不修改。 */}
          {impact.declaredDependencies.length > 0 ? (
            <p className="sh-notice">
              {`${t("removal.batch.impact.declaredDependencies")}: ${impact.declaredDependencies.join(", ")}`}
            </p>
          ) : null}
          {impact.combinations.length > 0 ? (
            <p className="sh-notice">
              {`${t("removal.batch.impact.combinations")}: ${impact.combinations.join(", ")}`}
            </p>
          ) : null}
          {impact.pinnedVersions.length > 0 ? (
            <p className="sh-notice">
              {t("removal.batch.impact.pinnedVersions", { count: impact.pinnedVersions.length })}
            </p>
          ) : null}
          {impact.relatedSkills.length > 0 ? (
            <p className="sh-notice">
              {`${t("removal.batch.impact.relatedSkills")}: ${impact.relatedSkills.join(", ")}`}
            </p>
          ) : null}
          {impact.unknownExternalReferences.length > 0 ? (
            <p className="sh-notice">
              {`${t("removal.batch.impact.unknownExternalReferences")}: ${impact.unknownExternalReferences.join(", ")}`}
            </p>
          ) : null}
        </section>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </RemovalShell>
  );
}
