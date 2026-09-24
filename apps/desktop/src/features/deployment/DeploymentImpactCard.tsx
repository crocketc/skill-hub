import { useTranslation } from "react-i18next";
import { displayPath } from "../../platform/displayPath";
import { DeploymentTargetPresentation } from "./DeploymentTargetPresentation";
import {
  type DeploymentPlanTarget,
  type DeploymentTarget,
  userFacingDeploymentMode,
  userFacingDeploymentWarning,
  isImplementationWarning,
  isModeDescriptionWarning,
} from "./api";

function conflictMessageKey(reason: string): string {
  switch (reason) {
    case "runtime_name_already_exists": return "deployment.plan.conflicts.runtimeNameExists";
    case "ownership_unknown": return "deployment.plan.conflicts.ownershipUnknown";
    case "managed_by_another_skill": return "deployment.plan.conflicts.managedByAnotherSkill";
    default: return "deployment.plan.conflicts.generic";
  }
}

type DeploymentImpactCardProps = {
  skillName?: string;
  skillId?: string;
  target: DeploymentPlanTarget;
  targets: DeploymentTarget[];
};

function targetEntries(target: DeploymentPlanTarget, targets: DeploymentTarget[]): DeploymentTarget[] {
  const ids = target.logicalTargetIds?.length ? target.logicalTargetIds : [target.targetId];
  const byId = new Map(targets.map((candidate) => [candidate.id, candidate]));
  return ids.map((id) => byId.get(id)).filter((candidate): candidate is DeploymentTarget => Boolean(candidate));
}

export function DeploymentImpactCard({ skillName, skillId, target, targets }: DeploymentImpactCardProps) {
  const { t } = useTranslation();
  const entries = targetEntries(target, targets);
  const fallbackTarget = targets.find((candidate) => candidate.id === target.targetId);
  const targetPath = target.targetPath ?? fallbackTarget?.path;
  const impactText = target.change === "no_op"
    ? t("deployment.plan.impact.noOp")
    : t("deployment.plan.impact.create");
  const visibleWarnings = [...new Set(target.warnings
    .filter((warning) => !isModeDescriptionWarning(warning))
    .map(userFacingDeploymentWarning))];

  return (
    <article className="sh-deployment-impact-card" data-testid="target-plan">
      {skillName ? <h3>{skillName}</h3> : null}
      <dl className="sh-deployment-impact-card__facts">
        <div>
          <dt>{t("deployment.plan.target")}</dt>
          <dd className="sh-deployment-impact-card__targets">
            {entries.length > 0 ? entries.map((entry) => (
              <DeploymentTargetPresentation
                fallback={entry.label}
                key={entry.id}
                target={entry}
              />
            )) : <strong>{target.label}</strong>}
          </dd>
        </div>
        <div>
          <dt>{t("deployment.plan.operation")}</dt>
          <dd>{t(userFacingDeploymentMode(target.mode))}</dd>
        </div>
        {targetPath ? <div>
          <dt>{t("deployment.plan.location")}</dt>
          <dd title={targetPath}>{displayPath(targetPath)}</dd>
        </div> : null}
        {target.destinationPath ? <div>
          <dt>{t("deployment.plan.entry")}</dt>
          <dd title={target.destinationPath}>{displayPath(target.destinationPath)}</dd>
        </div> : null}
        <div>
          <dt>{t("deployment.plan.impact.label")}</dt>
          <dd>{impactText}</dd>
        </div>
      </dl>
      {visibleWarnings.length > 0 ? <ul className="sh-deployment-impact-card__warnings">
        {visibleWarnings.map((warning) => <li key={warning}>{String(t(warning as never, { defaultValue: warning } as never))}</li>)}
      </ul> : null}
      {target.conflicts && target.conflicts.length > 0 ? <ul className="sh-deployment-impact-card__conflicts">
        {target.conflicts.map((conflict) => <li key={`${conflict.reason}:${conflict.target_path}`}>
          {String(t(conflictMessageKey(conflict.reason) as never, { defaultValue: conflictMessageKey(conflict.reason) } as never))}
        </li>)}
      </ul> : null}
      <details className="sh-deployment-flow__diagnostics">
        <summary>{t("deployment.batch.technicalDetails")}</summary>
        <dl className="sh-deployment-flow__diagnostics-list">
          {skillId ? <div><dt>{t("deployment.batch.skillId")}</dt><dd>{skillId}</dd></div> : null}
          <div><dt>{t("deployment.mode.technical")}</dt><dd>{t(`deployment.mode.${target.mode}`)}</dd></div>
          {target.logicalTargetIds && target.logicalTargetIds.length > 1 ? <div>
            <dt>{t("deployment.plan.logicalTargets")}</dt>
            <dd>{target.logicalTargetIds.join("、")}</dd>
          </div> : null}
          {target.warnings.filter(isImplementationWarning).map((warning) => <div key={warning}>
            <dt>{t("deployment.mode.technical")}</dt>
            <dd>{String(t(warning as never, { defaultValue: warning } as never))}</dd>
          </div>)}
        </dl>
      </details>
    </article>
  );
}
