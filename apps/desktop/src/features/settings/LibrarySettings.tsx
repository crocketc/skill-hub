import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  HealthFinding,
  HealthReport,
  IgnoreRule,
  OperationSummary,
  RepairPlan,
} from "../../api/bindings";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import {
  type IgnoreRuleSubject,
  type LibraryHealthOperations,
  type SettingsSnapshot,
} from "./api";

export interface LibrarySettingsProps {
  settings: SettingsSnapshot;
  /** When provided, the card renders the library health check entry. */
  health?: LibraryHealthOperations;
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

export function LibrarySettings({ settings, health }: LibrarySettingsProps) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [rules, setRules] = useState<IgnoreRule[]>([]);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [rulesError, setRulesError] = useState(false);
  const [subjectKind, setSubjectKind] = useState<SubjectKind>("exact_path");
  const [subjectValue, setSubjectValue] = useState("");
  const [reason, setReason] = useState("");
  const [addingRule, setAddingRule] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);
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
      setRuleError(t("settings.ignore.valueRequired"));
      return;
    }
    if (!reasonText) {
      setRuleError(t("settings.ignore.reasonRequired"));
      return;
    }
    setAddingRule(true);
    setRuleError(null);
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
      setRuleError(t("settings.ignore.addFailed"));
    } finally {
      setAddingRule(false);
    }
  };

  const removeRule = async () => {
    if (!health || !pendingRuleId) return;
    setRuleError(null);
    try {
      await health.removeIgnoreRule(pendingRuleId);
      setRules((current) => current.filter((rule) => rule.id !== pendingRuleId));
    } catch {
      setRuleError(t("settings.ignore.removeFailed"));
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
        <dd>{settings.library.path}</dd>
      </dl>
      {settings.library.migrationAvailable ? (
        <p className="sh-settings-note">{t("settings.library.migrationAvailable")}</p>
      ) : null}
      {health ? (
        <>
          <div className="sh-settings-card__health">
            <Button disabled={checking} onClick={() => void runCheck()} variant="secondary">
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
                        <span>{finding.code}</span>
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
                    <span>{plan.finding.code}</span>
                  </li>
                  <li>
                    <span>{t("settings.repair.severityLabel")}</span>
                    <span>{t(severityKey(plan.finding.severity))}</span>
                  </li>
                  <li>
                    <span>{t("settings.repair.actionLabel")}</span>
                    <span>{plan.finding.repair}</span>
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
            {ruleError ? <p role="alert">{ruleError}</p> : null}
            {rulesLoaded && rules.length === 0 ? <p>{t("settings.ignore.empty")}</p> : null}
            <ul>
              {rules.map((rule) => (
                <li key={rule.id}>
                  <span>{rule.subject.value}</span>
                  <span>{String(t(subjectKey(rule.subject.type) as never))}</span>
                  <span>{rule.reason}</span>
                  <span>
                    {t("settings.ignore.created")}
                    {": "}
                    {rule.created_at}
                  </span>
                  <ConfirmDialog
                    cancelLabel={t("actions.cancel")}
                    confirmLabel={t("settings.ignore.confirmRemove")}
                    description={t("settings.ignore.confirmRemoveDescription", {
                      subject: rule.subject.value,
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
                </li>
              ))}
            </ul>
            <div>
              <label>
                {t("settings.ignore.subjectLabel")}
                <select
                  aria-label={t("settings.ignore.subjectLabel")}
                  onChange={(event) => setSubjectKind(event.target.value as SubjectKind)}
                  value={subjectKind}
                >
                  {SUBJECT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {String(t(subjectKey(kind) as never))}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("settings.ignore.valueLabel")}
                <input
                  aria-label={t("settings.ignore.valueLabel")}
                  onChange={(event) => setSubjectValue(event.target.value)}
                  placeholder={t("settings.ignore.valuePlaceholder")}
                  value={subjectValue}
                />
              </label>
              <label>
                {t("settings.ignore.reasonLabel")}
                <input
                  aria-label={t("settings.ignore.reasonLabel")}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t("settings.ignore.reasonPlaceholder")}
                  value={reason}
                />
              </label>
              <Button disabled={addingRule} onClick={() => void addRule()} variant="secondary">
                {addingRule ? t("settings.ignore.adding") : t("settings.ignore.add")}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
