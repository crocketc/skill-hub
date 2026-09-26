import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import { describeDeploymentResult, type DeploymentResult, type DeploymentTarget } from "./api";
import { DeploymentTargetPresentation } from "./DeploymentTargetPresentation";

const statusIcons = {
  failed: "failure",
  skipped: "info",
  succeeded: "success",
} as const;

export function DeploymentResults({ results, targets = [] }: { results: DeploymentResult[]; targets?: DeploymentTarget[] }) {
  const { t } = useTranslation();
  const targetById = new Map(targets.map((target) => [target.id, target]));
  return (
    <section aria-labelledby="deployment-results-heading" className="sh-workflow-card sh-deployment-flow__section">
      <h2 id="deployment-results-heading">{t("deployment.results.heading")}</h2>
      <ul className="sh-workflow-list">
        {results.map((result) => (
          <li className="sh-workflow-list__item" data-testid="deployment-result" key={`${result.skillId ?? "single"}:${result.targetId}`}>
            <div>
              {/* DEV-18-A：主文案用展示名（回退 runtime name），裸 Skill UUID 不进首屏。 */}
              {result.skillId ? <span>{`${result.displayName ?? t("deployment.batch.unnamedSkill")} · `}{targetById.has(result.targetId) ? <DeploymentTargetPresentation fallback={result.label} target={targetById.get(result.targetId)} /> : result.label}</span> : (targetById.has(result.targetId) ? <DeploymentTargetPresentation fallback={result.label} target={targetById.get(result.targetId)} /> : result.label)}
              <p>{describeDeploymentResult(result, (key, options) => String(t(key as never, options as never)))}</p>
            </div>
            {/* DEV-99：内部 ID 全面退出界面（含技术详情折叠区）——结果行
                只保留用户可读的展示名、目标呈现与状态。 */}
            <span className={`sh-status sh-status--${result.status}`}>
              <Icon aria-hidden="true" name={statusIcons[result.status]} size={16} />
              {t(`deployment.results.status.${result.status}`)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
