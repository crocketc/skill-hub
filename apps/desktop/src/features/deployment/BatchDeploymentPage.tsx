import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { BatchOperationSummary, type BatchOutcome } from "../../ui/BatchOperationSummary";
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
  const [error, setError] = useState<string>();
  const [committing, setCommitting] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const preselectedTargetId = searchParams.get("target");

  const [projects, setProjects] = useState<BatchProjectInfo[]>();
  useEffect(() => {
    let active = true;
    void activeFacade.listTargets().then((value) => active && setTargets(value)).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
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
    setError(undefined);
    try {
      setPreview(await activeFacade.preview(selectedSkillIds, selected, mode));
      setResults(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const commit = async () => {
    if (!preview?.plans.length || preview.failures.length) return;
    setCommitting(true);
    setError(undefined);
    try {
      const committed = await activeFacade.commit(preview.plans);
      setResults(committed);
      onCommitted?.(committed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCommitting(false);
    }
  };

  if (selectedSkillIds.length === 0) return <DataState message={t("deployment.states.noSkills")} state="empty" />;

  return <main className="sh-page sh-workflow-page">
    <header className="sh-page__header">
      <div>
        <p className="sh-eyebrow">{t("deployment.eyebrow")}</p>
        <h1>{t("deployment.batch.heading", { count: selectedSkillIds.length })}</h1>
        <p>{t("deployment.batch.description")}</p>
      </div>
    </header>
    {error ? <DataState message={error} state="unavailable" /> : null}
    {!error && targets === undefined ? <DataState message={t("deployment.states.loading")} state="loading" /> : null}
    {!error && targets?.length === 0 ? <DataState message={t("deployment.states.empty")} state="empty" /> : null}
    {targets && targets.length > 0 ? <section aria-labelledby="deployment-targets-heading" className="sh-workflow-card">
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
          {!target.available ? <em>{t("deployment.targets.unavailable")}</em> : null}
        </label>)}
      </div>
      {expandableLinks.length > 0 ? <div className="sh-workflow-actions">
        <Button onClick={() => {
          setMode(undefined);
          setPreview(undefined);
          setSelectedIds((current) => [...new Set([...current, ...expandableLinks.map((link) => link.agentId)])]);
        }} variant="secondary">
          {t("deployment.batch.expandAgents", { count: expandableLinks.length })}
        </Button>
        <small>{t("deployment.batch.expandAgentsHint")}</small>
      </div> : null}
      <p role="status" className="sh-workflow-actions">
        <small>{t("deployment.batch.nonAtomicNotice")}</small>
      </p>
      <div className="sh-workflow-actions">
        <label>
          <span className="sh-visually-hidden">{t("deployment.mode.label")}</span>
          <select aria-label={t("deployment.mode.label")} onChange={(event) => {
            setMode(event.currentTarget.value ? event.currentTarget.value as DeploymentMode : undefined);
            setPreview(undefined);
          }} value={mode ?? ""}>
            <option value="">{t("deployment.mode.automatic")}</option>
            {availableModes.map((candidate) => <option key={candidate} value={candidate}>{t(`deployment.mode.${candidate}`)}</option>)}
          </select>
        </label>
        <Button disabled={selected.length === 0} onClick={() => void previewBatch()}>{t("deployment.preview")}</Button>
      </div>
    </section> : null}
    {preview ? <section aria-labelledby="deployment-plan-heading" className="sh-workflow-card">
      <div className="sh-section-heading">
        <div>
          <h2 id="deployment-plan-heading">{t("deployment.plan.heading")}</h2>
          <p>{t("deployment.batch.planDescription")}</p>
        </div>
        <Button disabled={Boolean(results) || Boolean(preview.failures.length) || committing} onClick={() => void commit()} variant="primary">{t("deployment.commit")}</Button>
      </div>
      {preview.failures.length ? <ul className="sh-notice-list" role="alert">{preview.failures.map((failure) => <li key={failure.skillId}>{t("deployment.batch.previewFailed", failure)}</li>)}</ul> : null}
      {preview.plans.map(({ skillId, plan }) => <section key={skillId}>
        <h3>{skillId}</h3>
        {plan.warnings.length > 0 ? <ul className="sh-notice-list">{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
        <ul className="sh-workflow-list">
          {plan.targets.map((target) => <li className="sh-workflow-list__item" data-testid="target-plan" key={target.targetId}>
            <span><strong>{target.label}</strong><small>{t(`deployment.mode.${target.mode}`)}</small></span>
            {target.warnings.length > 0 ? <span className="sh-status sh-status--warning">{target.warnings.join(" ")}</span> : null}
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
  </main>;
}
