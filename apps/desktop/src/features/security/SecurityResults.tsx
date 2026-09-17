import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation, type TrackedOperationHandle } from "../../platform/runTrackedOperation";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { StatusBadge } from "../../ui/StatusBadge";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { FindingActions } from "./FindingActions";
import { type SecurityCheck, type SecurityFacade, type SecurityFinding, type SecurityPreferences, unavailableSecurityFacade } from "./api";

export interface SecurityResultsProps {
  facade?: SecurityFacade;
  skillId: string;
  versionId: string;
  /** 统一执行桥的在途投影；测试可注入独立实例，默认模块级单例。 */
  tracker?: OperationTracker;
}

export function SecurityResults({ facade = unavailableSecurityFacade, skillId, tracker = operationTracker, versionId }: SecurityResultsProps) {
  const { t } = useTranslation();
  const notifications = useOptionalAppNotifications();
  const [checks, setChecks] = useState<SecurityCheck[]>([]);
  const [findings, setFindings] = useState<SecurityFinding[]>([]);
  const [preferences, setPreferences] = useState<SecurityPreferences>();
  const [error, setError] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.all([
      facade.getChecks(skillId, versionId),
      facade.listFindings(skillId, versionId),
      facade.getPreferences?.().catch(() => undefined),
    ])
      .then(([nextChecks, nextFindings, nextPreferences]) => {
        if (!active) return;
        setChecks(nextChecks);
        setFindings(nextFindings);
        setPreferences(nextPreferences);
      })
      .catch((reason: unknown) => { if (active) setError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "security.errors.generic")); });
    return () => { active = false; };
  }, [facade, skillId, versionId, reloadKey]);

  const checkByKind = (kind: SecurityCheck["kind"]) => checks.find((check) => check.kind === kind);
  // 统一执行反馈（任务 4）：处置是用户可触发的单次写入，失败必须可见——
  // 之前 `void handleDisposition(...)` 会把拒绝吞掉，页面既不更新也不报错。
  const [dispositionError, setDispositionError] = useState<string>();
  const handleDisposition = async (finding: SecurityFinding, disposition: SecurityFinding["disposition"], options: { highRiskConfirmed: boolean }) => {
    setDispositionError(undefined);
    try {
      await runTrackedOperation({
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
        run: () =>
          facade.setFindingDisposition(
            finding,
            disposition,
            skillId,
            versionId,
            options.highRiskConfirmed,
          ),
      });
      setFindings((current) => current.map((item) => item.id === finding.id ? { ...item, disposition } : item));
    } catch (reason: unknown) {
      // 处置未保存：列表保持原状态，并把原因留在页面上（通知只是补充）。
      setDispositionError(
        describeNativeError(reason, (key, options_) => String(t(key as never, options_ as never)), "security.errors.generic"),
      );
    }
  };
  const llmConfigured = preferences ? preferences.llmProvider.trim().length > 0 : true;
  const [runningOperation, setRunningOperation] = useState<string | undefined>(undefined);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelledRef = useRef(false);
  // 统一执行桥（任务 4）：在途句柄挂在 ref 上，供取消路径与运行中的
  // operation id 发现逻辑随时关联/落终态。
  const handleRef = useRef<TrackedOperationHandle | null>(null);
  const handleRun = async () => {
    if (!facade.runLlmCheck || !llmConfigured) return;
    // 守卫后捕获可选方法：闭包内 TS 不会保留 facade.runLlmCheck 的收窄。
    const runCheck = facade.runLlmCheck;
    setRunning(true);
    setRunError(undefined);
    cancelledRef.current = false;
    try {
      await runTrackedOperation({
        tracker,
        notifications,
        kind: "ai_check",
        label: t("security.tracker.aiCheckLabel"),
        canCancel: true,
        translate: (key, options) => String(t(key as never, options as never)),
        successNotice: () => ({ tone: "success", title: t("security.tracker.aiCheckLabel") }),
        errorNotice: (_error, message) => ({ tone: "danger", title: t("security.llm.runFailed", { message }), detail: message }),
        run: async (handle) => {
          handleRef.current = handle;
          await runCheck(skillId, versionId);
        },
      });
      setReloadKey((key) => key + 1);
    } catch (reason: unknown) {
      // A run the user cancelled must not surface as a failure.
      if (!cancelledRef.current) {
        setRunError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "security.errors.generic"));
      }
    } finally {
      setRunning(false);
      setRunningOperation(undefined);
      handleRef.current = null;
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
          const match = runs.find((run) => run.skillId === skillId && run.versionId === versionId);
          setRunningOperation(match?.operationId);
          // 运行中拿到持久化 operation id 即关联同一投影（三端同一 id）。
          if (match) {
            handleRef.current?.correlate(match.operationId);
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
  }, [running, facade, skillId, versionId]);
  const handleCancel = async () => {
    if (!runningOperation || !facade.cancelLlmCheck) return;
    setCancelRequested(true);
    // 先记账再等后端确认：取消请求本身是用户动作，顶栏要能看到它。
    handleRef.current?.requestCancel();
    try {
      await facade.cancelLlmCheck(runningOperation);
      cancelledRef.current = true;
      // 后端已确认取消：终态落 cancelled，后续命令异常不再记失败。
      handleRef.current?.markCancelled();
    } finally {
      setCancelRequested(false);
    }
  };

  if (error) return <DataState message={error} state="unavailable" />;
  if (!checks.length && !findings.length) return <DataState message={t("security.states.loading")} state="loading" />;
  const basicFindings = findings.filter((finding) => finding.kind === "basic");
  const llmFindings = findings.filter((finding) => finding.kind === "llm");
  return (
    <main className="sh-page sh-workflow-page">
      <header className="sh-page__header">
        <div><p className="sh-eyebrow">{t("security.eyebrow")}</p><h1>{t("security.heading")}</h1><p>{t("security.description")}</p></div>
      </header>
      <div className="sh-workflow-grid">
        <section aria-labelledby="basic-security-heading" className="sh-workflow-card">
          <h2 id="basic-security-heading">{t("security.basicHeading")}</h2>
          <CheckSummary check={checkByKind("basic")} />
        </section>
        <section aria-labelledby="llm-security-heading" className="sh-workflow-card">
          <h2 id="llm-security-heading">{t("security.llmHeading")}</h2>
          <CheckSummary check={checkByKind("llm")} experimental />
          <div className="sh-workflow-actions">
            <Button disabled={!llmConfigured} loading={running} onClick={() => void handleRun()} size="sm">{t("security.llm.run")}</Button>
            {running && facade.cancelLlmCheck ? (
              <Button disabled={!runningOperation} loading={cancelRequested} onClick={() => void handleCancel()} size="sm" variant="danger">{t("security.llm.cancel")}</Button>
            ) : null}
          </div>
          {running ? <p className="sh-settings-local-note">{t("security.llm.running")}</p> : null}
          {preferences ? (
            <p className="sh-settings-local-note">
              {preferences.llmProvider.trim()
                ? preferences.dataScope === "explicit_selection"
                  ? t("security.llm.scopeExplicitSelection")
                  : t("security.llm.scopeOther", { scope: preferences.dataScope })
                : t("security.llm.providerMissing")}
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
            <FindingGroup heading={t("security.findingsBasic")} findings={basicFindings} onDisposition={(finding, disposition, options) => void handleDisposition(finding, disposition, options)} />
            <FindingGroup heading={t("security.findingsLlm")} findings={llmFindings} onDisposition={(finding, disposition, options) => void handleDisposition(finding, disposition, options)} />
          </>
        )}
      </section>
    </main>
  );
}

function findingLocation(finding: SecurityFinding): string | null {
  if (finding.line == null) return finding.file ?? null;
  const span = finding.lineEnd != null && finding.lineEnd !== finding.line ? `${finding.line}-${finding.lineEnd}` : `${finding.line}`;
  return finding.file ? `${finding.file}:${span}` : `L${span}`;
}

function FindingGroup({ heading, findings, onDisposition }: {
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
            <li className="sh-workflow-list__item" key={finding.id}>
              <div>
                <strong>{finding.code}</strong>
                {finding.highRisk ? <StatusBadge tone="danger">{t("security.highRiskLabel")}</StatusBadge> : null}
                <p>{finding.message}</p>
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

function CheckSummary({ check, experimental = false }: { check?: SecurityCheck; experimental?: boolean }) {
  const { t } = useTranslation();
  if (!check) return <p>{t("security.notChecked")}</p>;
  return <div className="sh-check-summary"><StatusBadge tone={CHECK_TONES[check.state]}>{t(`security.states.${check.state}`)}</StatusBadge><strong>{t("security.findingCount", { count: check.findingCount })}</strong>{experimental ? <small>{t("security.experimental")}</small> : null}</div>;
}
