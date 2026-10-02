import { useEffect, useState } from "react";
import { displayPath } from "../../platform/displayPath";
import { useTranslation } from "react-i18next";
import type {
  HealthFinding,
  HealthReport,
  IgnoreRule,
  OperationSummary,
  RepairAction,
  RepairPlan,
} from "../../api/bindings";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DataState } from "../../ui/DataState";
import { Field } from "../../ui/Field";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { StatusBadge } from "../../ui/StatusBadge";
import {
  type IgnoreRuleSubject,
  type LibraryHealthOperations,
  type SettingsSnapshot,
} from "./api";

export interface LibrarySettingsProps {
  settings: SettingsSnapshot;
  /** When provided, the card renders the library health check entry. */
  health?: LibraryHealthOperations;
  resolveSkillName?: (skillId: string) => Promise<string | null>;
}

type SeverityKey =
  | "settings.library.severityCritical"
  | "settings.library.severityError"
  | "settings.library.severityWarning"
  | "settings.library.severityInfo";

type SubjectKind = IgnoreRuleSubject["type"];

/** AR-016：创建入口只保留用户可理解的“路径忽略”；
 * 精确 Skill / 精确待处理不再作为自由输入暴露。 */
const SUBJECT_KINDS: SubjectKind[] = ["exact_path"];

function severityKey(severity: HealthFinding["severity"]): SeverityKey {
  switch (severity) {
    case "critical":
      return "settings.library.severityCritical";
    case "error":
      return "settings.library.severityError";
    case "warning":
      return "settings.library.severityWarning";
    default:
      return "settings.library.severityInfo";
  }
}

function subjectKey(kind: SubjectKind): string {
  switch (kind) {
    case "exact_skill":
      return "settings.ignore.subjectSkill";
    case "exact_pending":
      return "settings.ignore.subjectPending";
    default:
      return "settings.ignore.subjectPath";
  }
}

function findingLabel(finding: HealthFinding, t: (key: string) => string): string {
  return finding.code === "health.unfinished_operation"
    ? t("settings.library.findingUnfinishedOperation")
    : t("settings.library.findingGeneric");
}

function repairLabel(action: RepairAction | null, t: (key: string) => string): string {
  switch (action) {
    case "remove_orphan_metadata": return t("settings.library.repairRemoveOrphanMetadata");
    case "restore_missing_target": return t("settings.library.repairRestoreMissingTarget");
    case "clean_stale_temporary_file": return t("settings.library.repairCleanTemporaryFile");
    case "rebuild_missing_manifest": return t("settings.library.repairRebuildManifest");
    case "mark_operation_needs_recovery": return t("settings.library.repairMarkOperationNeedsRecovery");
    default: return t("settings.library.repairGeneric");
  }
}

function subjectValueLabel(rule: IgnoreRule, skillLabels: Record<string, string>, t: (key: string) => string): string {
  switch (rule.subject.type) {
    case "exact_path": return displayPath(rule.subject.value);
    case "exact_skill": return skillLabels[rule.subject.value] ?? t("settings.library.unnamedSkill");
    default: return t("settings.ignore.subjectPendingItem");
  }
}

export function LibrarySettings({ settings, health, resolveSkillName }: LibrarySettingsProps) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [rules, setRules] = useState<IgnoreRule[]>([]);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [rulesError, setRulesError] = useState(false);
  const [skillLabels, setSkillLabels] = useState<Record<string, string>>({});
  const [subjectKind, setSubjectKind] = useState<SubjectKind>("exact_path");
  const [subjectValue, setSubjectValue] = useState("");
  const [reason, setReason] = useState("");
  const [addingRule, setAddingRule] = useState(false);
  const [valueError, setValueError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [pendingRuleId, setPendingRuleId] = useState<string | null>(null);

  const [plan, setPlan] = useState<RepairPlan | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitSummary, setCommitSummary] = useState<OperationSummary | null>(null);

  useEffect(() => {
    if (!health) return;
    let cancelled = false;
    health
      .listIgnoreRules()
      .then((loaded) => {
        if (cancelled) return;
        setRules(loaded);
        setRulesLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setRulesError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [health]);

  useEffect(() => {
    if (!resolveSkillName) return;
    let cancelled = false;
    const skillIds = [...new Set(rules.flatMap((rule) => rule.subject.type === "exact_skill" ? [rule.subject.value] : []))];
    if (skillIds.length === 0) return;
    void Promise.all(skillIds.map(async (skillId) => {
      try {
        return [skillId, (await resolveSkillName(skillId))?.trim() || String(t("settings.library.unnamedSkill"))] as const;
      } catch {
        return [skillId, String(t("settings.library.unnamedSkill"))] as const;
      }
    })).then((labels) => {
      if (!cancelled) setSkillLabels(Object.fromEntries(labels));
    });
    return () => { cancelled = true; };
  }, [resolveSkillName, rules, t]);

  const runCheck = async () => {
    if (!health) return;
    setChecking(true);
    setError(null);
    setPlan(null);
    setPlanError(null);
    setCommitError(null);
    setCommitSummary(null);
    try {
      setReport(await health.runHealthCheck());
    } catch {
      setError(t("settings.library.checkFailed"));
    } finally {
      setChecking(false);
    }
  };

  const addRule = async () => {
    if (!health) return;
    const value = subjectValue.trim();
    const reasonText = reason.trim();
    if (!value) {
      setValueError(t("settings.ignore.valueRequired"));
      return;
    }
    if (!reasonText) {
      setReasonError(t("settings.ignore.reasonRequired"));
      return;
    }
    setAddingRule(true);
    setAddError(null);
    try {
      const created = await health.createIgnoreRule({
        subject: { type: subjectKind, value },
        reason: reasonText,
        deferUntil: null,
      });
      setRules((current) => [...current, created]);
      setSubjectValue("");
      setReason("");
    } catch {
      setAddError(t("settings.ignore.addFailed"));
    } finally {
      setAddingRule(false);
    }
  };

  const removeRule = async () => {
    if (!health || !pendingRuleId) return;
    setRemoveError(null);
    try {
      await health.removeIgnoreRule(pendingRuleId);
      setRules((current) => current.filter((rule) => rule.id !== pendingRuleId));
    } catch {
      setRemoveError(t("settings.ignore.removeFailed"));
    } finally {
      setPendingRuleId(null);
    }
  };

  const previewRepair = async (reportId: string, findingIndex: number) => {
    if (!health) return;
    setPreparing(true);
    setPlan(null);
    setPlanError(null);
    setCommitError(null);
    setCommitSummary(null);
    try {
      setPlan(await health.prepareRepair(reportId, findingIndex));
    } catch {
      setPlanError(t("settings.repair.previewFailed"));
    } finally {
      setPreparing(false);
    }
  };

  const cancelPreview = () => {
    setPlan(null);
    setPlanError(null);
    setCommitError(null);
    setCommitSummary(null);
  };

  const applyRepair = async () => {
    if (!health || !plan) return;
    setCommitting(true);
    setCommitError(null);
    try {
      setCommitSummary(await health.commitRepair(plan.id));
      setPlan(null);
    } catch {
      setCommitError(t("settings.repair.commitFailed"));
    } finally {
      setCommitting(false);
    }
  };

  return (
    <section className="sh-settings-card">
      <h2>{t("settings.library.heading")}</h2>
      <dl className="sh-facts">
        <dt>{t("settings.library.path")}</dt>
        <dd>{displayPath(settings.library.path)}</dd>
      </dl>
      {settings.library.migrationAvailable ? (
        <p className="sh-settings-note">{t("settings.library.migrationAvailable")}</p>
      ) : null}
      {health ? (
        <>
          <div className="sh-settings-card__health">
            <Button disabled={checking} id="settings-health-check" onClick={() => void runCheck()} variant="secondary">
              {checking ? t("settings.library.checking") : t("settings.library.runHealthCheck")}
            </Button>
            <p className="sh-settings-note">{t("settings.library.healthScope")}</p>
            {error ? <p role="alert">{error}</p> : null}
            {planError ? <p role="alert">{planError}</p> : null}
            {report && !error ? (
              report.findings.length === 0 ? (
                <p>{t("settings.library.allClear")}</p>
              ) : (
                <>
                  <p>{t("settings.library.findingsSummary", { count: report.findings.length })}</p>
                  <ul>
                    {report.findings.map((finding, index) => (
                      <li key={`${report.id}:${index}`}>
                        <span>{findingLabel(finding, (key) => String(t(key as never)))}</span>
                        <span>{t(severityKey(finding.severity))}</span>
                        {finding.repair ? (
                          <Button
                            disabled={preparing}
                            onClick={() => void previewRepair(report.id, index)}
                            variant="ghost"
                          >
                            {preparing ? t("settings.repair.preparing") : t("settings.repair.preview")}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              )
            ) : null}
            {plan ? (
              <div aria-label={t("settings.repair.panelLabel")} role="region">
                <p>{t("settings.repair.planHeading")}</p>
                <ul>
                  <li>
                    <span>{t("settings.repair.findingLabel")}</span>
                    <span>{findingLabel(plan.finding, (key) => String(t(key as never)))}</span>
                  </li>
                  <li>
                    <span>{t("settings.repair.severityLabel")}</span>
                    <span>{t(severityKey(plan.finding.severity))}</span>
                  </li>
                  <li>
                    <span>{t("settings.repair.actionLabel")}</span>
                    <span>{repairLabel(plan.finding.repair, (key) => String(t(key as never)))}</span>
                  </li>
                </ul>
                {commitError ? <p role="alert">{commitError}</p> : null}
                <Button disabled={committing} onClick={() => void applyRepair()} variant="primary">
                  {committing ? t("settings.repair.executing") : t("settings.repair.execute")}
                </Button>
                <Button disabled={committing} onClick={cancelPreview} variant="secondary">
                  {t("actions.cancel")}
                </Button>
              </div>
            ) : null}
            {commitSummary ? <p role="status">{t("settings.repair.committed")}</p> : null}
          </div>
          <div aria-label={t("settings.ignore.heading")} className="sh-settings-card__ignore">
            <h3>{t("settings.ignore.heading")}</h3>
            <p>{t("settings.ignore.description")}</p>
            {rulesError ? <p role="alert">{t("settings.ignore.loadFailed")}</p> : null}
            {removeError ? <p role="alert">{removeError}</p> : null}
            {rulesLoaded && rules.length === 0 ? (
              <DataState message={t("settings.ignore.empty")} state="empty" />
            ) : null}
            {rules.length > 0 ? (
              <ul aria-label={t("settings.ignore.listLabel")} className="sh-settings-ignore__list">
                {rules.map((rule) => (
                  <li key={rule.id} className="sh-settings-ignore__row">
                    <div className="sh-settings-ignore__head">
                      <StatusBadge>{String(t(subjectKey(rule.subject.type) as never))}</StatusBadge>
                      <span className="sh-settings-ignore__value" title={rule.subject.type === "exact_path" ? displayPath(rule.subject.value) : undefined}>
                        {subjectValueLabel(rule, skillLabels, (key) => String(t(key as never)))}
                      </span>
                    </div>
                    {rule.reason ? (
                      <p className="sh-settings-ignore__reason">{rule.reason}</p>
                    ) : null}
                    <span className="sh-settings-ignore__created">
                      {t("settings.ignore.created")}
                      {": "}
                      {rule.created_at}
                    </span>
                    <div className="sh-settings-ignore__actions">
                      <ConfirmDialog
                        cancelLabel={t("actions.cancel")}
                        confirmLabel={t("settings.ignore.confirmRemove")}
                        description={t("settings.ignore.confirmRemoveDescription", {
                          subject: subjectValueLabel(rule, skillLabels, (key) => String(t(key as never))),
                        })}
                        onConfirm={() => void removeRule()}
                        title={t("settings.ignore.confirmRemoveTitle")}
                        trigger={
                          <Button
                            onClick={() => setPendingRuleId(rule.id)}
                            variant="ghost"
                          >
                            {t("settings.ignore.remove")}
                          </Button>
                        }
                        variant="danger"
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            <form
              className="sh-settings-ignore__form"
              onSubmit={(event) => {
                event.preventDefault();
                void addRule();
              }}
            >
              <Field label={t("settings.ignore.subjectLabel")}>
                <Select
                  onChange={(event) => setSubjectKind(event.target.value as SubjectKind)}
                  value={subjectKind}
                >
                  {SUBJECT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {String(t(subjectKey(kind) as never))}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field error={valueError ?? undefined} id="settings-ignore-rule-value" label={t("settings.ignore.valueLabel")}>
                <Input
                  onChange={(event) => {
                    setSubjectValue(event.target.value);
                    setValueError(null);
                  }}
                  placeholder={t("settings.ignore.valuePlaceholder")}
                  value={subjectValue}
                />
              </Field>
              <Field error={reasonError ?? undefined} label={t("settings.ignore.reasonLabel")}>
                <Input
                  onChange={(event) => {
                    setReason(event.target.value);
                    setReasonError(null);
                  }}
                  placeholder={t("settings.ignore.reasonPlaceholder")}
                  value={reason}
                />
              </Field>
              {addError ? <p role="alert">{addError}</p> : null}
              <Button disabled={addingRule} type="submit" variant="secondary">
                {addingRule ? t("settings.ignore.adding") : t("settings.ignore.add")}
              </Button>
            </form>
          </div>
        </>
      ) : null}
    </section>
  );
}
