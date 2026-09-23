import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { describeNativeError } from "../../api/nativeErrors";
import type { OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { useOptionalAppNotifications } from "../../ui/notifications";
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
  isImplementationWarning,
  userFacingDeploymentMode,
  userFacingDeploymentWarning,
  type DeploymentMode,
  type DeploymentTarget,
} from "./api";
import { describeDeploymentResult } from "./api";
import { createNativeBatchDeploymentFacade } from "./nativeApi";
import { displayPath } from "../../platform/displayPath";
import { DeploymentTargetPresentation } from "./DeploymentTargetPresentation";

export interface BatchDeploymentPageProps {
  facade?: BatchDeploymentFacade;
  skillIds: string[];
  /** 统一执行桥的在途投影；测试可注入独立实例，默认模块级单例。 */
  tracker?: OperationTracker;
  onCommitted?: (results: BatchDeploymentResult[]) => void;
  /** 成功后跳转到 Skill 详情管理部署（undeploy 可达）；测试可注入。 */
  onManageDeployment?: (skillId: string) => void;
}

type FlowPhase = "list-error" | "loading" | "empty" | "targets" | "plan" | "committing" | "results";

const STEP_KEYS = ["targets", "preview", "commit", "results"] as const;

function uniqueIds(skillIds: string[]) {
  return [...new Set(skillIds.filter(Boolean))];
}

export function BatchDeploymentPage({ facade, skillIds, tracker, onCommitted, onManageDeployment }: BatchDeploymentPageProps) {
  const { t } = useTranslation();
  // Provider 缺席（预览/测试挂载）时通知为 null：桥不发通知，行为不降级。
  const notifications = useOptionalAppNotifications();
  const activeFacade = useMemo(() => facade ?? createNativeBatchDeploymentFacade(), [facade]);
  const navigate = useNavigate();
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
      // 统一执行桥（任务 4）：批次进 tracker 在途投影，按已完成 Skill 推进，
      // 结果通知深链 /operations/:id，异常 rethrow 由页面告警承接，不吞掉。
      const committed = await runTrackedOperation<BatchDeploymentResult[]>({
        tracker,
        notifications,
        kind: "deploy",
        label: t("deployment.tracker.label"),
        total: preview.plans.length,
        translate: (key, options) => String(t(key as never, options as never)),
        errorNotice: () => null,
        successNotice: (_result, summary) => ({
          tone: summary && summary.failed > 0 ? "warning" : "success",
          title: summary && summary.failed > 0
            ? t("deployment.notices.addedPartialTitle")
            : t("deployment.notices.addedTitle"),
        }),
        summarize: (results: BatchDeploymentResult[]) => ({
          succeeded: new Set(results.filter((result) => result.status === "succeeded").map((result) => result.skillId)).size,
          failed: new Set(results.filter((result) => result.status === "failed").map((result) => result.skillId)).size,
          skipped: new Set(results.filter((result) => result.status === "skipped").map((result) => result.skillId)).size,
        }),
        run: async (handle) => {
          const results = await activeFacade.commit(preview.plans, (completed) => handle.progress(completed, preview.plans.length));
          // 后端为每个 prepare 单独铸造 operation id：批次逐 Skill prepare/commit
          // 后各 id 互不相同。仅当结果集恰好指向一条持久化记录（单 Skill 批次）
          // 时才 correlate；多 id 批次镜像 removal 批量的既有决定——不伪关联
          // Skill #1 的记录，通知/深链退化为不带 action 的批量结果反馈。
          const correlatedIds = [...new Set(results
            .map((result) => result.operationId)
            .filter((operationId): operationId is string => Boolean(operationId)))];
          if (correlatedIds.length === 1) handle.correlate(correlatedIds[0]);
          return results;
        },
      });
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

  // DEV-21-A：结果面按 Skill 去重给出「管理此部署」入口，避免多目标重复条目。
  const managedSkills = [...new Map((results ?? [])
    .filter((result): result is BatchDeploymentResult & { skillId: string } => result.status === "succeeded" && Boolean(result.skillId))
    .map((result) => [result.skillId, { skillId: result.skillId, displayName: result.displayName }]))
    .values()];
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
              {availableModes.map((candidate) => <option key={candidate} value={candidate}>{t(userFacingDeploymentMode(candidate))}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      <div className="sh-import-wizard__actions-group sh-import-wizard__actions-group--primary">
        {phase === "targets" ? (
          <Button disabled={selected.length === 0} onClick={() => void previewBatch()} size="lg">{t("deployment.preview")}</Button>
        ) : (
          <>
            <Button
              disabled={committing}
              onClick={() => {
                setPreview(undefined);
              }}
              variant="secondary"
            >
              {t("actions.back")}
            </Button>
            <Button
              disabled={committing || previewFailures.length > 0}
              onClick={() => void commit()}
              size="lg"
            >
              {t("deployment.commit")}
            </Button>
          </>
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
      {/* DEV-17：计划区是独立呈现单元——预览步/提交步不再并列渲染目标
          长列表，「上一步」返回选择步且勾选保持。 */}
      {targets && targets.length > 0 && phase === "targets" ? <section aria-labelledby="deployment-targets-heading" className="sh-deployment-flow__section">
        <div className="sh-section-heading">
          <div>
            <h2 id="deployment-targets-heading">{t("deployment.targets.heading")}</h2>
            <p>{t("deployment.targets.description")}</p>
          </div>
          <span className="sh-count-badge">{selected.length}</span>
        </div>
        {/* DEV-11：不可用目标不进默认列表（用户裁定）——选择页只呈现
            「已发现且可写」的目标，与文案承诺一致。 */}
        <div className="sh-deployment-targets" data-testid="deployment-target-grid">
          {targets.filter((target) => target.available).map((target) => {
            const targetPath = displayPath(target.path);

            return <label className="sh-deployment-target-card" data-testid="deployment-target-card" key={target.id}>
              <input aria-label={target.agentClientId ?? target.label} checked={selectedIds.includes(target.id)} onChange={(event) => {
                setMode(undefined);
                setPreview(undefined);
                setSelectedIds((current) => event.target.checked ? [...current, target.id] : current.filter((id) => id !== target.id));
              }} type="checkbox" />
              <span className="sh-deployment-target-card__body">
                <DeploymentTargetPresentation fallback={target.label} target={target} />
                <small title={targetPath}>{targetPath}</small>
              </span>
            </label>;
          })}
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
        {preview.failures.length ? <ul className="sh-notice-list" role="alert">{preview.failures.map((failure) => <li className="sh-deployment-flow__failure" key={failure.skillId}>
          <div>
            {/* DEV-18-A：失败行主文案用展示名（回退 runtime name）；裸 Skill
                UUID 绝不作为首屏可见文本，只在可展开的「技术详情」区域内。 */}
            <strong>{failure.displayName ?? failure.skillId}</strong>
            <p>{failure.error
              ? describeNativeError(failure.error, (key, options) => String(t(key as never, options as never)), "deployment.errors.generic")
              : failure.message}</p>
          </div>
          <details className="sh-deployment-flow__diagnostics">
            <summary>{t("deployment.batch.technicalDetails")}</summary>
            <dl className="sh-deployment-flow__diagnostics-list">
              <div>
                <dt>{t("deployment.batch.skillId")}</dt>
                <dd>{failure.skillId}</dd>
              </div>
            </dl>
          </details>
        </li>)}</ul> : null}
        {/* DEV-18-A：计划区标题用展示名，裸 Skill UUID 不作为主文案。 */}
        {preview.plans.map(({ skillId, displayName, plan }) => <section key={skillId}>
          <h3>{displayName ?? skillId}</h3>
          {plan.warnings.length > 0 ? <ul className="sh-notice-list">{plan.warnings.map((warning) => <li key={warning}>{String(t(userFacingDeploymentWarning(warning) as never, { defaultValue: userFacingDeploymentWarning(warning) } as never))}</li>)}</ul> : null}
          <ul className="sh-workflow-list">
            {plan.targets.map((target) => <li className="sh-workflow-list__item" data-testid="target-plan" key={target.targetId}>
              <span><DeploymentTargetPresentation fallback={target.label} target={targets?.find((candidate) => candidate.id === target.targetId)} /><small>{t(userFacingDeploymentMode(target.mode))}</small></span>
              {/* DEV-21-A：具体实现方式（符号链接/目录联接/托管复制）只在技术详情，
                  首屏主文案统一为「链接部署」/「复制部署」。 */}
              <details className="sh-deployment-flow__diagnostics">
                <summary>{t("deployment.mode.technical")}</summary>
                <dl className="sh-deployment-flow__diagnostics-list">
                  <div>
                    <dt>{t("deployment.mode.technical")}</dt>
                    <dd>{t(`deployment.mode.${target.mode}`)}</dd>
                  </div>
                  {/* 实现方式告警的原始术语只留在技术详情（DEV-21-A）。 */}
                  {target.warnings.filter(isImplementationWarning).map((warning) => <div key={warning}>
                    <dt>{t("deployment.mode.technical")}</dt>
                    <dd>{String(t(warning as never, { defaultValue: warning } as never))}</dd>
                  </div>)}
                </dl>
              </details>
              {target.warnings.length > 0 ? (
                <span className="sh-status sh-status--warning">
                  <Icon aria-hidden="true" name="warning" size={16} />
                  {/* DEV-21-A：主文案只说「链接部署」/「复制部署」。 */}
                  {target.warnings.map((warning) => String(t(userFacingDeploymentWarning(warning) as never, { defaultValue: userFacingDeploymentWarning(warning) } as never))).join(" ")}
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
          message: describeDeploymentResult(result, (key, options) => String(t(key as never, options as never))),
          status: result.status,
        }))}
      /> : null}
      {/* DEV-21-A：成功后让用户从同一结果面到达「从 Agent/项目移除」（undeploy）。
          每个 Skill 一条入口（同一 Skill 的多个目标不重复）；详情页/治理页
          承载真正的移除动作，这里只保证可达。 */}
      {managedSkills.length > 0 ? (
        <section className="sh-deployment-flow__manage" aria-labelledby="deployment-manage-heading">
          <h2 id="deployment-manage-heading">{t("deployment.results.manageDeployment")}</h2>
          <ul className="sh-workflow-list">
            {managedSkills.map(({ skillId, displayName }) => (
              <li className="sh-workflow-list__item" key={skillId}>
                <button
                  type="button"
                  onClick={() => (onManageDeployment ? onManageDeployment(skillId) : navigate(`/library/${skillId}`))}
                >
                  {t("deployment.results.manageDeployment")}：{displayName ?? skillId}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </ImportShell>
  );
}
