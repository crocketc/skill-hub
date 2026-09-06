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
import { desktopDirectoryPicker } from "../../platform/directoryPicker";
import { desktopDirectoryOpener } from "../../platform/directoryOpener";
import { Button } from "../../ui/Button";
import type { BackupFacade } from "./api";

type Decision = "overwrite" | "keep_both" | "skip";
type SensitiveDecision = "resolve_first" | "exclude_skill" | "include_and_mark";

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
}: {
  facade: BackupFacade;
  directoryPicker?: OutputDirectoryPicker;
  directoryOpener?: { openDirectory: (path: string) => Promise<void> };
}) {
  const { t } = useTranslation();
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
      setRollingError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRollingBusy(false);
    }
  };
  const [exportPlan, setExportPlan] = useState<ExportPlan>();
  const [exportDecisions, setExportDecisions] = useState<Record<string, SensitiveDecision>>({});
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

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
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
        setDeploymentError(reason instanceof Error ? reason.message : String(reason));
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
    setRestoreResult(await facade.commitRestore(path.trim(), decisions));
  });
  const buildVersions = async (skillIds: string[]): Promise<ExportInput["versions"]> => {
    if (exportVersionScope === "current") return "current";
    // N10：全部历史版本——逐个 Skill 读取真实版本列表后展开。
    const ids: string[] = [];
    for (const skillId of skillIds) {
      const versions = await facade.listVersions(skillId);
      for (const version of versions) ids.push(version.version_id);
    }
    return { history: ids };
  };
  const reviewExport = () => run(async () => {
    if (!exportSkillIds.trim()) return;
    setExportPath(undefined);
    setExportDecisions({});
    const skillIds = exportSkillIds.split(",").map((id) => id.trim()).filter(Boolean);
    const input: ExportInput = { selection: { skills: skillIds }, versions: await buildVersions(skillIds), skills: [], format: exportFormat, output_dir: outputDir ?? null };
    setExportPlan(await facade.prepareExport(input));
  });
  const commitExport = () => run(async () => {
    if (!exportPlan) return;
    const skillIds = exportSkillIds.split(",").map((id) => id.trim()).filter(Boolean);
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

  return (
    <main className="sh-page sh-workflow-page">
      <header className="sh-page__header"><div><p className="sh-eyebrow">{t("dataProtection.eyebrow")}</p><h1>{t("dataProtection.heading")}</h1><p>{t("dataProtection.description")}</p></div></header>
      {error ? <p className="sh-settings-error" role="alert">{error}</p> : null}
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
          {libraryPath ? <span role="status">{libraryPath}</span> : <span>{t("dataProtection.openLibrary.pathUnknown")}</span>}
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
        {exportPlan ? <ExportReview plan={exportPlan} decisions={exportDecisions} onDecision={(skillId, decision) => setExportDecisions((current) => ({ ...current, [skillId]: decision }))} /> : null}
        {exportPlan ? <Button disabled={busy || !hasExportDecisions} onClick={() => void commitExport()}>{t("dataProtection.export.commit")}</Button> : null}
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
          deployments.length === 0
            ? <p>{t("backup.uninstall.noDeployments")}</p>
            : deployments.map((deployment) => (
              <label key={deployment.id}>
                <input
                  aria-label={t("backup.uninstall.selectDeployment", { id: deployment.id })}
                  checked={selectedDeploymentIds.includes(deployment.id)}
                  onChange={() => toggleDeploymentSelection(deployment.id)}
                  type="checkbox"
                />
                {t("backup.uninstall.deploymentLabel", deployment)}
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
  return <div><p>{t("dataProtection.export.summary", { count: plan.skills.length })}</p>{plan.sensitive_items.map((item) => <label key={item.skill_id}>{t("dataProtection.export.decision", { skillId: item.skill_id })}<select aria-label={t("dataProtection.export.decision", { skillId: item.skill_id })} value={decisions[item.skill_id] ?? ""} onChange={(event) => onDecision(item.skill_id, event.target.value as SensitiveDecision)}><option value="">{t("dataProtection.export.choose")}</option><option value="resolve_first">{t("dataProtection.export.resolve")}</option><option value="exclude_skill">{t("dataProtection.export.exclude")}</option><option value="include_and_mark">{t("dataProtection.export.include")}</option></select></label>)}</div>;
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
