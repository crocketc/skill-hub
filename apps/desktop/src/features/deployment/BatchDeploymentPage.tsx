import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { describeNativeError } from "../../api/nativeErrors";
import type { OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { BatchOperationSummary, type BatchOutcome } from "../../ui/BatchOperationSummary";
import { ImportShell, type ImportStatus, type ImportStep } from "../import/ImportShell";
import "./deployment.css";
import {
  type BatchDeploymentFacade,
  type BatchDeploymentResult,
  type BatchPreviewItem,
  type BatchProjectInfo,
  type DeploymentPairPreview,
  type DeploymentPreference,
  type DeploymentPreviewBatch,
  type DeploymentTarget,
  groupPairsByDisposition,
  isLinkMode,
} from "./api";
import { describeDeploymentResult } from "./api";
import { createNativeBatchDeploymentFacade } from "./nativeApi";
import { DeploymentDispositionGroup, type DispositionGroupSelection } from "./DeploymentDispositionGroup";
import { DeploymentTargetPresentation } from "./DeploymentTargetPresentation";
import { displayPath } from "../../platform/displayPath";

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
  const [preference, setPreference] = useState<DeploymentPreference>("automatic");
  const [preview, setPreview] = useState<DeploymentPreviewBatch>();
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [exclusionsDirty, setExclusionsDirty] = useState(false);
  const [confirmationsDirty, setConfirmationsDirty] = useState(false);
  const fingerprintsRef = useRef<Record<string, string>>({});
  const [results, setResults] = useState<BatchDeploymentResult[]>();
  const [listError, setListError] = useState<string>();
  const [flowError, setFlowError] = useState<string>();
  const [committing, setCommitting] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const planHeadingRef = useRef<HTMLHeadingElement>(null);
  const preselectedTargetId = searchParams.get("target");
  // 治理清理结果等入口只知道 Agent：?agent= 预选该 Agent 的首个可用目标。
  const preselectedAgentClientId = searchParams.get("agent");

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

  // 反向入口（治理清理结果）：?agent= 按 Agent 身份解析首个可用目标并预选；
  // 解析失败时静默退化为不预选，目标选择仍由用户在页面上显式完成。
  useEffect(() => {
    if (!preselectedAgentClientId || !targets) return;
    const target = targets.find((candidate) => candidate.agentClientId === preselectedAgentClientId
      && candidate.available);
    if (!target) return;
    const targetId = target.id;
    setSelectedIds((current) => current.includes(targetId) ? current : [...current, targetId]);
    setSearchParams({}, { replace: true });
  }, [preselectedAgentClientId, setSearchParams, targets]);

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
  const groups = useMemo(
    () => preview ? groupPairsByDisposition(preview.pairs) : [],
    [preview],
  );
  // 仍待用户处理的回退确认：建议复制但尚未确认的 pair。
  const pendingConfirmationIds = preview
    ? preview.pairs
      .filter((pair) => pair.disposition === "recommend_copy" && !confirmedIds.has(pair.pairId))
      .map((pair) => pair.pairId)
    : [];
  const included = (pair: DeploymentPairPreview) =>
    (pair.disposition === "selected_mode" || pair.disposition === "no_change")
    && !excludedIds.has(pair.pairId);
  const executableCount = preview
    ? preview.pairs.filter((pair) => included(pair)).length + confirmedIds.size
    : 0;
  // 最终汇总（14.8）：链接/复制/无需变更/已排除/仍受阻分别计数。
  const finalSummary = useMemo(() => {
    let link = 0;
    let copy = 0;
    let noChange = 0;
    let excluded = 0;
    let blocked = 0;
    for (const pair of preview?.pairs ?? []) {
      if (pair.disposition === "selected_mode") {
        if (!included(pair)) {
          excluded += 1;
        } else if (pair.mode && isLinkMode(pair.mode)) {
          link += 1;
        } else {
          copy += 1;
        }
      } else if (pair.disposition === "no_change") {
        if (included(pair)) noChange += 1;
        else excluded += 1;
      } else if (pair.disposition === "recommend_copy") {
        if (confirmedIds.has(pair.pairId)) copy += 1;
        else blocked += 1;
      } else {
        blocked += 1;
      }
    }
    return { link, copy, noChange, excluded, blocked };
  }, [preview, excludedIds, confirmedIds]);

  const runPreview = async (context?: { confirmations?: Record<string, string>; exclusions?: string[] }) => {
    setFlowError(undefined);
    const items: BatchPreviewItem[] = selectedSkillIds.map((skillId) => ({
      skillId,
      targetIds: selected.map((target) => target.id),
      preference,
    }));
    try {
      const response = await activeFacade.preview(items, context);
      fingerprintsRef.current = Object.fromEntries(
        response.pairs.map((pair) => [pair.pairId, pair.confirmationFingerprint]),
      );
      setPreview(response);
      setResults(undefined);
      // 排除项保留用户意图（后端预览不回传排除）；确认范围以后端显式判定
      // 恢复（14.7）：指纹漂移的确认不复活，重新要求用户处理。
      setExcludedIds((current) => new Set([...current].filter((pairId) =>
        response.pairs.some((pair) => pair.pairId === pairId))));
      const preserved = new Set(response.preservedConfirmationIds);
      setConfirmedIds(new Set(response.pairs
        .filter((pair) => pair.disposition === "recommend_copy" && preserved.has(pair.pairId))
        .map((pair) => pair.pairId)));
      setExclusionsDirty(false);
      setConfirmationsDirty(false);
      // 重新预览后回到计划区首部（14.16）。
      requestAnimationFrame(() => {
        const heading = planHeadingRef.current;
        if (!heading) return;
        heading.focus({ preventScroll: true });
        // jsdom 不实现 scrollIntoView；真实环境滚动到计划区首部（14.16）。
        if (typeof heading.scrollIntoView === "function") {
          heading.scrollIntoView({ block: "start" });
        }
      });
    } catch (reason) {
      setFlowError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "deployment.errors.generic"));
    }
  };

  const previewBatch = async () => {
    await runPreview();
  };
  const regeneratePreview = async () => {
    const confirmations: Record<string, string> = {};
    for (const pairId of confirmedIds) {
      const fingerprint = fingerprintsRef.current[pairId];
      if (fingerprint) confirmations[pairId] = fingerprint;
    }
    await runPreview({ confirmations, exclusions: [...excludedIds] });
  };

  const commit = async () => {
    if (!preview || committing) return;
    setCommitting(true);
    setFlowError(undefined);
    try {
      // 统一执行桥（任务 4）：批次进 tracker 在途投影；进度分母是可执行
      // pair 数（14.9），结果通知深链 /operations/:id，异常 rethrow 不吞掉。
      const selections = preview.pairs.map((pair) => ({
        pairId: pair.pairId,
        confirmFallback: confirmedIds.has(pair.pairId),
        // 可执行 pair 未纳入即排除；建议复制/阻断 pair 原样提交让结果面报告。
        exclude: excludedIds.has(pair.pairId)
          && (pair.disposition === "selected_mode" || pair.disposition === "no_change"),
      }));
      const committed = await runTrackedOperation<BatchDeploymentResult[]>({
        tracker,
        notifications,
        kind: "deploy",
        label: t("deployment.tracker.label"),
        total: executableCount,
        translate: (key, options) => String(t(key as never, options as never)),
        errorNotice: (_error, message) => ({
          tone: "danger",
          title: t("deployment.notices.addFailedTitle"),
          detail: message,
        }),
        successNotice: (_result, summary) => ({
          tone: summary && summary.failed > 0 ? "warning" : "success",
          title: summary && summary.failed > 0
            ? t("deployment.notices.addedPartialTitle")
            : t("deployment.notices.addedTitle"),
          detail: summary
            ? t("deployment.notices.addedSummary", {
                succeeded: summary.succeeded,
                failed: summary.failed,
                skipped: summary.skipped,
              })
            : undefined,
        }),
        summarize: (results: BatchDeploymentResult[]) => ({
          succeeded: new Set(results.filter((result) => result.status === "succeeded").map((result) => result.skillId)).size,
          failed: new Set(results.filter((result) => result.status === "failed").map((result) => result.skillId)).size,
          skipped: new Set(results.filter((result) => result.status === "skipped").map((result) => result.skillId)).size,
        }),
        run: async (handle) => {
          const results = await activeFacade.commit(preview, selections, (completed) => handle.progress(completed, executableCount));
          // 后端一个 pair 可映射到一条持久化操作；仅当结果集恰好指向一条
          // 记录时 correlate，多 id 批次不伪关联（镜像 removal 既有决定）。
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
    .map((result) => [result.skillId, {
      skillId: result.skillId,
      displayName: result.displayName
        ?? preview?.pairs.find((candidate) => candidate.skillId === result.skillId)?.skillDisplayName
        ?? t("deployment.batch.unnamedSkill"),
    }]))
    .values()];
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
            ? { kind: "info", text: t("deployment.status.previewReady") }
            : phase === "committing"
              ? { kind: "info", text: t("deployment.batch.committing") }
              : {
                  kind: failedResults.length > 0 ? "warning" : "success",
                  text: failedResults.length > 0
                    ? t("deployment.status.resultsWithFailures")
                    : t("deployment.status.results"),
                };

  const regenerateNeeded = exclusionsDirty || confirmationsDirty || pendingConfirmationIds.length > 0;
  const togglePair = (groupDisposition: string, pairId: string, checked: boolean) => {
    if (groupDisposition === "recommend_copy") {
      setConfirmationsDirty(true);
      setConfirmedIds((current) => {
        const update = new Set(current);
        if (checked) update.add(pairId);
        else update.delete(pairId);
        return update;
      });
      return;
    }
    setExclusionsDirty(true);
    setExcludedIds((current) => {
      const update = new Set(current);
      if (checked) update.delete(pairId);
      else update.add(pairId);
      return update;
    });
  };
  const footer = phase === "targets" || phase === "plan" ? (
    <>
      <div className="sh-import-wizard__actions-group sh-deployment-flow__risk-group">
        {/* 非原子批量风险提示紧邻提交动作；选择阶段与计划阶段都在操作区内可见。 */}
        <small className="sh-deployment-flow__risk">{t("deployment.batch.nonAtomicNotice")}</small>
        <label>
          <span className="sh-visually-hidden">{t("deployment.mode.label")}</span>
          <select
            aria-label={t("deployment.mode.label")}
            onChange={(event) => {
              setPreference(event.currentTarget.value as DeploymentPreference);
              setPreview(undefined);
            }}
            value={preference}
          >
            <option value="automatic">{t("deployment.preference.automatic")}</option>
            <option value="link">{t("deployment.preference.link")}</option>
            <option value="copy">{t("deployment.preference.copy")}</option>
          </select>
        </label>
      </div>
      <div className="sh-import-wizard__actions-group sh-import-wizard__actions-group--primary">
        {phase === "targets" ? (
          <Button disabled={selected.length === 0} onClick={() => void previewBatch()} size="lg">{t("deployment.preview")}</Button>
        ) : regenerateNeeded ? (
          <Button
            disabled={committing}
            onClick={() => void regeneratePreview()}
            size="lg"
          >
            {t("deployment.regeneratePreview")}
          </Button>
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
              disabled={committing || executableCount === 0}
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
                setPreference("automatic");
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
            setPreference("automatic");
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
            <h2 id="deployment-plan-heading" ref={planHeadingRef} tabIndex={-1}>{t("deployment.plan.heading")}</h2>
            <p>{t("deployment.batch.planDescription")}</p>
          </div>
        </div>
        <p className="sh-deployment-impact-summary" role="status">
          {t("deployment.batch.finalSummary", {
            link: finalSummary.link,
            copy: finalSummary.copy,
            noChange: finalSummary.noChange,
            excluded: finalSummary.excluded,
            blocked: finalSummary.blocked,
          })}
        </p>
        <div className="sh-disposition-groups">
          {groups.map((group) => {
            const selection: DispositionGroupSelection = group.disposition === "selected_mode" || group.disposition === "no_change"
              ? "include"
              : group.disposition === "recommend_copy" ? "confirm" : "none";
            const selectedSet = group.disposition === "recommend_copy"
              ? confirmedIds
              : new Set((preview?.pairs ?? [])
                .filter((pair) => included(pair) && pair.disposition !== "recommend_copy")
                .map((pair) => pair.pairId));
            return <DeploymentDispositionGroup
              group={group}
              key={group.key}
              onToggle={(pairId, checked) => togglePair(group.disposition, pairId, checked)}
              selection={selection}
              selected={selectedSet}
              targets={targets ?? []}
            />;
          })}
        </div>
      </section> : null}
      {results ? <BatchOperationSummary
        outcomes={results.map((result): BatchOutcome => ({
          id: `${result.skillId ?? "single"}:${result.targetId}`,
          label: result.skillId
            ? `${result.displayName
              ?? preview?.pairs.find((candidate) => candidate.skillId === result.skillId)?.skillDisplayName
              ?? t("deployment.batch.unnamedSkill")} · ${result.label}`
            : result.label,
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
                  {t("deployment.results.manageDeployment")}：{displayName}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </ImportShell>
  );
}
