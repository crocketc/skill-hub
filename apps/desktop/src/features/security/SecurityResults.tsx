import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ProductLevel } from "../../api/bindings";
import { describeNativeError } from "../../api/nativeErrors";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation, type TrackedOperationHandle } from "../../platform/runTrackedOperation";
import { skillDetailKeys } from "../skill-detail/api";
import { skillLibraryKeys } from "../skills/api";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { StatusBadge } from "../../ui/StatusBadge";
import { Icon } from "../../ui/Icon";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { FindingActions } from "./FindingActions";
import { SecurityAlertBadge } from "../shared/SecurityAlertBadge";
import { type SecurityCheck, type SecurityFacade, type SecurityFinding, type SecurityPreferences } from "./api";
import "./securityResults.css";

export interface SecurityResultsProps {
  facade: SecurityFacade;
  skillId: string;
  versionId: string;
  findingId?: string;
  checkKind?: string;
  variant?: "page" | "embedded" | "drawer";
  /** Prototype presentation separates run completion from unresolved risk. */
  presentationMode?: "standard" | "risk-aware";
  /**
   * W3-1（FB-003 裁决第 1 节）：当前版本的安全预警留痕（security_alert 投影，
   * 与列表/详情同一事实来源）；缺省或 null 不渲染，不由本页发现项重新推导。
   */
  securityAlert?: ProductLevel | null;
  /** 统一执行桥的在途投影；测试可注入独立实例，默认模块级单例。 */
  tracker?: OperationTracker;
}

export function SecurityResults({ facade, skillId, tracker = operationTracker, versionId, findingId, checkKind, variant = "page", presentationMode = "standard", securityAlert }: SecurityResultsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const scopeKey = `${skillId}\u0000${versionId}`;
  const [resolvedVersion, setResolvedVersion] = useState({ scope: scopeKey, id: versionId });
  const [loadedScope, setLoadedScope] = useState<string>();
  const resolvedVersionId = resolvedVersion.scope === scopeKey ? resolvedVersion.id : versionId;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const mountedRef = useRef(false);
  const basicRunScopeRef = useRef<string | undefined>(undefined);
  const llmRunScopeRef = useRef<string | undefined>(undefined);
  const handleScopeRef = useRef<string | undefined>(undefined);
  const cancelledScopeRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const isCurrentScope = (capturedScope: string) => mountedRef.current && scopeRef.current === capturedScope;
  const targetHref = `/library/${encodeURIComponent(skillId)}/security?${new URLSearchParams({ version: resolvedVersionId })}`;
  const notifications = useOptionalAppNotifications();
  const [checks, setChecks] = useState<SecurityCheck[]>([]);
  const [findings, setFindings] = useState<SecurityFinding[]>([]);
  const [preferences, setPreferences] = useState<SecurityPreferences>();
  const [error, setError] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const [basicRunning, setBasicRunning] = useState(false);
  const [basicError, setBasicError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [runningOperation, setRunningOperation] = useState<string | undefined>(undefined);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const [dispositionError, setDispositionError] = useState<string>();
  const handleRef = useRef<TrackedOperationHandle | null>(null);
  useEffect(() => {
    setResolvedVersion({ scope: scopeKey, id: versionId });
    setBasicRunning(false); setBasicError(undefined);
    setRunning(false); setRunError(undefined); setRunningOperation(undefined); setCancelRequested(false); setCancelError(undefined);
    setDispositionError(undefined);
    setPreferences(undefined);
  }, [facade, scopeKey, versionId]);
  useEffect(() => {
    let active = true;
    setLoadedScope(undefined);
    setChecks([]); setFindings([]); setError(undefined);
    void (facade.resolveVersion ? facade.resolveVersion(skillId, versionId) : Promise.resolve(versionId)).then(async (resolved) => {
      const results = await Promise.all([
        facade.getChecks(skillId, resolved), facade.listFindings(skillId, resolved), facade.getPreferences?.().catch(() => undefined),
      ]);
      if (active) setResolvedVersion({ scope: scopeKey, id: resolved });
      return results;
    })
      .then(([nextChecks, nextFindings, nextPreferences]) => {
        if (!active) return;
        setChecks(nextChecks);
        setFindings(nextFindings);
        setPreferences(nextPreferences);
        setLoadedScope(scopeKey);
      })
      .catch((reason: unknown) => { if (active) setError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "security.errors.generic")); });
    return () => { active = false; };
  }, [facade, skillId, versionId, scopeKey, reloadKey]);

  const checkByKind = (kind: SecurityCheck["kind"]) => checks.find((check) => check.kind === kind);
  // 结构化 AppError 必须转成可读文本：桥的缺省 describeError 用 String()，
  // 收到 { code, params } 对象时会把 "[object Object]" 写进通知的补充说明。
  const describeFailure = (error: unknown) =>
    describeNativeError(
      error,
      (key, describeOptions) => String(t(key as never, describeOptions as never)),
      "security.errors.generic",
    );
  // 统一执行反馈（任务 4）：处置是用户可触发的单次写入，失败必须可见——
  // 之前 `void handleDisposition(...)` 会把拒绝吞掉，页面既不更新也不报错。
  const handleDisposition = async (finding: SecurityFinding, disposition: SecurityFinding["disposition"], options: { highRiskConfirmed: boolean }) => {
    const operationScope = scopeKey;
    setDispositionError(undefined);
    try {
      await runTrackedOperation({
        targetHref: `${targetHref}&${new URLSearchParams({ kind: finding.kind, finding: finding.id })}`,
        kind: "finding_disposition",
        label: t("security.tracker.dispositionLabel"),
        mode: "instant",
        notifications,
        tracker,
        translate: (key, options_) => String(t(key as never, options_ as never)),
        successNotice: () => ({
          tone: "success",
          title: t("security.tracker.dispositionSaved", {
            disposition: t(`security.disposition.${disposition}`),
          }),
        }),
        errorNotice: (_error, message) => ({
          tone: "danger",
          title: t("security.tracker.dispositionFailed"),
          detail: message,
        }),
        describeError: describeFailure,
        queryClient,
        invalidateQueryKeys: [skillLibraryKeys.root, skillDetailKeys.summary(skillId)],
        run: () =>
          facade.setFindingDisposition(
            finding,
            disposition,
            skillId,
            resolvedVersionId,
            options.highRiskConfirmed,
          ),
      });
      if (isCurrentScope(operationScope)) {
        setFindings((current) => current.map((item) => item.id === finding.id ? { ...item, disposition } : item));
        setReloadKey((key) => key + 1);
      }
    } catch (reason: unknown) {
      // 处置未保存：列表保持原状态，并把原因留在页面上（通知只是补充）。
      // 局部提示与通知的补充说明取自同一段描述，两处不会互相矛盾。
      if (isCurrentScope(operationScope)) setDispositionError(describeFailure(reason));
    }
  };
  const handleRunBasic = async () => {
    if (!facade.runBasicCheck) return;
    const operationScope = scopeKey;
    if (basicRunScopeRef.current === operationScope) return;
    basicRunScopeRef.current = operationScope;
    setBasicRunning(true);
    setBasicError(undefined);
    try {
      await runTrackedOperation({
        targetHref,
        kind: "basic_check",
        label: t("security.tracker.basicCheckLabel"),
        mode: "phased",
        notifications,
        tracker,
        translate: (key, options) => String(t(key as never, options as never)),
        successNotice: () => ({ tone: "success", title: t("security.tracker.basicCheckLabel") }),
        errorNotice: (_error, message) => ({ tone: "danger", title: t("security.basic.runFailed", { message }), detail: message }),
        describeError: describeFailure,
        queryClient,
        invalidateQueryKeys: [skillLibraryKeys.root, skillDetailKeys.summary(skillId)],
        run: () => facade.runBasicCheck!(skillId, resolvedVersionId),
      });
      if (isCurrentScope(operationScope)) setReloadKey((key) => key + 1);
    } catch (reason: unknown) {
      if (isCurrentScope(operationScope)) setBasicError(describeFailure(reason));
    } finally {
      if (basicRunScopeRef.current === operationScope) basicRunScopeRef.current = undefined;
      if (isCurrentScope(operationScope)) setBasicRunning(false);
    }
  };
  const llmConfigured = preferences ? preferences.llmProvider.trim().length > 0 : presentationMode !== "risk-aware";
  // 统一执行桥（任务 4）：在途句柄挂在 ref 上，供取消路径与运行中的
  // operation id 发现逻辑随时关联/落终态。
  const handleRun = async () => {
    if (!facade.runLlmCheck || !llmConfigured) return;
    const operationScope = scopeKey;
    if (llmRunScopeRef.current === operationScope) return;
    llmRunScopeRef.current = operationScope;
    // 守卫后捕获可选方法：闭包内 TS 不会保留 facade.runLlmCheck 的收窄。
    const runCheck = facade.runLlmCheck;
    setRunning(true);
    setRunError(undefined);
    setCancelError(undefined);
    cancelledScopeRef.current = undefined;
    handleScopeRef.current = operationScope;
    try {
      await runTrackedOperation({
        targetHref,
        tracker,
        notifications,
        kind: "ai_check",
        label: t("security.tracker.aiCheckLabel"),
        canCancel: true,
        translate: (key, options) => String(t(key as never, options as never)),
        successNotice: () => ({ tone: "success", title: t("security.tracker.aiCheckLabel") }),
        errorNotice: (_error, message) => ({ tone: "danger", title: t("security.llm.runFailed", { message }), detail: message }),
        describeError: describeFailure,
        queryClient,
        invalidateQueryKeys: [skillLibraryKeys.root, skillDetailKeys.summary(skillId)],
        run: async (handle) => {
          handleRef.current = handle;
          await runCheck(skillId, resolvedVersionId);
        },
      });
      if (isCurrentScope(operationScope)) setReloadKey((key) => key + 1);
    } catch (reason: unknown) {
      // A run the user cancelled must not surface as a failure.
      if (cancelledScopeRef.current !== operationScope && isCurrentScope(operationScope)) {
        setRunError(describeFailure(reason));
      }
    } finally {
      if (llmRunScopeRef.current === operationScope) llmRunScopeRef.current = undefined;
      if (isCurrentScope(operationScope)) {
        setRunning(false);
        setRunningOperation(undefined);
        setCancelError(undefined);
      }
      if (handleScopeRef.current === operationScope) {
        handleScopeRef.current = undefined;
        handleRef.current = null;
      }
    }
  };
  // While a run is in flight, discover its operation id so the cancel entry
  // can target it; the native facade keeps the check discoverable.
  useEffect(() => {
    const listRunning = facade.listRunningLlmChecks;
    if (!running || !listRunning) return undefined;
    let active = true;
    const poll = async () => {
      while (active) {
        try {
          const runs = await listRunning();
          if (!active) return;
          const match = runs.find((run) => run.skillId === skillId && run.versionId === resolvedVersionId);
          setRunningOperation(match?.operationId);
          // 运行中拿到持久化 operation id 即关联同一投影（三端同一 id）。
          if (match) {
            handleRef.current?.correlate(match.operationId, targetHref);
            return;
          }
        } catch {
          // Progress discovery is best-effort; the run continues regardless.
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };
    void poll();
    return () => {
      active = false;
    };
  }, [running, facade, skillId, resolvedVersionId, targetHref]);
  const handleCancel = async () => {
    if (!runningOperation || !facade.cancelLlmCheck) return;
    const operationScope = scopeKey;
    setCancelError(undefined);
    setCancelRequested(true);
    // 先记账再等后端确认：取消请求本身是用户动作，顶栏要能看到它。
    handleRef.current?.requestCancel();
    try {
      await facade.cancelLlmCheck(runningOperation);
      cancelledScopeRef.current = operationScope;
      // 后端已确认取消：终态落 cancelled，后续命令异常不再记失败。
      handleRef.current?.markCancelled();
    } catch (reason: unknown) {
      handleRef.current?.cancelRequestFailed();
      if (isCurrentScope(operationScope)) setCancelError(describeFailure(reason));
    } finally {
      if (isCurrentScope(operationScope)) setCancelRequested(false);
    }
  };

  if (error) return <DataState message={error} state="unavailable" />;
  if (loadedScope !== scopeKey) return <DataState message={t("security.states.loading")} state="loading" />;
  const basicFindings = findings.filter((finding) => finding.kind === "basic");
  const llmFindings = findings.filter((finding) => finding.kind === "llm");
  // W3-1：预警处理留痕只来自 security_alert 投影（与列表/详情同一事实来源），
  // 有什么渲染什么，不由本页发现项重新推导，也不伪造历史处理记录。
  const alertRecord = securityAlert ? (
    <p aria-label={t("securityAlert.recordLabel")} className="sh-security-alert-record" role="status">
      <SecurityAlertBadge level={securityAlert} />
      {t("securityAlert.recordActive")}
    </p>
  ) : null;
  const highRiskCount = findings.filter((finding) => finding.highRisk).length;
  const pendingHighRisk = findings.filter((finding) => finding.highRisk && finding.disposition === "actionable").length;
  const pendingCount = findings.filter((finding) => finding.disposition === "actionable").length;
  if (variant === "drawer") {
    const basicCheck = checkByKind("basic");
    const llmCheck = checkByKind("llm");
    const basicFindings = findings.filter((finding) => finding.kind === "basic");
    const llmFindings = findings.filter((finding) => finding.kind === "llm");
    const findingDetails = (
      <div className="sh-security-results__drawer-findings-list" aria-label={t("security.findingsHeading")} role="region" tabIndex={0}>
        <FindingGroup focusedId={findingId} focusedKind={checkKind} heading={t("security.findingsBasic")} findings={basicFindings} onDisposition={(finding, disposition, options) => void handleDisposition(finding, disposition, options)} />
        <FindingGroup focusedId={findingId} focusedKind={checkKind} heading={t("security.findingsLlm")} findings={llmFindings} onDisposition={(finding, disposition, options) => void handleDisposition(finding, disposition, options)} />
      </div>
    );
    const basicFindingCount = Math.max(basicCheck?.findingCount ?? 0, basicFindings.length);
    const llmFindingCount = Math.max(llmCheck?.findingCount ?? 0, llmFindings.length);
    return (
      <div className="sh-security-results sh-security-results--drawer">
        {findingId ? <p role="status">{t(findings.some((finding) => finding.id === findingId && (!checkKind || checkKind === finding.kind) && finding.disposition === "actionable") ? "pending.focusFinding" : "pending.linkResolved")}</p> : null}
        {alertRecord}
        <div className="sh-security-results__drawer-checks">
          <DrawerCheckRow
            check={basicCheck}
            checkName={t("security.basicHeading")}
            findings={basicFindings}
            findingCount={basicFindingCount}
            kind="basic"
            onRun={() => void handleRunBasic()}
            running={basicRunning}
            versionId={resolvedVersionId}
            runAvailable={Boolean(facade.runBasicCheck)}
          />
          <DrawerCheckRow
            check={llmCheck}
            checkName={t("security.llmHeading")}
            findings={llmFindings}
            findingCount={llmFindingCount}
            kind="llm"
            onRun={() => void handleRun()}
            running={running}
            versionId={resolvedVersionId}
            runAvailable={Boolean(facade.runLlmCheck)}
            configured={llmConfigured}
            onCancel={() => void handleCancel()}
            cancelAvailable={Boolean(facade.cancelLlmCheck)}
            cancelEnabled={Boolean(runningOperation)}
            canceling={cancelRequested}
          />
        </div>
        {basicError ? <p role="alert">{t("security.basic.runFailed", { message: basicError })}</p> : null}
        {runError ? <p role="alert">{t("security.llm.runFailed", { message: runError })}</p> : null}
        {running ? <p className="sh-settings-local-note">{t("security.llm.running")}</p> : null}
        {cancelError ? <p role="alert">{t("security.llm.cancelFailed", { message: cancelError })}</p> : null}
        {dispositionError ? <p role="alert">{dispositionError}</p> : null}
        {preferences && !preferences.llmProvider.trim() ? (
          <p className="sh-security-results__drawer-config-note">
            {t("security.llm.providerMissing")} <Link to="/settings?section=networkAi">{t("security.llm.configure")}</Link>
          </p>
        ) : preferences ? (
          <p className="sh-security-results__drawer-scope">{preferences.dataScope === "explicit_selection"
            ? t("security.llm.scopeExplicitSelection")
            : t("security.llm.scopeOther", { scope: preferences.dataScope })}</p>
        ) : null}
        {findings.length > 0 ? (
          <details className="sh-security-results__drawer-findings">
            <summary>{t("security.drawer.findingsSummary", { count: findings.length })}</summary>
            {findingDetails}
          </details>
        ) : highRiskCount > 0 || pendingCount > 0 ? (
          <p className="sh-security-results__drawer-summary" role="status">
            {t("security.findingSummary", { highRisk: highRiskCount, pending: pendingCount })}
            {Math.max(basicCheck?.findingCount ?? 0, llmCheck?.findingCount ?? 0) > 0
              ? ` · ${t("security.drawer.findingListUnavailable")}`
              : null}
          </p>
        ) : findings.length === 0 && basicFindingCount === 0 && llmFindingCount === 0 ? (
          <p className="sh-security-results__drawer-empty">{t("security.noFindings")}</p>
        ) : (
          <p className="sh-security-results__drawer-summary" role="status">{t("security.drawer.findingListUnavailable")}</p>
        )}
      </div>
    );
  }
  const content = (
    <>
      {alertRecord}
      {findingId ? <p role="status">{t(findings.some((finding) => finding.id === findingId && (!checkKind || finding.kind === checkKind) && finding.disposition === "actionable") ? "pending.focusFinding" : "pending.linkResolved")}</p> : null}
      {presentationMode !== "risk-aware" ? <p aria-label={t("security.findingSummaryLabel")} className="sh-security-results__summary" role="status">
        {t("security.findingSummary", { highRisk: highRiskCount, pending: pendingCount })}
      </p> : null}
      {presentationMode === "risk-aware" ? (
        <p className="sh-skill-detail-review__safety-summary" data-testid="review-safety-summary" role="status">
          {/* W1-3 既有债：risk-aware 三分支文案全部由 i18n 承载，不再硬编码。 */}
          {pendingHighRisk
            ? t("security.riskAwareSummary", { highRisk: pendingHighRisk, pending: pendingCount })
            : t(highRiskCount ? "security.riskAware.handled" : "security.riskAware.summary", { highRisk: highRiskCount, pending: pendingCount })}
        </p>
      ) : null}
      <div className="sh-workflow-grid">
        <section aria-labelledby="basic-security-heading" className="sh-workflow-card">
          <h2 id="basic-security-heading">{t("security.basicHeading")}</h2>
          <CheckSummary check={checkByKind("basic")} notCheckedHintKey="security.notCheckedBasic" riskAware={presentationMode === "risk-aware" && basicFindings.length > 0} />
          {facade.runBasicCheck ? (
            // 与 LLM 卡同一动作槽（.sh-workflow-actions 右对齐），
            // 两张检查卡的运行按钮位置一致。
            <div className="sh-workflow-actions">
              <Button disabled={basicRunning} loading={basicRunning} onClick={() => void handleRunBasic()} size="sm">{t("security.basic.run")}</Button>
            </div>
          ) : null}
          {basicError ? <p role="alert">{t("security.basic.runFailed", { message: basicError })}</p> : null}
        </section>
        <section aria-labelledby="llm-security-heading" className="sh-workflow-card">
          <h2 id="llm-security-heading">{t("security.llmHeading")}</h2>
          <CheckSummary check={checkByKind("llm")} experimental riskAware={presentationMode === "risk-aware"} />
          <div className="sh-workflow-actions">
            <Button disabled={!llmConfigured} loading={running} onClick={() => void handleRun()} size="sm">{t("security.llm.run")}</Button>
            {running && facade.cancelLlmCheck ? (
              <Button disabled={!runningOperation} loading={cancelRequested} onClick={() => void handleCancel()} size="sm" variant="danger">{t("security.llm.cancel")}</Button>
            ) : null}
          </div>
          {running ? <p className="sh-settings-local-note">{t("security.llm.running")}</p> : null}
          {cancelError ? <p role="alert">{t("security.llm.cancelFailed", { message: cancelError })}</p> : null}
          {preferences ? (
            <p className="sh-settings-local-note">
              {preferences.llmProvider.trim()
                ? preferences.dataScope === "explicit_selection"
                  ? t("security.llm.scopeExplicitSelection")
                  : t("security.llm.scopeOther", { scope: preferences.dataScope })
                : <><span>{t("security.llm.providerMissing")}</span> {presentationMode === "risk-aware" ? <span>{t("security.llm.providerMissingPrototype")}</span> : <Link to="/settings?section=networkAi">{t("security.llm.configure")}</Link>}</>}
            </p>
          ) : null}
          {runError ? <p role="alert">{t("security.llm.runFailed", { message: runError })}</p> : null}
        </section>
      </div>
      <section aria-labelledby="security-findings-heading" className="sh-workflow-card">
        <div className="sh-section-heading"><h2 id="security-findings-heading">{t("security.findingsHeading")}</h2><span className="sh-count-badge">{findings.length}</span></div>
        {dispositionError ? <p role="alert">{dispositionError}</p> : null}
        {findings.length === 0 ? <p>{t("security.noFindings")}</p> : (
          <>
            <FindingGroup focusedId={findingId} focusedKind={checkKind} heading={t("security.findingsBasic")} findings={basicFindings} onDisposition={(finding, disposition, options) => void handleDisposition(finding, disposition, options)} />
            <FindingGroup focusedId={findingId} focusedKind={checkKind} heading={t("security.findingsLlm")} findings={llmFindings} onDisposition={(finding, disposition, options) => void handleDisposition(finding, disposition, options)} />
          </>
        )}
      </section>
    </>
  );
  if (variant === "embedded") return <div className="sh-security-results sh-security-results--embedded">{content}</div>;
  return (
    <main className="sh-page sh-workflow-page">
      <header className="sh-page__header">
        <div><p className="sh-eyebrow">{t("security.eyebrow")}</p><h1>{t("security.heading")}</h1><p>{t("security.description")}</p></div>
      </header>
      {content}
    </main>
  );
}

function DrawerCheckRow({
  check,
  checkName,
  configured = true,
  findingCount,
  findings,
  kind,
  onRun,
  onCancel,
  cancelAvailable = false,
  cancelEnabled = false,
  canceling = false,
  runAvailable,
  running,
  versionId,
}: {
  check?: SecurityCheck;
  checkName: string;
  configured?: boolean;
  findingCount: number;
  findings: SecurityFinding[];
  kind: SecurityCheck["kind"];
  onRun: () => void;
  onCancel?: () => void;
  cancelAvailable?: boolean;
  cancelEnabled?: boolean;
  canceling?: boolean;
  runAvailable: boolean;
  running: boolean;
  versionId: string;
}) {
  const { t, i18n } = useTranslation();
  const pendingCount = Math.max(check?.actionableCount ?? 0, findings.filter((finding) => finding.disposition === "actionable").length);
  const handledCount = Math.max(0, findingCount - pendingCount);
  const status = check?.state === "failed"
    ? "failed"
    : findingCount > 0
      ? "findings"
      : running || check?.state === "running"
      ? "running"
      : check?.state === "passed"
        ? "passed"
        : "notChecked";
  const checkedAt = check?.checkedAt
    ? formatCheckedAt(check.checkedAt, i18n.resolvedLanguage ?? i18n.language)
    : undefined;
  const statusLabel = t(`security.drawer.status.${status}` as never, {
    name: checkName,
    count: findingCount,
    pending: pendingCount,
  });
  const details = t("security.drawer.resultDetails", {
    name: checkName,
    status: check ? t(`security.states.${check.state}`) : t("security.states.not_checked"),
    version: versionId,
    date: checkedAt ?? t("security.drawer.dateUnavailable"),
    count: findingCount,
    pending: pendingCount,
    handled: handledCount,
  });
  const icon = status === "findings"
    ? <svg aria-hidden="true" className="sh-security-results__drawer-mark-svg" viewBox="0 0 24 24"><path className="sh-security-results__drawer-shield" d="M12 3.5 19 6v5.2c0 4.2-2.7 7.4-7 9.3-4.3-1.9-7-5.1-7-9.3V6z" /><path className="sh-security-results__drawer-warning" d="M12 8v5.2M12 16.4v.2" /></svg>
    : status === "passed"
      ? <svg aria-hidden="true" className="sh-security-results__drawer-mark-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m8 12.2 2.5 2.5 5.5-5.8" /></svg>
      : status === "failed"
        ? <svg aria-hidden="true" className="sh-security-results__drawer-mark-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg>
        : status === "running"
          ? <svg aria-hidden="true" className="sh-security-results__drawer-mark-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></svg>
          : <svg aria-hidden="true" className="sh-security-results__drawer-mark-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8v.2" /></svg>;

  return (
    <div className={`sh-security-results__drawer-row sh-security-results__drawer-row--${status}`}>
      <span aria-label={statusLabel} className="sh-security-results__drawer-mark" role="img" tabIndex={0} title={details}>
        {icon}
      </span>
      <span className="sh-security-results__drawer-name">
        {checkName}
        {/* W1-3：导入时检查的来源标注与名称同格（抽屉行是网格布局，
            不新增单元格），tone 不变。 */}
        {check?.trigger === "import" ? <small className="sh-security-results__check-source">{t("security.checkSource.import")}</small> : null}
      </span>
      <span className="sh-security-results__drawer-count">{t("security.findingCount", { count: findingCount })}</span>
      {kind === "llm" && running && cancelAvailable && onCancel ? (
        <Button className="sh-security-results__drawer-run" disabled={!cancelEnabled || canceling} loading={canceling} onClick={onCancel} size="sm" variant="danger">
          {t("security.llm.cancel")}
        </Button>
      ) : null}
      {runAvailable ? (
        <Button className="sh-security-results__drawer-run" disabled={running || (kind === "llm" && !configured)} loading={running} onClick={onRun} size="sm" variant="ghost">
          {t(kind === "basic" ? "security.drawer.basicAction" : "security.drawer.llmAction")}
        </Button>
      ) : null}
    </div>
  );
}

function findingLocation(finding: SecurityFinding): string | null {
  if (finding.line == null) return finding.file ?? null;
  const span = finding.lineEnd != null && finding.lineEnd !== finding.line ? `${finding.line}-${finding.lineEnd}` : `${finding.line}`;
  return finding.file ? `${finding.file}:${span}` : `L${span}`;
}

function FindingGroup({ heading, findings, onDisposition, focusedId, focusedKind }: {
  focusedId?: string;
  focusedKind?: string;
  heading: string;
  findings: SecurityFinding[];
  onDisposition: (finding: SecurityFinding, disposition: SecurityFinding["disposition"], options: { highRiskConfirmed: boolean }) => void;
}) {
  const { t } = useTranslation();
  if (!findings.length) return null;
  return (
    <section aria-label={heading}>
      <h3>{heading}</h3>
      <ul className="sh-workflow-list">
        {findings.map((finding) => {
          const location = findingLocation(finding);
          return (
            <li className={`sh-workflow-list__item${finding.id === focusedId && (!focusedKind || focusedKind === finding.kind) ? " sh-pending-focus" : ""}`} key={finding.id}>
              <div>
                <strong>{t("security.findingsHeading")}</strong>
                {finding.highRisk ? <StatusBadge tone="danger">{t("security.highRiskLabel")}</StatusBadge> : null}
                <p>{finding.message === finding.code ? t("pending.findingReview") : finding.message}</p>
                <small>{location ?? t("security.locationUnknown")}</small>
              </div>
              <FindingActions finding={finding} onDisposition={(disposition, options) => onDisposition(finding, disposition, options)} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const CHECK_TONES: Record<SecurityCheck["state"], "success" | "danger" | "info" | "neutral"> = {
  failed: "danger",
  not_checked: "neutral",
  passed: "success",
  running: "info",
};

function CheckSummary({ check, experimental = false, riskAware = false, notCheckedHintKey }: { check?: SecurityCheck; experimental?: boolean; riskAware?: boolean; notCheckedHintKey?: string }) {
  const { t, i18n } = useTranslation();
  // W1-3：缺记录（not_checked）态指向页内既有重查动作（如基础卡的
  // 「运行基础检查」按钮），不留死胡同；未提供引导键时保持通用文案。
  if (!check) return <p>{notCheckedHintKey ? t(notCheckedHintKey as never) : t("security.notChecked")}</p>;
  const checkedAt = formatCheckedAt(check.checkedAt, i18n.resolvedLanguage ?? i18n.language);
  const hasFindings = riskAware && check.state === "passed" && check.findingCount > 0;
  const label = hasFindings ? t("security.states.completedWithFindings") : t(`security.states.${check.state}`);
  return <div className="sh-check-summary">{riskAware ? <span className={`sh-skill-detail-review__check-icon sh-skill-detail-review__check-icon--${hasFindings ? "risk" : check.state}`} role="img" aria-label={label} title={label} tabIndex={0}>{hasFindings ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20 5v6.1c0 5.1-3.4 8.7-8 10.4-4.6-1.7-8-5.3-8-10.4V5l8-2.5Z" fill="var(--ui-warning-background)" stroke="var(--ui-warning-foreground)" /><path d="M12 7v6.5" stroke="var(--ui-danger-foreground)" strokeWidth="2.3" /><circle cx="12" cy="17" r="1.3" fill="var(--ui-danger-foreground)" /></svg> : <Icon name={check.state === "passed" ? "success" : check.state === "failed" ? "error" : "info"} size={24} />}</span> : null}<StatusBadge tone={hasFindings ? "warning" : CHECK_TONES[check.state]}>{label}</StatusBadge><strong>{t("security.findingCount", { count: check.findingCount })}</strong>{checkedAt ? <time className="sh-security-results__checked-at" dateTime={check.checkedAt}>{t("security.checkedAt", { date: checkedAt })}</time> : null}{check.trigger === "import" ? <small className="sh-security-results__check-source">{t("security.checkSource.import")}</small> : null}{experimental ? <small>{t("security.experimental")}</small> : null}</div>;
}

function formatCheckedAt(value: string | undefined, language: string): string | undefined {
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value)
    ? Number(value) * (value.length <= 10 ? 1000 : 1)
    : Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(milliseconds);
}
