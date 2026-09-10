import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import type { DeploymentResult } from "./api";

const statusIcons = {
  failed: "failure",
  skipped: "info",
  succeeded: "success",
} as const;

export function DeploymentResults({ results }: { results: DeploymentResult[] }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="deployment-results-heading" className="sh-workflow-card sh-deployment-flow__section">
      <h2 id="deployment-results-heading">{t("deployment.results.heading")}</h2>
      <ul className="sh-workflow-list">
        {results.map((result) => (
          <li className="sh-workflow-list__item" data-testid="deployment-result" key={`${result.skillId ?? "single"}:${result.targetId}`}>
            <div>
              <strong>{result.skillId ? `${result.skillId} · ${result.label}` : result.label}</strong>
              <p>{t(result.message, { defaultValue: result.message })}</p>
            </div>
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
