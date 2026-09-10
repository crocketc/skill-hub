import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { Icon } from "../../ui/Icon";
import { ImportShell, type ImportStatus, type ImportStep } from "../import/ImportShell";
import { DeploymentResults } from "./DeploymentResults";
import "./deployment.css";
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

type FlowPhase = "list-error" | "loading" | "empty" | "targets" | "plan" | "committing" | "results";

const STEP_KEYS = ["targets", "preview", "commit", "results"] as const;

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
  const [listError, setListError] = useState<string>();
  const [flowError, setFlowError] = useState<string>();
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    let active = true;
    void activeFacade.listTargets().then((value) => active && setTargets(value)).catch((reason: unknown) => {
      if (active) setListError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "deployment.errors.generic"));
    });
    return () => { active = false; };
  }, [activeFacade]);

  const selected = (targets ?? []).filter((target) => selectedIds.includes(target.id));
  const availableModes = selected.length === 0
    ? []
    : selected[0].modes.filter((candidate) => selected.every((target) => target.modes.includes(candidate)));
  const preview = async () => {
    setFlowError(undefined);
    try {
      setPlan(await activeFacade.preview(selected, mode));
      setResults(undefined);
    } catch (reason) {
      setFlowError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "deployment.errors.generic"));
    }
  };
  const commit = async () => {
    if (!plan) return;
    setFlowError(undefined);
    setCommitting(true);
    try {
      const committed = await activeFacade.commit(plan);
      setResults(committed);
      onCommitted?.(committed);
    } catch (reason) {
      setFlowError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "deployment.errors.generic"));
    } finally {
      setCommitting(false);
    }
  };
  const retryFailed = () => {
    setSelectedIds(results?.filter((result) => result.status === "failed").map((result) => result.targetId) ?? []);
    setPlan(undefined);
    setResults(undefined);
  };

  // 展示层映射：每个阶段归属唯一流程步骤；失败态回到触发它的步骤。
  const phase: FlowPhase = listError
    ? "list-error"
    : targets === undefined
      ? "loading"
      : targets.length === 0
        ? "empty"
        : committing
          ? "committing"
          : results
            ? "results"
            : plan
              ? "plan"
              : "targets";
  const stepIndex = phase === "results" ? 3 : phase === "committing" ? 2 : phase === "plan" ? 1 : 0;
  const steps: ImportStep[] = STEP_KEYS.map((key, index) => ({
    label: t(`deployment.steps.${key}`),
    state: index < stepIndex ? "complete" : index === stepIndex ? "current" : "upcoming",
  }));

  const failedResults = results?.filter((result) => result.status === "failed") ?? [];
  const status: ImportStatus | null =
    phase === "list-error"
      ? { kind: "failure", text: listError ?? "" }
      : phase === "loading" || phase === "empty"
        ? // 加载与空态由面板 DataState 呈现；持续播报区保持静默，避免同文案双份朗读。
          null
        : phase === "targets"
          ? { kind: "info", text: t("deployment.status.selecting") }
          : phase === "plan"
            ? {
                kind: plan?.warnings.length ? "warning" : "info",
                text: t("deployment.status.previewReady"),
              }
            : phase === "committing"
              ? { kind: "info", text: t("deployment.status.committing") }
              : {
                  kind: failedResults.length > 0 ? "warning" : "success",
                  text: failedResults.length > 0
                    ? t("deployment.status.resultsWithFailures")
                    : t("deployment.status.results"),
                };

  // 选择/计划阶段共用模式选择；纯进度与结果阶段不重复提供流程动作。
  const showModeSelect = phase === "targets" || phase === "plan";
  const footer = phase === "targets" || phase === "plan" ? (
    <>
      {showModeSelect ? (
        <div className="sh-import-wizard__actions-group sh-deployment-flow__mode-group">
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
        </div>
      ) : null}
      <div className="sh-import-wizard__actions-group sh-import-wizard__actions-group--primary">
        {phase === "targets" ? (
          <Button disabled={selected.length === 0} onClick={() => void preview()} size="lg">{t("deployment.preview")}</Button>
        ) : (
          <Button disabled={committing} onClick={() => void commit()} size="lg">{t("deployment.commit")}</Button>
        )}
      </div>
    </>
  ) : phase === "results" && failedResults.length > 0 ? (
    <div className="sh-import-wizard__actions-group">
      <Button onClick={retryFailed} variant="secondary">
        {t("deployment.retryFailed")}
      </Button>
    </div>
  ) : undefined;

  return (
    <ImportShell
      eyebrow={t("deployment.eyebrow")}
      footer={footer}
      status={status}
      steps={steps}
      stepsLabel={t("deployment.steps.label")}
      title={t("deployment.heading")}
    >
      <p className="sh-deployment-flow__description">{t("deployment.description")}</p>
      {flowError ? <DataState message={flowError} state="error" /> : null}
      {phase === "list-error" ? <DataState message={listError ?? ""} state="error" /> : null}
      {phase === "loading" ? <DataState message={t("deployment.states.loading")} state="loading" /> : null}
      {phase === "empty" ? <DataState message={t("deployment.states.empty")} state="empty" /> : null}
      {targets && targets.length > 0 ? (
        <section aria-labelledby="deployment-targets-heading" className="sh-deployment-flow__section">
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
                {!target.available ? (
                  <span className="sh-status sh-status--warning">
                    <Icon aria-hidden="true" name="warning" size={16} />
                    {t("deployment.targets.unavailable")}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        </section>
      ) : null}
      {plan && (phase === "plan" || phase === "committing") ? (
        <section aria-labelledby="deployment-plan-heading" className="sh-deployment-flow__section">
          <div className="sh-section-heading">
            <div>
              <h2 id="deployment-plan-heading">{t("deployment.plan.heading")}</h2>
              <p>{t("deployment.plan.description")}</p>
            </div>
          </div>
          {plan.warnings.length > 0 ? <ul className="sh-notice-list">{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
          <ul className="sh-workflow-list">
            {plan.targets.map((target) => (
              <li className="sh-workflow-list__item" data-testid="target-plan" key={target.targetId}>
                <span><strong>{target.label}</strong><small>{t(`deployment.mode.${target.mode}`)}</small></span>
                {target.warnings.length > 0 ? (
                  <span className="sh-status sh-status--warning">
                    <Icon aria-hidden="true" name="warning" size={16} />
                    {target.warnings.join(" ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {phase === "results" && results ? <DeploymentResults results={results} /> : null}
      <span className="sh-visually-hidden">{skillId}:{versionId}</span>
    </ImportShell>
  );
}
