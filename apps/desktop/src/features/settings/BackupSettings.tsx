import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "../../ui/Button";
import type { BackupPlan, SensitiveContentDecision } from "../../api/bindings";
import type { BackupFacade } from "../backup/api";
import type { SettingsSnapshot } from "./api";

export function BackupSettings({ settings, facade }: { settings: SettingsSnapshot; facade?: BackupFacade }) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<BackupPlan>();
  const [result, setResult] = useState<string>();
  const [decisions, setDecisions] = useState<Record<string, SensitiveContentDecision>>({});
  const [error, setError] = useState<string>();
  const preflight = async () => { if (!facade) return; try { setPlan(await facade.prepareBackup("full")); setError(undefined); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const create = async () => { if (!facade || !plan || plan.sensitive_items.some((item) => !decisions[item.skill_id])) return; try { const created = await facade.createBackup("full", plan.sensitive_items.map((item) => ({ skill_id: item.skill_id, decision: decisions[item.skill_id] }))); setResult(created.path); setError(undefined); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  return <section className="sh-settings-card"><h2>{t("settings.backup.heading")}</h2><dl className="sh-facts"><dt>{t("settings.backup.location")}</dt><dd>{settings.backup.location || t("settings.backup.notConfigured")}</dd><dt>{t("settings.backup.retention")}</dt><dd>{settings.backup.retentionDays} {t("settings.backup.days")}</dd></dl>{facade ? <div className="sh-workflow-actions"><Button onClick={() => void preflight()} variant="secondary">{t("settings.backup.prepare")}</Button>{plan ? <Button disabled={plan.sensitive_items.some((item) => !decisions[item.skill_id])} onClick={() => void create()}>{t("settings.backup.create")}</Button> : null}<Link className="sh-button sh-button--ghost sh-button--md" to="/settings/data-protection">{t("settings.backup.manage")}</Link></div> : null}{plan?.sensitive_items.map((item) => <label key={item.skill_id}><span>{t("settings.backup.sensitive", { skill: item.skill_id })}</span><select aria-label={item.skill_id} value={decisions[item.skill_id] ?? ""} onChange={(event) => setDecisions((current) => ({ ...current, [item.skill_id]: event.target.value as SensitiveContentDecision }))}><option value="">{t("settings.backup.choose")}</option><option value="resolve_first">{t("settings.backup.decisions.resolve")}</option><option value="exclude_skill">{t("settings.backup.decisions.exclude")}</option><option value="include_and_mark">{t("settings.backup.decisions.include")}</option></select></label>)}{result ? <p role="status">{t("settings.backup.created", { path: result })}</p> : null}{error ? <p role="alert">{error}</p> : null}</section>;
}
