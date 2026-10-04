import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import type {
  DeploymentRecord,
  ExportDecision,
  ExportInput,
  ExportPlan,
  OperationSummary,
  RestoreConflict,
  RestoreDecision,
  RestorePlan,
  RestoreResult,
  UninstallAction,
  UninstallImpact,

  BackupRetentionResult,
} from "../../api/bindings";
import { describeNativeError } from "../../api/nativeErrors";
import { desktopDirectoryPicker } from "../../platform/directoryPicker";
import { desktopDirectoryOpener } from "../../platform/directoryOpener";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { useOptionalAppNotifications } from "../../ui/notifications";
import type { BackupFacade } from "./api";
import { displayPath } from "../../platform/displayPath";
import "./dataProtection.css";

type Decision = "overwrite" | "keep_both" | "skip";
type SensitiveDecision = "resolve_first" | "exclude_skill" | "include_and_mark";

/**
 * K3 契约钉死的导出敏感项（§K3 DTO 落点：ExportSensitiveItem，
 * `path` 为版本内相对路径）。K3-A 后端尚未落地：api/bindings.ts 的
 * SensitiveItem 目前只有 skill_id + reason，故 version_id/path 在此按契约
 * 局部声明为可选字段，运行时载荷一旦携带即直接呈现。待 A 绑定对齐后回填
 * 生成绑定，不手改 bindings。
 */
type ExportSensitiveItem = {
  skill_id: string;
  version_id?: string;
  path?: string;
  reason: string;
};

/**
 * K3：扫描原因是内部枚举，映射为用户事实文案；映射未跟上的新枚举回退原文，
 * 由补映射修复，不在渲染层编造（与 operations KIND_LABEL_KEYS 同一口径）。
 */
const SENSITIVE_REASON_KEYS: Record<string, string> = {
  possible_plaintext_credential: "dataProtection.export.reasons.possible_plaintext_credential",
  sensitive_filename: "dataProtection.export.reasons.sensitive_filename",
};

function sensitiveReasonText(reason: string, translate: (key: string) => string): string {
  const key = SENSITIVE_REASON_KEYS[reason];
  if (!key) return reason;
  const translated = translate(key);
  return translated === key ? reason : translated;
}

/**
 * K3 预览绑定（§2 三件套）：preview 绑定主体/版本/格式/授权输出位置，
 * 指纹不含用户决定（决定是 Commit 阶段随 preview_id 一并提交的响应）。
 * 前端在预览成功时快照这四项输入，此后任一改变即判定旧预览失效。
 */
function exportPreviewFingerprint(
  skillIds: string[],
  format: string | undefined,
  versionScope: string,
  outputDir: string | null,
): string {
  return JSON.stringify({ skills: skillIds, format, versionScope, outputDir });
}

interface OutputDirectoryPicker {
  pickDirectory: () => Promise<string | null>;
}

/**
 * Version lookup outcome for a skill carried over from the library.
 * `unavailable` means the lookup itself failed; the reason is never invented.
 */
type ExportReadiness =
  | { state: "ready"; versionId: string }
  | { state: "no_current_version" }
  | { state: "unavailable" };

function readCarriedExportSkillIds(state: unknown): string[] {
  if (typeof state !== "object" || state === null) return [];
  const carried = (state as { exportSkillIds?: unknown }).exportSkillIds;
  if (!Array.isArray(carried) || carried.some((id) => typeof id !== "string")) return [];
  return [...new Set(carried as string[])].filter((id) => id.trim().length > 0);
}

export function DataProtectionPage({
  facade,
  directoryPicker = desktopDirectoryPicker,
  directoryOpener = desktopDirectoryOpener,
  tracker = operationTracker,
}: {
  facade: BackupFacade;
  directoryPicker?: OutputDirectoryPicker;
  directoryOpener?: { openDirectory: (path: string) => Promise<void> };
  /** 统一执行桥的在途投影；测试可注入独立实例。 */
  tracker?: OperationTracker;
}) {
  const { t } = useTranslation();
  const notifications = useOptionalAppNotifications();
  const location = useLocation();
  const [path, setPath] = useState("");
  const [verifyMessage, setVerifyMessage] = useState<string>();
  const [restorePlan, setRestorePlan] = useState<RestorePlan>();
  const [restoreDecisions, setRestoreDecisions] = useState<Record<string, Decision>>({});
  const [restoreResult, setRestoreResult] = useState<RestoreResult>();
  const [exportSkillIds, setExportSkillIds] = useState("");
  const [exportFormat, setExportFormat] = useState<ExportInput["format"]>("folder");
  // N10：版本范围——仅当前版本或全部历史版本（历史范围按真实版本列表展开）。
  const [exportVersionScope, setExportVersionScope] = useState<"current" | "history">("current");
  const [outputDir, setOutputDir] = useState<string>();
  const [libraryPath, setLibraryPath] = useState<string>();
  const [pickerError, setPickerError] = useState<string>();
  const [rollingMax, setRollingMax] = useState(3);
  const [rollingBusy, setRollingBusy] = useState(false);
  const [rollingResult, setRollingResult] = useState<BackupRetentionResult>();
  const [rollingError, setRollingError] = useState<string>();
  const runRolling = async () => {
    setRollingBusy(true);
    setRollingError(undefined);
    try {
      setRollingResult(await facade.runRollingBackup!({
        decisions: [],
        retention: { max_backups: rollingMax },
        scope: "full",
      }));
    } catch (reason) {
      setRollingError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "tasks.notices.failureUnknown"));
    } finally {
      setRollingBusy(false);
    }
  };
  const [exportPlan, setExportPlan] = useState<ExportPlan>();
  const [exportDecisions, setExportDecisions] = useState<Record<string, SensitiveDecision>>({});
  // K3 预览冻结：预览成功时快照四项绑定输入；快照与当前输入不一致即视为
  // 旧预览失效（派生值，不在 effect 里回写状态）。
  const [exportPreviewInputs, setExportPreviewInputs] = useState<string>();
  const [exportPath, setExportPath] = useState<string>();
  const [carriedSkillIds, setCarriedSkillIds] = useState<string[]>([]);
  const [versionReadiness, setVersionReadiness] = useState<Record<string, ExportReadiness>>({});
  const [deployments, setDeployments] = useState<DeploymentRecord[]>();
  const [deploymentError, setDeploymentError] = useState<string>();
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState<string[]>([]);
  const [uninstallImpact, setUninstallImpact] = useState<UninstallImpact>();
  const [uninstallActions, setUninstallActions] = useState<UninstallAction[]>([]);
  const [uninstallResult, setUninstallResult] = useState<OperationSummary>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // 「退出管理」列出的是仍然存在的部署关系：`removed` 行只是账目历史，磁盘上
  // 已经没有对应副本了，列出来会让用户去处置一个并不存在的关系。
  const visibleDeployments = deployments?.filter((deployment) => deployment.state !== "removed") ?? [];

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await action(); } catch (reason) { setError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "tasks.notices.failureUnknown")); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const skillIds = readCarriedExportSkillIds(location.state);
    if (skillIds.length === 0) return;
    setExportSkillIds(skillIds.join(", "));
    setCarriedSkillIds(skillIds);
    let cancelled = false;
    for (const skillId of skillIds) {
      facade.listVersions(skillId).then(
        (versions) => {
          if (cancelled) return;
          const current = versions.find((version) => version.current);
          setVersionReadiness((previous) => ({
            ...previous,
            [skillId]: current
              ? { state: "ready", versionId: current.version_id }
              : { state: "no_current_version" },
          }));
        },
        () => {
          if (cancelled) return;
          setVersionReadiness((previous) => ({ ...previous, [skillId]: { state: "unavailable" } }));
        },
      );
    }
    return () => { cancelled = true; };
  }, [facade, location.state]);

  useEffect(() => {
    let cancelled = false;
    facade.libraryPath?.().then(
      (value) => { if (!cancelled) setLibraryPath(value); },
      () => { if (!cancelled) setLibraryPath(undefined); },
    );
    return () => { cancelled = true; };
  }, [facade]);
  useEffect(() => {
    let cancelled = false;
    facade.listDeployments().then(
      (records) => { if (!cancelled) setDeployments(records); },
      (reason: unknown) => {
        if (cancelled) return;
        setDeploymentError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "tasks.notices.failureUnknown"));
      },
    );
    return () => { cancelled = true; };
  }, [facade]);

  const reviewRestore = () => run(async () => {
    if (!path.trim()) return;
    setRestoreResult(undefined);
    setRestoreDecisions({});
    setRestorePlan(await facade.prepareRestore(path.trim()));
  });
  const commitRestore = () => run(async () => {
    if (!restorePlan) return;
    const decisions = restorePlan.conflicts.filter((conflict) => conflict.skill_id).map((conflict) => ({ skill_id: conflict.skill_id!, decision: restoreDecisions[conflict.skill_id!] })) as RestoreDecision[];
    // 统一执行桥（任务 4）：恢复提交进 tracker 在途投影与通知中心；
    // 页面仍保留结果详情，异常由页面 run() 承接，不吞掉。
    const result = await runTrackedOperation({
      tracker,
      notifications,
      kind: "restore",
      label: t("dataProtection.tracker.restoreLabel"),
      total: restorePlan.skills,
      translate: (key, options) => String(t(key as never, options as never)),
      successNotice: () => ({ tone: "success", title: t("dataProtection.tracker.restoreLabel") }),
      errorNotice: (_error, message) => ({ tone: "danger", title: t("dataProtection.tracker.restoreLabel"), detail: message }),
      summarize: (settled) => ({
        succeeded: settled.skills_restored,
        failed: 0,
        skipped: settled.skills_skipped,
      }),
      run: () => facade.commitRestore(path.trim(), decisions),
    });
    setRestoreResult(result);
  });
  const buildVersions = async (skillIds: string[]): Promise<ExportInput["versions"]> => {
    if (exportVersionScope === "current") return "current";
    // N10：全部历史版本——并行读取各 Skill 的版本列表后展开，避免串行 IPC。
    const versionLists = await Promise.all(skillIds.map((skillId) => facade.listVersions(skillId)));
    return { history: versionLists.flat().map((version) => version.version_id) };
  };
  const reviewExport = () => run(async () => {
    if (!exportSkillIds.trim()) return;
    setExportPath(undefined);
    setExportDecisions({});
    const skillIds = exportSkillIds.split(",").map((id) => id.trim()).filter(Boolean);
    const input: ExportInput = { selection: { skills: skillIds }, versions: await buildVersions(skillIds), skills: [], format: exportFormat, output_dir: outputDir ?? null };
    const plan = await facade.prepareExport(input);
    setExportPlan(plan);
    // 快照记录的是预览实际据以计算的输入（闭包值）：请求在途时用户改输入，
    // 响应落地后派生 staleness 同样成立，旧预览不会冒充新选择的预览。
    setExportPreviewInputs(exportPreviewFingerprint(skillIds, exportFormat, exportVersionScope, outputDir ?? null));
  });
  const commitExport = () => run(async () => {
    if (!exportPlan) return;
    const skillIds = exportSkillIds.split(",").map((id) => id.trim()).filter(Boolean);
    // K3 预览冻结兜底：入口在失效时已撤下，这里再拦一道，绝不拿旧预览落盘。
    if (exportPreviewInputs !== exportPreviewFingerprint(skillIds, exportFormat, exportVersionScope, outputDir ?? null)) {
      setError(t("dataProtection.export.previewInvalidatedNotice"));
      return;
    }
    const input: ExportInput = { selection: { skills: skillIds }, versions: await buildVersions(skillIds), skills: [], format: exportFormat, output_dir: outputDir ?? null };
    const decisions: ExportDecision[] = exportPlan.sensitive_items.map((item) => ({ skill_id: item.skill_id, decision: exportDecisions[item.skill_id] })) as ExportDecision[];
    const result = await facade.createExport(input, decisions);
    setExportPath(result.path);
  });
  const pickOutputDirectory = () => run(async () => {
    setPickerError(undefined);
    const picked = await directoryPicker.pickDirectory();
    if (picked) setOutputDir(picked);
  });
  const toggleDeploymentSelection = (deploymentId: string) => {
    setSelectedDeploymentIds((current) => current.includes(deploymentId)
      ? current.filter((id) => id !== deploymentId)
      : [...current, deploymentId]);
  };
  const previewUninstall = () => run(async () => {
    if (selectedDeploymentIds.length === 0) return;
    setUninstallResult(undefined);
    setUninstallActions([]);
    setUninstallImpact(await facade.prepareUninstall([...selectedDeploymentIds]));
  });
  const applyUninstall = () => run(async () => {
    if (!uninstallImpact || uninstallActions.length === 0) return;
    setUninstallResult(await facade.applyUninstallDecision([...uninstallActions]));
  });
  const toggleUninstallAction = (action: UninstallAction) => {
    setUninstallActions((current) => current.includes(action)
      ? current.filter((selected) => selected !== action)
      : [...current, action]);
  };
  const hasRestoreDecisions = Boolean(restorePlan) && restorePlan!.conflicts.every((conflict) => !conflict.skill_id || restoreDecisions[conflict.skill_id]);
  const hasInvalidConflict = restorePlan?.conflicts.some((conflict) => conflict.kind === "invalid_portable_data") ?? false;
  const hasExportDecisions = Boolean(exportPlan) && exportPlan!.sensitive_items.every((item) => exportDecisions[item.skill_id]);
  // K3 预览冻结（§K3-1）：任一绑定输入（主体/版本范围/格式/输出目录）在
  // 预览后发生改变，旧预览即失效——提示重新预览并撤下创建入口；敏感决定
  // 是 Commit 阶段随 preview_id 提交的响应，不参与失效判定。
  const exportPreviewStale = Boolean(exportPlan) && exportPreviewInputs !== exportPreviewFingerprint(
    exportSkillIds.split(",").map((id) => id.trim()).filter(Boolean),
    exportFormat,
    exportVersionScope,
    outputDir ?? null,
  );
  const exportPreviewValid = Boolean(exportPlan) && !exportPreviewStale;

  return (
    <main className="sh-page sh-workflow-page">
      <header className="sh-page__header"><div><p className="sh-eyebrow">{t("dataProtection.eyebrow")}</p><h1>{t("dataProtection.heading")}</h1><p>{t("dataProtection.description")}</p></div></header>
      {error ? <p className="sh-settings-error" role="alert">{error}</p> : null}
      {busy ? <p className="sh-settings-status" role="status">{t("dataProtection.working")}</p> : null}
      <section className="sh-workflow-card">
        <h2>{t("dataProtection.openLibrary.heading")}</h2>
        <p>{t("dataProtection.openLibrary.description")}</p>
        <div className="sh-button-row">
          <Button
            disabled={!libraryPath || busy}
            onClick={() => void run(async () => {
              if (!libraryPath) return;
              await directoryOpener.openDirectory(libraryPath);
            })}
            variant="secondary"
          >
            {t("dataProtection.openLibrary.open")}
          </Button>
          {libraryPath ? <span role="status">{displayPath(libraryPath)}</span> : <span>{t("dataProtection.openLibrary.pathUnknown")}</span>}
        </div>
        <p>{t("dataProtection.recoveryPointNote")}</p>
      </section>
      <section className="sh-workflow-card">
        <h2>{t("dataProtection.restore.heading")}</h2>
        <label>{t("dataProtection.restore.path")}<input aria-label={t("dataProtection.restore.path")} value={path} onChange={(event) => setPath(event.target.value)} placeholder="C:/SkillHub/backups/backup.skillhub" /></label>
        <div className="sh-button-row"><Button disabled={!path.trim() || busy} onClick={() => void run(async () => { await facade.verifyBackup(path.trim()); setVerifyMessage(t("dataProtection.restore.verified")); })} variant="secondary">{t("dataProtection.restore.verify")}</Button><Button disabled={!path.trim() || busy} onClick={() => void reviewRestore()}>{t("dataProtection.restore.review")}</Button></div>
        {verifyMessage ? <p role="status">{verifyMessage}</p> : null}
        {restorePlan ? <RestoreReview conflicts={restorePlan.conflicts} decisions={restoreDecisions} onDecision={(skillId, decision) => setRestoreDecisions((current) => ({ ...current, [skillId]: decision }))} plan={restorePlan} /> : null}
        {restorePlan ? <Button disabled={busy || !hasRestoreDecisions || hasInvalidConflict} onClick={() => void commitRestore()}>{t("dataProtection.restore.commit")}</Button> : null}
        {restoreResult ? <p role="status">{t("dataProtection.restore.result", restoreResult)}</p> : null}
      </section>
      <section className="sh-workflow-card">
        <h2>{t("dataProtection.export.heading")}</h2>
        <label>{t("dataProtection.export.skillIds")}<input aria-label={t("dataProtection.export.skillIds")} value={exportSkillIds} onChange={(event) => setExportSkillIds(event.target.value)} placeholder="skill-1, skill-2" /></label>
        <label>{t("dataProtection.export.format")}<select aria-label={t("dataProtection.export.format")} value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportInput["format"])}>
          <option value="folder">{t("dataProtection.export.formatFolder")}</option>
          <option value="zip">{t("dataProtection.export.formatZip")}</option>
        </select></label>
        <label>{t("dataProtection.export.versionScope")}<select aria-label={t("dataProtection.export.versionScope")} value={exportVersionScope} onChange={(event) => setExportVersionScope(event.target.value as "current" | "history")}>
          <option value="current">{t("dataProtection.export.versionCurrent")}</option>
          <option value="history">{t("dataProtection.export.versionHistory")}</option>
        </select></label>
        <p>{t("dataProtection.export.formatHint")}</p>
        <div className="sh-button-row">
          <Button disabled={busy} onClick={() => void pickOutputDirectory()} variant="secondary">
            {t("dataProtection.export.pickOutputDir")}
          </Button>
          {outputDir ? <span role="status">{outputDir}</span> : <span>{t("dataProtection.export.outputDirDefault")}</span>}
        </div>
        {pickerError ? <p role="alert">{pickerError}</p> : null}
        {carriedSkillIds.length > 0 ? (
          <div>
            <p>{t("backup.export.prefilled", { count: carriedSkillIds.length })}</p>
            <p>{t("backup.export.readinessTitle")}</p>
            <ul>
              {carriedSkillIds.map((skillId) => {
                const readiness = versionReadiness[skillId];
                const status = !readiness
                  ? t("backup.export.checking")
                  : readiness.state === "ready"
                    ? t("backup.export.ready", { versionId: readiness.versionId })
                    : readiness.state === "no_current_version"
                      ? t("backup.export.noCurrentVersion")
                      : t("backup.export.unavailable");
                return <li key={skillId}>{skillId}: {status}</li>;
              })}
            </ul>
          </div>
        ) : null}
        <Button disabled={!exportSkillIds.trim() || busy} onClick={() => void reviewExport()}>{t("dataProtection.export.review")}</Button>
        {exportPreviewStale ? (
          <p className="sh-export-preview-invalidated" role="status">
            <Icon name="warning" size={16} />
            {t("dataProtection.export.previewInvalidatedNotice")}
          </p>
        ) : null}
        {exportPreviewValid ? <ExportReview plan={exportPlan!} decisions={exportDecisions} onDecision={(skillId, decision) => setExportDecisions((current) => ({ ...current, [skillId]: decision }))} /> : null}
        {exportPreviewValid ? <Button disabled={busy || !hasExportDecisions} onClick={() => void commitExport()}>{t("dataProtection.export.commit")}</Button> : null}
        {exportPath ? <p role="status">{t("dataProtection.export.result", { path: exportPath })}</p> : null}
      </section>
      <section className="sh-workflow-card">
        <h2>{t("backup.retention.heading")}</h2>
        <p>{t("backup.retention.description")}</p>
        <label className="sh-workflow-actions">
          <span>{t("backup.retention.maxBackups")}</span>
          <input
            aria-label={t("backup.retention.maxBackups")}
            min={1}
            onChange={(event) => setRollingMax(Number(event.target.value) || 1)}
            style={{ width: "5rem" }}
            type="number"
            value={rollingMax}
          />
        </label>
        <Button disabled={rollingBusy} onClick={() => void runRolling()}>
          {rollingBusy ? t("backup.retention.running") : t("backup.retention.run")}
        </Button>
        <p>{t("backup.retention.cacheNote")}</p>
        {rollingError ? <p role="alert">{t("backup.retention.failed", { error: rollingError })}</p> : null}
        {rollingResult ? (
          <p role="status">
            {t("backup.retention.result", { retained: rollingResult.retained, removed: rollingResult.removed })}
          </p>
        ) : null}
      </section>
      <section className="sh-workflow-card">
        <h2>{t("backup.uninstall.heading")}</h2>
        <p>{t("backup.uninstall.description")}</p>
        <p className="sh-settings-note">{t("backup.uninstall.scenario")}</p>
        {deploymentError ? <p role="alert">{deploymentError}</p> : null}
        {deployments ? (
          visibleDeployments.length === 0
            ? <p>{t("backup.uninstall.noDeployments")}</p>
            : visibleDeployments.map((deployment) => (
              <label key={deployment.id}>
                <input
                  aria-label={t("backup.uninstall.selectDeployment", { id: deployment.id })}
                  checked={selectedDeploymentIds.includes(deployment.id)}
                  onChange={() => toggleDeploymentSelection(deployment.id)}
                  type="checkbox"
                />
                {t("backup.uninstall.deploymentLabel", { ...deployment, state: t(`backup.uninstall.deploymentState.${deployment.state}`) })}
              </label>
            ))
        ) : !deploymentError ? <p role="status">{t("backup.uninstall.loadingDeployments")}</p> : null}
        <div className="sh-button-row">
          <Button disabled={selectedDeploymentIds.length === 0 || busy} onClick={() => void previewUninstall()}>{t("backup.uninstall.preview")}</Button>
          <Button disabled={!uninstallImpact || uninstallActions.length === 0 || busy} onClick={() => void applyUninstall()}>{t("backup.uninstall.apply")}</Button>
        </div>
        {uninstallImpact ? <UninstallReview impact={uninstallImpact} onToggle={toggleUninstallAction} selected={uninstallActions} /> : null}
        {uninstallResult ? <p role="status">{t("backup.uninstall.applied", { phase: uninstallResult.phase })}</p> : null}
      </section>
    </main>
  );
}

function RestoreReview({ plan, conflicts, decisions, onDecision }: { plan: RestorePlan; conflicts: RestoreConflict[]; decisions: Record<string, Decision>; onDecision: (skillId: string, decision: Decision) => void }) {
  const { t } = useTranslation();
  return <div><p>{t("dataProtection.restore.summary", plan)}</p>{conflicts.map((conflict, index) => <div key={`${conflict.skill_id ?? "invalid"}-${index}`}><p>{conflict.detail}</p>{conflict.skill_id ? <label>{t("dataProtection.restore.decision", { skillId: conflict.skill_id })}<select aria-label={t("dataProtection.restore.decision", { skillId: conflict.skill_id })} value={decisions[conflict.skill_id] ?? ""} onChange={(event) => onDecision(conflict.skill_id!, event.target.value as Decision)}><option value="">{t("dataProtection.restore.choose")}</option><option value="overwrite">{t("dataProtection.restore.overwrite")}</option><option value="keep_both">{t("dataProtection.restore.keepBoth")}</option><option value="skip">{t("dataProtection.restore.skip")}</option></select></label> : <strong>{t("dataProtection.restore.invalid")}</strong>}</div>)}</div>;
}

function ExportReview({ plan, decisions, onDecision }: { plan: ExportPlan; decisions: Record<string, SensitiveDecision>; onDecision: (skillId: string, decision: SensitiveDecision) => void }) {
  const { t } = useTranslation();
  // K3-B 扫描结果：按「文件 + 可读原因」呈现。旧后端载荷暂无 path，缺省时
  // 以 Skill 标识占位保持同一布局槽位；待 A 绑定对齐后 path 恒存在。
  const items = plan.sensitive_items as ExportSensitiveItem[];
  return (
    <div>
      <p>{t("dataProtection.export.summary", { count: plan.skills.length })}</p>
      {items.length > 0 ? <p>{t("dataProtection.export.scanHeading")}</p> : null}
      <ul className="sh-export-scan">
        {items.map((item, index) => (
          <li className="sh-export-scan__item" key={`${item.skill_id}:${item.path ?? ""}:${index}`}>
            <p className="sh-export-scan__path">{item.path ?? item.skill_id}</p>
            <p className="sh-export-scan__reason">
              <Icon name="warning" size={14} />
              {sensitiveReasonText(item.reason, (key) => t(key as never))}
            </p>
            <label>
              {t("dataProtection.export.decision", { skillId: item.skill_id })}
              <select aria-label={t("dataProtection.export.decision", { skillId: item.skill_id })} value={decisions[item.skill_id] ?? ""} onChange={(event) => onDecision(item.skill_id, event.target.value as SensitiveDecision)}><option value="">{t("dataProtection.export.choose")}</option><option value="resolve_first">{t("dataProtection.export.resolve")}</option><option value="exclude_skill">{t("dataProtection.export.exclude")}</option><option value="include_and_mark">{t("dataProtection.export.include")}</option></select>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UninstallReview({ impact, selected, onToggle }: { impact: UninstallImpact; selected: UninstallAction[]; onToggle: (action: UninstallAction) => void }) {
  const { t } = useTranslation();
  return (
    <div>
      <p>{t("backup.uninstall.impactSummary", { count: impact.deployments.length })}</p>
      <p>{impact.preserves_central_library ? t("backup.uninstall.preservesYes") : t("backup.uninstall.preservesNo")}</p>
      <p>{t("backup.uninstall.actionsHeading")}</p>
      {impact.actions.map((action) => (
        <label key={action}>
          <input
            aria-label={t(`backup.uninstall.actions.${action}`)}
            checked={selected.includes(action)}
            onChange={() => onToggle(action)}
            type="checkbox"
          />
          {t(`backup.uninstall.actions.${action}`)}
        </label>
      ))}
    </div>
  );
}
