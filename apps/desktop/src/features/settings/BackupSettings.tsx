import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "../../ui/Button";
import { describeNativeError } from "../../api/nativeErrors";
import type { BackupPlan, SensitiveContentDecision } from "../../api/bindings";
import type { BackupFacade } from "../backup/api";
import { displayPath } from "../../platform/displayPath";
import type { SettingsSnapshot } from "./api";

// 裁决（与数据保护页导出下拉同口径）：备份存储层对 resolve_first 诚实拒绝
// （BackupSensitiveDecisionRequired），下拉只提供真实可执行的两个决定；
// 「先去解决敏感内容」如需入口属后续批次。
type ExecutableSensitiveDecision = Exclude<SensitiveContentDecision, "resolve_first">;

export function BackupSettings({ settings, facade, resolveSkillName }: {
  settings: SettingsSnapshot;
  facade?: BackupFacade;
  resolveSkillName?: (skillId: string) => Promise<string | null>;
}) {
  const { t } = useTranslation();
  // 结构化 AppError 走错误码文案，绝不 `String(对象)`（DEV-18）。
  const describeError = (reason: unknown) => describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "tasks.notices.failureUnknown");
  const [plan, setPlan] = useState<BackupPlan>();
  const [skillNames, setSkillNames] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string>();
  const [decisions, setDecisions] = useState<Record<string, ExecutableSensitiveDecision>>({});
  const [error, setError] = useState<string>();
  const preflight = async () => {
    if (!facade) return;
    try {
      const prepared = await facade.prepareBackup("full");
      setPlan(prepared);
      setError(undefined);
      setSkillNames(Object.fromEntries(prepared.sensitive_items.map((item) => [item.skill_id, t("settings.backup.unnamedSkill")])));
      if (resolveSkillName) {
        const names = await Promise.all(prepared.sensitive_items.map(async (item) => {
          try {
            const name = await resolveSkillName(item.skill_id);
            return [item.skill_id, name?.trim() || t("settings.backup.unnamedSkill")] as const;
          } catch {
            return [item.skill_id, t("settings.backup.unnamedSkill")] as const;
          }
        }));
        setSkillNames(Object.fromEntries(names));
      }
    } catch (reason) {
      setError(describeError(reason));
    }
  };
  const create = async () => { if (!facade || !plan || plan.sensitive_items.some((item) => !decisions[item.skill_id])) return; try { const created = await facade.createBackup("full", plan.sensitive_items.map((item) => ({ skill_id: item.skill_id, decision: decisions[item.skill_id] }))); setResult(created.path); setError(undefined); } catch (reason) { setError(describeError(reason)); } };
  return (
    <section aria-labelledby="settings-backup-heading" className="sh-settings-card">
      <h2 id="settings-backup-heading" tabIndex={-1}>{t("settings.backup.heading")}</h2>
      <dl className="sh-facts">
        <dt>{t("settings.backup.location")}</dt>
        <dd>{settings.backup.location ? displayPath(settings.backup.location) : t("settings.backup.notConfigured")}</dd>
        <dt>{t("settings.backup.retention")}</dt>
        <dd>{settings.backup.retentionDays} {t("settings.backup.days")}</dd>
      </dl>
      {facade ? (
        <div className="sh-workflow-actions">
          <Button onClick={() => void preflight()} variant="secondary">{t("settings.backup.prepare")}</Button>
          {plan ? (
            <Button disabled={plan.sensitive_items.some((item) => !decisions[item.skill_id])} onClick={() => void create()}>
              {t("settings.backup.create")}
            </Button>
          ) : null}
          <Link className="sh-button sh-button--ghost sh-button--md" to="/settings/data-protection">{t("settings.backup.manage")}</Link>
        </div>
      ) : null}
      {plan?.sensitive_items.map((item) => {
        const skillName = skillNames[item.skill_id] ?? t("settings.backup.unnamedSkill");
        return (
          <label className="sh-settings-backup__decision" key={item.skill_id}>
            <span>{t("settings.backup.sensitive", { skill: skillName })}</span>
            <select
              aria-label={t("settings.backup.decisionLabel", { skill: skillName })}
              onChange={(event) => setDecisions((current) => ({ ...current, [item.skill_id]: event.target.value as ExecutableSensitiveDecision }))}
              value={decisions[item.skill_id] ?? ""}
            >
              <option value="">{t("settings.backup.choose")}</option>
              <option value="exclude_skill">{t("settings.backup.decisions.exclude")}</option>
              <option value="include_and_mark">{t("settings.backup.decisions.include")}</option>
            </select>
          </label>
        );
      })}
      {result ? <p role="status">{t("settings.backup.created", { path: displayPath(result) })}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
