import { useTranslation } from "react-i18next";
import type { DeploymentResult } from "./api";

export function DeploymentResults({ results }: { results: DeploymentResult[] }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="deployment-results-heading" className="sh-workflow-card">
      <h2 id="deployment-results-heading">{t("deployment.results.heading")}</h2>
      <ul className="sh-workflow-list">
        {results.map((result) => (
          <li className="sh-workflow-list__item" data-testid="deployment-result" key={`${result.skillId ?? "single"}:${result.targetId}`}>
            <div>
              <strong>{result.skillId ? `${result.skillId} · ${result.label}` : result.label}</strong>
              <p>{result.message}</p>
            </div>
            <span className={`sh-status sh-status--${result.status}`}>{t(`deployment.results.status.${result.status}`)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
