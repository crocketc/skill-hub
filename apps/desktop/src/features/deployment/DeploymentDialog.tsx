import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { DeploymentResults } from "./DeploymentResults";
import {
  type DeploymentFacade,
  type DeploymentMode,
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
  onCommitted?: (results: DeploymentResult[]) => void;
}

export function DeploymentDialog({
  facade,
  skillId,
  versionId,
  runtimeName,
  onCommitted,
}: DeploymentDialogProps) {
  const { t } = useTranslation();
  const activeFacade = useMemo(
    () => facade ?? createNativeDeploymentFacade({ skillId, versionId, runtimeName }),
    [facade, runtimeName, skillId, versionId],
  );
  const [targets, setTargets] = useState<DeploymentTarget[]>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<DeploymentMode>();
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

  const selected = (targets ?? []).filter((target) => selectedIds.includes(target.id));
  const availableModes = selected.length === 0
    ? []
    : selected[0].modes.filter((candidate) => selected.every((target) => target.modes.includes(candidate)));
  const preview = async () => {
    setError(undefined);
    try {
      setPlan(await activeFacade.preview(selected, mode));
      setResults(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const commit = async () => {
    if (!plan) return;
    setError(undefined);
    try {
      const committed = await activeFacade.commit(plan);
      setResults(committed);
      onCommitted?.(committed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const retryFailed = () => {
    setSelectedIds(results?.filter((result) => result.status === "failed").map((result) => result.targetId) ?? []);
    setPlan(undefined);
    setResults(undefined);
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
      {!error && targets === undefined ? <DataState message={t("deployment.states.loading")} state="loading" /> : null}
      {!error && targets?.length === 0 ? <DataState message={t("deployment.states.empty")} state="empty" /> : null}
      {targets && targets.length > 0 ? (
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
                  onChange={(event) => {
                    setMode(undefined);
                    setPlan(undefined);
                    setSelectedIds((current) => event.target.checked ? [...current, target.id] : current.filter((id) => id !== target.id));
                  }}
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
            <label>
              <span className="sh-visually-hidden">{t("deployment.mode.label")}</span>
              <select
                aria-label={t("deployment.mode.label")}
                onChange={(event) => {
                  setMode(event.currentTarget.value ? event.currentTarget.value as DeploymentMode : undefined);
                  setPlan(undefined);
                }}
                value={mode ?? ""}
              >
                <option value="">{t("deployment.mode.automatic")}</option>
                {availableModes.map((candidate) => (
                  <option key={candidate} value={candidate}>{t(`deployment.mode.${candidate}`)}</option>
                ))}
              </select>
            </label>
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
      {results ? (
        <>
          <DeploymentResults results={results} />
          {results.some((result) => result.status === "failed") ? (
            <div className="sh-workflow-actions">
              <Button onClick={retryFailed} variant="secondary">
                {t("deployment.retryFailed")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      <span className="sh-visually-hidden">{skillId}:{versionId}</span>
    </main>
  );
}
