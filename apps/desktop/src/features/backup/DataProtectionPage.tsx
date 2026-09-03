import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExportDecision,
  ExportInput,
  ExportPlan,
  RestoreConflict,
  RestoreDecision,
  RestorePlan,
  RestoreResult,
} from "../../api/bindings";
import { Button } from "../../ui/Button";
import type { BackupFacade } from "./api";

type Decision = "overwrite" | "keep_both" | "skip";
type SensitiveDecision = "resolve_first" | "exclude_skill" | "include_and_mark";

export function DataProtectionPage({ facade }: { facade: BackupFacade }) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [verifyMessage, setVerifyMessage] = useState<string>();
  const [restorePlan, setRestorePlan] = useState<RestorePlan>();
  const [restoreDecisions, setRestoreDecisions] = useState<Record<string, Decision>>({});
  const [restoreResult, setRestoreResult] = useState<RestoreResult>();
  const [exportSkillIds, setExportSkillIds] = useState("");
  const [exportPlan, setExportPlan] = useState<ExportPlan>();
  const [exportDecisions, setExportDecisions] = useState<Record<string, SensitiveDecision>>({});
  const [exportPath, setExportPath] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

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
  const reviewExport = () => run(async () => {
    if (!exportSkillIds.trim()) return;
    setExportPath(undefined);
    setExportDecisions({});
    const input: ExportInput = { selection: { skills: exportSkillIds.split(",").map((id) => id.trim()).filter(Boolean) }, versions: "current", skills: [] };
    setExportPlan(await facade.prepareExport(input));
  });
  const commitExport = () => run(async () => {
    if (!exportPlan) return;
    const input: ExportInput = { selection: { skills: exportSkillIds.split(",").map((id) => id.trim()).filter(Boolean) }, versions: "current", skills: [] };
    const decisions: ExportDecision[] = exportPlan.sensitive_items.map((item) => ({ skill_id: item.skill_id, decision: exportDecisions[item.skill_id] })) as ExportDecision[];
    const result = await facade.createExport(input, decisions);
    setExportPath(result.path);
  });
  const hasRestoreDecisions = Boolean(restorePlan) && restorePlan!.conflicts.every((conflict) => !conflict.skill_id || restoreDecisions[conflict.skill_id]);
  const hasInvalidConflict = restorePlan?.conflicts.some((conflict) => conflict.kind === "invalid_portable_data") ?? false;
  const hasExportDecisions = Boolean(exportPlan) && exportPlan!.sensitive_items.every((item) => exportDecisions[item.skill_id]);

  return (
    <main className="sh-page sh-workflow-page">
      <header className="sh-page__header"><div><p className="sh-eyebrow">{t("dataProtection.eyebrow")}</p><h1>{t("dataProtection.heading")}</h1><p>{t("dataProtection.description")}</p></div></header>
      {error ? <p className="sh-settings-error" role="alert">{error}</p> : null}
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
        <Button disabled={!exportSkillIds.trim() || busy} onClick={() => void reviewExport()}>{t("dataProtection.export.review")}</Button>
        {exportPlan ? <ExportReview plan={exportPlan} decisions={exportDecisions} onDecision={(skillId, decision) => setExportDecisions((current) => ({ ...current, [skillId]: decision }))} /> : null}
        {exportPlan ? <Button disabled={busy || !hasExportDecisions} onClick={() => void commitExport()}>{t("dataProtection.export.commit")}</Button> : null}
        {exportPath ? <p role="status">{t("dataProtection.export.result", { path: exportPath })}</p> : null}
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
