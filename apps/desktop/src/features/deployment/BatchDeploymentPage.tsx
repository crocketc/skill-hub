import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { Icon } from "../../ui/Icon";
import { BatchOperationSummary, type BatchOutcome } from "../../ui/BatchOperationSummary";
import { ImportShell, type ImportStatus, type ImportStep } from "../import/ImportShell";
import "./deployment.css";
import {
  type BatchDeploymentFacade,
  type BatchDeploymentPreview,
  type BatchProjectInfo,
  type BatchDeploymentResult,
  type DeploymentMode,
  type DeploymentTarget,
} from "./api";
import { createNativeBatchDeploymentFacade } from "./nativeApi";

export interface BatchDeploymentPageProps {
  facade?: BatchDeploymentFacade;
  skillIds: string[];
  onCommitted?: (results: BatchDeploymentResult[]) => void;
}

type FlowPhase = "list-error" | "loading" | "empty" | "targets" | "plan" | "committing" | "results";

const STEP_KEYS = ["targets", "preview", "commit", "results"] as const;

function uniqueIds(skillIds: string[]) {
  return [...new Set(skillIds.filter(Boolean))];
}

export function BatchDeploymentPage({ facade, skillIds, onCommitted }: BatchDeploymentPageProps) {
  const { t } = useTranslation();
  const activeFacade = useMemo(() => facade ?? createNativeBatchDeploymentFacade(), [facade]);
  const selectedSkillIds = useMemo(() => uniqueIds(skillIds), [skillIds]);
  const [targets, setTargets] = useState<DeploymentTarget[]>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<DeploymentMode>();
  const [preview, setPreview] = useState<BatchDeploymentPreview>();
  const [results, setResults] = useState<BatchDeploymentResult[]>();
  const [listError, setListError] = useState<string>();
  const [flowError, setFlowError] = useState<string>();
  const [committing, setCommitting] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const preselectedTargetId = searchParams.get("target");

  const [projects, setProjects] = useState<BatchProjectInfo[]>();
  useEffect(() => {
    let active = true;
    void activeFacade.listTargets().then((value) => active && setTargets(value)).catch((reason: unknown) => {
      if (active) setListError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "deployment.errors.generic"));
    });
    // 关联 Agent 展开是可选能力；facade 未提供时按钮不出现。
    void activeFacade.listProjects?.().then((value) => active && setProjects(value)).catch(() => {
      if (active) setProjects([]);
    });
    return () => { active = false; };
  }, [activeFacade]);

  // 反向入口：?target= 预选一个目标（Agent/项目详情"发起部署"跳转携带）。
  useEffect(() => {
    if (!preselectedTargetId || !targets) return;
    const target = targets.find((candidate) => candidate.id === preselectedTargetId);
    if (!target?.available) return;
    setSelectedIds((current) => current.includes(preselectedTargetId) ? current : [...current, preselectedTargetId]);
    setSearchParams({}, { replace: true });
  }, [preselectedTargetId, setSearchParams, targets]);

  const selectedProjects = (targets ?? [])
    .filter((target) => selectedIds.includes(target.id))
    .map((target) => ({
      target,
      info: projects?.find((project) => project.id === target.id),
    }))
    .filter((entry): entry is { target: DeploymentTarget; info: BatchProjectInfo } => Boolean(entry.info));
  const expandableLinks = selectedProjects.flatMap(({ target, info }) => info.agentIds
    .filter((agentId) => !selectedIds.includes(agentId))
    .map((agentId) => ({ project: target, agentId })));

  const selected = (targets ?? []).filter((target) => selectedIds.includes(target.id));
  const availableModes = selected.length === 0
    ? []
    : selected[0].modes.filter((candidate) => selected.every((target) => target.modes.includes(candidate)));
  const previewBatch = async () => {
    setFlowError(undefined);
    try {
      setPreview(await activeFacade.preview(selectedSkillIds, selected, mode));
      setResults(undefined);
    } catch (reason) {
      setFlowError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "deployment.errors.generic"));
    }
  };
  const commit = async () => {
    if (!preview?.plans.length || preview.failures.length) return;
    setCommitting(true);
    setFlowError(undefined);
    try {
      const committed = await activeFacade.commit(preview.plans);
      setResults(committed);
      onCommitted?.(committed);
    } catch (reason) {
      setFlowError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "deployment.errors.generic"));
    } finally {
      setCommitting(false);
    }
  };

  if (selectedSkillIds.length === 0) return <DataState message={t("deployment.states.noSkills")} state="empty" />;

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
            : preview
              ? "plan"
              : "targets";
  const stepIndex = phase === "results" ? 3 : phase === "committing" ? 2 : phase === "plan" ? 1 : 0;
  const steps: ImportStep[] = STEP_KEYS.map((key, index) => ({
    label: t(`deployment.steps.${key}`),
    state: index < stepIndex ? "complete" : index === stepIndex ? "current" : "upcoming",
  }));

  const failedResults = results?.filter((result) => result.status === "failed") ?? [];
  const previewFailures = preview?.failures ?? [];
  const status: ImportStatus | null =
    phase === "list-error"
      ? { kind: "failure", text: listError ?? "" }
      : phase === "loading" || phase === "empty"
        ? // 加载与空态由面板 DataState 呈现；持续播报区保持静默，避免同文案双份朗读。
          null
        : phase === "targets"
          ? { kind: "info", text: t("deployment.status.selecting") }
          : phase === "plan"
            ? previewFailures.length > 0
              ? { kind: "failure", text: t("deployment.status.previewFailed") }
              : { kind: "info", text: t("deployment.status.previewReady") }
            : phase === "committing"
              ? { kind: "info", text: t("deployment.batch.committing") }
              : {
                  kind: failedResults.length > 0 ? "warning" : "success",
                  text: failedResults.length > 0
                    ? t("deployment.status.resultsWithFailures")
                    : t("deployment.status.results"),
                };

  const footer = phase === "targets" || phase === "plan" ? (
    <>
      <div className="sh-import-wizard__actions-group sh-deployment-flow__risk-group">
        {/* 非原子批量风险提示紧邻提交动作；选择阶段与计划阶段都在操作区内可见。 */}
        <small className="sh-deployment-flow__risk">{t("deployment.batch.nonAtomicNotice")}</small>
        {phase === "targets" || phase === "plan" ? (
          <label>
            <span className="sh-visually-hidden">{t("deployment.mode.label")}</span>
            <select
              aria-label={t("deployment.mode.label")}
              onChange={(event) => {
                setMode(event.currentTarget.value ? event.currentTarget.value as DeploymentMode : undefined);
                setPreview(undefined);
              }}
              value={mode ?? ""}
            >
              <option value="">{t("deployment.mode.automatic")}</option>
              {availableModes.map((candidate) => <option key={candidate} value={candidate}>{t(`deployment.mode.${candidate}`)}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      <div className="sh-import-wizard__actions-group sh-import-wizard__actions-group--primary">
        {phase === "targets" ? (
          <Button disabled={selected.length === 0} onClick={() => void previewBatch()} size="lg">{t("deployment.preview")}</Button>
        ) : (
          <Button
            disabled={committing || previewFailures.length > 0}
            onClick={() => void commit()}
            size="lg"
          >
            {t("deployment.commit")}
          </Button>
        )}
      </div>
    </>
  ) : undefined;

  return (
    <ImportShell
      eyebrow={t("deployment.eyebrow")}
      footer={footer}
      status={status}
      steps={steps}
      stepsLabel={t("deployment.steps.label")}
      title={t("deployment.batch.heading", { count: selectedSkillIds.length })}
    >
      <p className="sh-deployment-flow__description">{t("deployment.batch.description")}</p>
      {flowError ? <DataState message={flowError} state="error" /> : null}
      {phase === "list-error" ? <DataState message={listError ?? ""} state="error" /> : null}
      {phase === "loading" ? <DataState message={t("deployment.states.loading")} state="loading" /> : null}
      {phase === "empty" ? <DataState message={t("deployment.states.empty")} state="empty" /> : null}
      {targets && targets.length > 0 ? <section aria-labelledby="deployment-targets-heading" className="sh-deployment-flow__section">
        <div className="sh-section-heading">
          <div>
            <h2 id="deployment-targets-heading">{t("deployment.targets.heading")}</h2>
            <p>{t("deployment.targets.description")}</p>
          </div>
          <span className="sh-count-badge">{selected.length}</span>
        </div>
        <div className="sh-workflow-targets">
          {targets.map((target) => <label className="sh-workflow-target" key={target.id}>
            <input aria-label={target.label} checked={selectedIds.includes(target.id)} disabled={!target.available} onChange={(event) => {
              setMode(undefined);
              setPreview(undefined);
              setSelectedIds((current) => event.target.checked ? [...current, target.id] : current.filter((id) => id !== target.id));
            }} type="checkbox" />
            <span><strong>{target.label}</strong><small>{target.path}</small></span>
            {!target.available ? (
              <span className="sh-status sh-status--warning">
                <Icon aria-hidden="true" name="warning" size={16} />
                {t("deployment.targets.unavailable")}
              </span>
            ) : null}
          </label>)}
        </div>
        {expandableLinks.length > 0 ? <div className="sh-deployment-flow__expand">
          <Button onClick={() => {
            setMode(undefined);
            setPreview(undefined);
            setSelectedIds((current) => [...new Set([...current, ...expandableLinks.map((link) => link.agentId)])]);
          }} variant="secondary">
            {t("deployment.batch.expandAgents", { count: expandableLinks.length })}
          </Button>
          <small>{t("deployment.batch.expandAgentsHint")}</small>
        </div> : null}
      </section> : null}
      {preview && (phase === "plan" || phase === "committing") ? <section aria-labelledby="deployment-plan-heading" className="sh-deployment-flow__section">
        <div className="sh-section-heading">
          <div>
            <h2 id="deployment-plan-heading">{t("deployment.plan.heading")}</h2>
            <p>{t("deployment.batch.planDescription")}</p>
          </div>
        </div>
        {preview.failures.length ? <ul className="sh-notice-list" role="alert">{preview.failures.map((failure) => <li key={failure.skillId}>{t("deployment.batch.previewFailed", failure)}</li>)}</ul> : null}
        {preview.plans.map(({ skillId, plan }) => <section key={skillId}>
          <h3>{skillId}</h3>
          {plan.warnings.length > 0 ? <ul className="sh-notice-list">{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
          <ul className="sh-workflow-list">
            {plan.targets.map((target) => <li className="sh-workflow-list__item" data-testid="target-plan" key={target.targetId}>
              <span><strong>{target.label}</strong><small>{t(`deployment.mode.${target.mode}`)}</small></span>
              {target.warnings.length > 0 ? (
                <span className="sh-status sh-status--warning">
                  <Icon aria-hidden="true" name="warning" size={16} />
                  {target.warnings.join(" ")}
                </span>
              ) : null}
            </li>)}
          </ul>
        </section>)}
      </section> : null}
      {results ? <BatchOperationSummary
        outcomes={results.map((result): BatchOutcome => ({
          id: `${result.skillId ?? "single"}:${result.targetId}`,
          label: result.skillId ? `${result.skillId} · ${result.label}` : result.label,
          message: result.message,
          status: result.status,
        }))}
      /> : null}
    </ImportShell>
  );
}
