import { useTranslation } from "react-i18next";
import { displayPath } from "../../platform/displayPath";
import { DeploymentTargetPresentation } from "./DeploymentTargetPresentation";
import {
  type DeploymentPairPreview,
  type DeploymentTarget,
  isImplementationWarning,
  isModeDescriptionWarning,
  userFacingDeploymentMode,
  userFacingDeploymentWarning,
} from "./api";

type DeploymentImpactCardProps = {
  pair: DeploymentPairPreview;
  targets: DeploymentTarget[];
};

function targetEntries(pair: DeploymentPairPreview, targets: DeploymentTarget[]): DeploymentTarget[] {
  const byId = new Map(targets.map((candidate) => [candidate.id, candidate]));
  return pair.logicalTargetIds.map((id) => byId.get(id)).filter((candidate): candidate is DeploymentTarget => Boolean(candidate));
}

/** 一个 pair 的既有事实行：主文案说用户语言，原始 code/path 只进技术详情。 */
export function DeploymentImpactCard({ pair, targets }: DeploymentImpactCardProps) {
  const { t } = useTranslation();
  const entries = targetEntries(pair, targets);
  const visibleWarnings = [...new Set(pair.warnings
    .filter((warning) => !isModeDescriptionWarning(warning))
    .map(userFacingDeploymentWarning))];
  // 首屏方式文案：selected_mode 说选中的方式；建议复制说回退方式。
  const modeWord = pair.disposition === "recommend_copy"
    ? (pair.fallbackMode ? t(userFacingDeploymentMode(pair.fallbackMode)) : null)
    : (pair.mode ? t(userFacingDeploymentMode(pair.mode)) : null);

  return (
    <article className="sh-deployment-impact-card" data-testid="target-plan">
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
            )) : <strong>{pair.targetLabel}</strong>}
          </dd>
        </div>
        {modeWord ? <div>
          <dt>{t("deployment.plan.operation")}</dt>
          <dd>{modeWord}</dd>
        </div> : null}
        <div>
          <dt>{t("deployment.plan.location")}</dt>
          <dd title={pair.targetPath}>{displayPath(pair.targetPath)}</dd>
        </div>
        <div>
          <dt>{t("deployment.plan.entry")}</dt>
          <dd title={pair.destinationPath}>{displayPath(pair.destinationPath)}</dd>
        </div>
      </dl>
      {visibleWarnings.length > 0 ? <ul className="sh-deployment-impact-card__warnings">
        {visibleWarnings.map((warning) => <li key={warning}>{String(t(warning as never, { defaultValue: warning } as never))}</li>)}
      </ul> : null}
      {/* DEV-99：「技术详情」只收纳用户可读的次要事实（部署方式、回退方式、
          目标能力说明）；内部 ID、原始错误 code/params 属于日志，不进界面。 */}
      {pair.mode || pair.fallbackMode ? (
        <details className="sh-deployment-flow__diagnostics">
          <summary>{t("deployment.batch.technicalDetails")}</summary>
          <dl className="sh-deployment-flow__diagnostics-list">
            {pair.mode ? <div>
              <dt>{t("deployment.mode.label")}</dt>
              <dd>{t(`deployment.mode.${pair.mode}`)}</dd>
            </div> : null}
            {pair.fallbackMode ? <div>
              <dt>{t("deployment.plan.fallbackMode")}</dt>
              <dd>{t(`deployment.mode.${pair.fallbackMode}`)}</dd>
            </div> : null}
            {pair.warnings.filter(isImplementationWarning).length > 0 ? <div>
              <dt>{t("deployment.mode.technical")}</dt>
              <dd>
                <ul className="sh-deployment-impact-card__capability-notes">
                  {pair.warnings.filter(isImplementationWarning).map((warning) => (
                    <li key={warning}>{String(t(warning as never, { defaultValue: warning } as never))}</li>
                  ))}
                </ul>
              </dd>
            </div> : null}
          </dl>
        </details>
      ) : null}
    </article>
  );
}
