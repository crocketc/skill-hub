import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { DeploymentResults } from "./DeploymentResults";
import {
  type DeploymentFacade,
  type DeploymentPlan,
  type DeploymentResult,
  type DeploymentTarget,
} from "./api";
import { createNativeDeploymentFacade } from "./nativeApi";

export interface DeploymentDialogProps {
  facade?: DeploymentFacade;
  skillId: string;
  versionId: string;
  runtimeName?: string;
}

export function DeploymentDialog({ facade, skillId, versionId, runtimeName }: DeploymentDialogProps) {
  const { t } = useTranslation();
  const activeFacade = useMemo(
    () => facade ?? createNativeDeploymentFacade({ skillId, versionId, runtimeName }),
    [facade, runtimeName, skillId, versionId],
  );
  const [targets, setTargets] = useState<DeploymentTarget[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [plan, setPlan] = useState<DeploymentPlan>();
  const [results, setResults] = useState<DeploymentResult[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void activeFacade.listTargets().then((value) => active && setTargets(value)).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [activeFacade]);

  const selected = targets.filter((target) => selectedIds.includes(target.id));
  const preview = async () => {
    setError(undefined);
    try {
      setPlan(await activeFacade.preview(selected));
      setResults(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const commit = async () => {
    if (!plan) return;
    setError(undefined);
    try {
      setResults(await activeFacade.commit(plan));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <main className="sh-page sh-workflow-page">
      <header className="sh-page__header">
        <div>
          <p className="sh-eyebrow">{t("deployment.eyebrow")}</p>
          <h1>{t("deployment.heading")}</h1>
          <p>{t("deployment.description")}</p>
        </div>
      </header>
      {error ? <DataState message={error} state="unavailable" /> : null}
      {!error && targets.length === 0 ? <DataState message={t("deployment.states.loading")} state="loading" /> : null}
      {targets.length > 0 ? (
        <section aria-labelledby="deployment-targets-heading" className="sh-workflow-card">
          <div className="sh-section-heading">
            <div>
              <h2 id="deployment-targets-heading">{t("deployment.targets.heading")}</h2>
              <p>{t("deployment.targets.description")}</p>
            </div>
            <span className="sh-count-badge">{selected.length}</span>
          </div>
          <div className="sh-workflow-targets">
            {targets.map((target) => (
              <label className="sh-workflow-target" key={target.id}>
                <input
                  aria-label={target.label}
                  checked={selectedIds.includes(target.id)}
                  disabled={!target.available}
                  onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, target.id] : current.filter((id) => id !== target.id))}
                  type="checkbox"
                />
                <span>
                  <strong>{target.label}</strong>
                  <small>{target.path}</small>
                </span>
                {!target.available ? <em>{t("deployment.targets.unavailable")}</em> : null}
              </label>
            ))}
          </div>
          <div className="sh-workflow-actions">
            <Button disabled={selected.length === 0} onClick={() => void preview()}>{t("deployment.preview")}</Button>
          </div>
        </section>
      ) : null}
      {plan ? (
        <section aria-labelledby="deployment-plan-heading" className="sh-workflow-card">
          <div className="sh-section-heading">
            <div>
              <h2 id="deployment-plan-heading">{t("deployment.plan.heading")}</h2>
              <p>{t("deployment.plan.description")}</p>
            </div>
            <Button disabled={Boolean(results)} onClick={() => void commit()} variant="primary">{t("deployment.commit")}</Button>
          </div>
          {plan.warnings.length > 0 ? <ul className="sh-notice-list">{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
          <ul className="sh-workflow-list">
            {plan.targets.map((target) => (
              <li className="sh-workflow-list__item" data-testid="target-plan" key={target.targetId}>
                <span><strong>{target.label}</strong><small>{t(`deployment.mode.${target.mode}`)}</small></span>
                {target.warnings.length > 0 ? <span className="sh-status sh-status--warning">{target.warnings.join(" ")}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {results ? <DeploymentResults results={results} /> : null}
      <span className="sh-visually-hidden">{skillId}:{versionId}</span>
    </main>
  );
}
