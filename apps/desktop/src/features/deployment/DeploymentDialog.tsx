import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useInRouterContext } from "react-router-dom";
import { describeNativeError } from "../../api/nativeErrors";
import type { OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { ImportShell, type ImportStatus, type ImportStep } from "../import/ImportShell";
import { DeploymentResults } from "./DeploymentResults";
import "./deployment.css";
import {
  type BatchDeploymentFacade,
  type BatchPreviewItem,
  type DeploymentPairPreview,
  type DeploymentPreference,
  type DeploymentPreviewBatch,
  type DeploymentResult,
  type DeploymentTarget,
  groupPairsByDisposition,
} from "./api";
import { createNativeBatchDeploymentFacade } from "./nativeApi";
import { displayPath } from "../../platform/displayPath";
import { DeploymentTargetPresentation } from "./DeploymentTargetPresentation";
import { DeploymentDispositionGroup, type DispositionGroupSelection } from "./DeploymentDispositionGroup";

export interface DeploymentDialogProps {
  /** 单项部署复用批次预览契约：一个 Skill 的 pair 流（任务 14）。 */
  facade?: BatchDeploymentFacade;
  skillId: string;
  versionId: string;
  runtimeName?: string;
  /** 统一执行桥的在途投影；测试可注入独立实例，默认模块级单例。 */
  tracker?: OperationTracker;
  /** 提供时展示「管理关系」深链，指向治理页（携带来源与 skillId）。 */
  manageRelationsHref?: string;
  onCommitted?: (results: DeploymentResult[]) => void;
}

type FlowPhase = "list-error" | "loading" | "empty" | "targets" | "plan" | "committing" | "results";

const STEP_KEYS = ["targets", "preview", "commit", "results"] as const;

export function DeploymentDialog({
  facade,
  manageRelationsHref,
  skillId,
  versionId,
  runtimeName,
  tracker,
  onCommitted,
}: DeploymentDialogProps) {
  const { t } = useTranslation();
  // Provider 缺席（预览/测试挂载）时通知为 null：桥不发通知，行为不降级。
  const notifications = useOptionalAppNotifications();
  // 「管理关系」深链（任务 8）：默认在路由上下文内由 skillId 自行推导；
  // 显式传入的 href 优先。脱离路由的挂载（独立测试）不渲染链接。
  const inRouter = useInRouterContext();
  const manageRelationsLink = manageRelationsHref
    ?? (inRouter ? `/relationships/governance?from=library&skillId=${encodeURIComponent(skillId)}` : null);
  const activeFacade = useMemo(
    () => facade ?? createNativeBatchDeploymentFacade(),
    [facade],
  );
  const [targets, setTargets] = useState<DeploymentTarget[]>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preference, setPreference] = useState<DeploymentPreference>("automatic");
  const [preview, setPreview] = useState<DeploymentPreviewBatch>();
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [exclusionsDirty, setExclusionsDirty] = useState(false);
  const [confirmationsDirty, setConfirmationsDirty] = useState(false);
  const fingerprintsRef = useRef<Record<string, string>>({});
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
  const groups = useMemo(
    () => preview ? groupPairsByDisposition(preview.pairs) : [],
    [preview],
  );
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

  const runPreview = async (context?: { confirmations?: Record<string, string>; exclusions?: string[] }) => {
    setFlowError(undefined);
    const item: BatchPreviewItem = {
      skillId,
      targetIds: selected.map((target) => target.id),
      preference,
      // 版本由调用方指定时透传；"current" 交给后端解析当前库版本。
      versionId: versionId === "current" ? undefined : versionId,
    };
    try {
      const response = await activeFacade.preview([item], context);
      fingerprintsRef.current = Object.fromEntries(
        response.pairs.map((pair) => [pair.pairId, pair.confirmationFingerprint]),
      );
      setPreview(response);
      setResults(undefined);
      setExcludedIds(new Set());
      const preserved = new Set(response.preservedConfirmationIds);
      setConfirmedIds(new Set(response.pairs
        .filter((pair) => pair.disposition === "recommend_copy" && preserved.has(pair.pairId))
        .map((pair) => pair.pairId)));
      setExclusionsDirty(false);
      setConfirmationsDirty(false);
    } catch (reason) {
      setFlowError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "deployment.errors.generic"));
    }
  };

  const commit = async () => {
    if (!preview || committing) return;
    setFlowError(undefined);
    setCommitting(true);
    try {
      // 统一执行桥（任务 4）：提交进 tracker 在途投影，结果通知深链
      // /operations/:id，异常原样 rethrow 由页面告警承接，不吞掉。
      const selections = preview.pairs.map((pair) => ({
        pairId: pair.pairId,
        confirmFallback: confirmedIds.has(pair.pairId),
        exclude: excludedIds.has(pair.pairId)
          && (pair.disposition === "selected_mode" || pair.disposition === "no_change"),
      }));
      const committed = await runTrackedOperation<DeploymentResult[]>({
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
        }),
        summarize: (results: DeploymentResult[]) => ({
          succeeded: results.filter((result) => result.status === "succeeded").length,
          failed: results.filter((result) => result.status === "failed").length,
          skipped: results.filter((result) => result.status === "skipped").length,
        }),
        run: async (handle) => {
          const results = await activeFacade.commit(preview, selections, (completed) => handle.progress(completed, executableCount));
          const operationId = results.find((result) => result.operationId)?.operationId;
          if (operationId) handle.correlate(operationId);
          return results;
        },
      });
      const withDisplayNames = committed.map((result) => ({
        ...result,
        displayName: result.displayName
          ?? preview.pairs.find((pair) => pair.pairId === selections.find((selection) => selection.pairId === `${result.skillId}:${result.targetId}`)?.pairId)?.skillDisplayName
          ?? runtimeName,
      }));
      setResults(withDisplayNames);
      onCommitted?.(withDisplayNames);
    } catch (reason) {
      setFlowError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "deployment.errors.generic"));
    } finally {
      setCommitting(false);
    }
  };
  const retryFailed = () => {
    const failedTargets = results
      ?.filter((result) => result.status === "failed")
      .map((result) => result.targetId) ?? [];
    setSelectedIds(failedTargets);
    setPreview(undefined);
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
            : preview
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
            ? { kind: "info", text: t("deployment.status.previewReady") }
            : phase === "committing"
              ? { kind: "info", text: t("deployment.status.committing") }
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
  const regeneratePreview = async () => {
    const confirmations: Record<string, string> = {};
    for (const pairId of confirmedIds) {
      const fingerprint = fingerprintsRef.current[pairId];
      if (fingerprint) confirmations[pairId] = fingerprint;
    }
    await runPreview({ confirmations, exclusions: [...excludedIds] });
  };

  // 选择/计划阶段共用偏好选择；纯进度与结果阶段不重复提供流程动作。
  const showPreferenceSelect = phase === "targets" || phase === "plan";
  const footer = phase === "targets" || phase === "plan" ? (
    <>
      {showPreferenceSelect ? (
        <div className="sh-import-wizard__actions-group sh-deployment-flow__mode-group">
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
      ) : null}
      <div className="sh-import-wizard__actions-group sh-import-wizard__actions-group--primary">
        {phase === "targets" ? (
          <Button disabled={selected.length === 0} onClick={() => void runPreview()} size="lg">{t("deployment.preview")}</Button>
        ) : regenerateNeeded ? (
          <Button disabled={committing} onClick={() => void regeneratePreview()} size="lg">
            {t("deployment.regeneratePreview")}
          </Button>
        ) : (
          <Button disabled={committing || executableCount === 0} onClick={() => void commit()} size="lg">
            {t("deployment.commit")}
          </Button>
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
      {manageRelationsLink ? (
        <p>
          <Link
            className="sh-governance__row-link"
            data-testid="manage-relations-link"
            to={manageRelationsLink}
          >
            {t("relationships.governance.manageRelations")}
          </Link>
        </p>
      ) : null}
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
            {/* DEV-11：不可用目标不进默认列表（用户裁定）——选择页只呈现
                「已发现且可写」的目标，与文案承诺一致。 */}
            {targets.filter((target) => target.available).map((target) => (
              <label className="sh-workflow-target" key={target.id}>
                <input
                  aria-label={target.agentClientId ?? target.label}
                  checked={selectedIds.includes(target.id)}
                  onChange={(event) => {
                    setPreference("automatic");
                    setPreview(undefined);
                    setSelectedIds((current) => event.target.checked ? [...current, target.id] : current.filter((id) => id !== target.id));
                  }}
                  type="checkbox"
                />
                <span>
                  <DeploymentTargetPresentation fallback={target.label} target={target} />
                  <small>{displayPath(target.path)}</small>
                </span>
              </label>
            ))}
          </div>
        </section>
      ) : null}
      {preview && (phase === "plan" || phase === "committing") ? (
        <section aria-labelledby="deployment-plan-heading" className="sh-deployment-flow__section">
          <div className="sh-section-heading">
            <div>
              <h2 id="deployment-plan-heading">{t("deployment.plan.heading")}</h2>
              <p>{t("deployment.plan.description")}</p>
            </div>
          </div>
          <div className="sh-disposition-groups">
            {groups.map((group) => {
              const selection: DispositionGroupSelection = group.disposition === "selected_mode" || group.disposition === "no_change"
                ? "include"
                : group.disposition === "recommend_copy" ? "confirm" : "none";
              const selectedSet = group.disposition === "recommend_copy"
                ? confirmedIds
                : new Set(preview.pairs
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
        </section>
      ) : null}
      {phase === "results" && results ? <DeploymentResults results={results} targets={targets} /> : null}
      <span className="sh-visually-hidden">{skillId}:{versionId}</span>
    </ImportShell>
  );
}
