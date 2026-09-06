import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { FindingActions } from "./FindingActions";
import { type SecurityCheck, type SecurityFacade, type SecurityFinding, type SecurityPreferences, unavailableSecurityFacade } from "./api";

export interface SecurityResultsProps {
  facade?: SecurityFacade;
  skillId: string;
  versionId: string;
}

export function SecurityResults({ facade = unavailableSecurityFacade, skillId, versionId }: SecurityResultsProps) {
  const { t } = useTranslation();
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
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [facade, skillId, versionId, reloadKey]);

  const checkByKind = (kind: SecurityCheck["kind"]) => checks.find((check) => check.kind === kind);
  const handleDisposition = async (finding: SecurityFinding, disposition: SecurityFinding["disposition"], options: { highRiskConfirmed: boolean }) => {
    await facade.setFindingDisposition(finding, disposition, skillId, versionId, options.highRiskConfirmed);
    setFindings((current) => current.map((item) => item.id === finding.id ? { ...item, disposition } : item));
  };
  const llmConfigured = preferences ? preferences.llmProvider.trim().length > 0 : true;
  const [runningOperation, setRunningOperation] = useState<string | undefined>(undefined);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelledRef = useRef(false);
  const handleRun = async () => {
    if (!facade.runLlmCheck || !llmConfigured) return;
    setRunning(true);
    setRunError(undefined);
    cancelledRef.current = false;
    try {
      await facade.runLlmCheck(skillId, versionId);
      setReloadKey((key) => key + 1);
    } catch (reason: unknown) {
      // A run the user cancelled must not surface as a failure.
      if (!cancelledRef.current) {
        setRunError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setRunning(false);
      setRunningOperation(undefined);
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
          if (match) return;
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
    try {
      await facade.cancelLlmCheck(runningOperation);
      cancelledRef.current = true;
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

function CheckSummary({ check, experimental = false }: { check?: SecurityCheck; experimental?: boolean }) {
  const { t } = useTranslation();
  if (!check) return <p>{t("security.notChecked")}</p>;
  return <div className="sh-check-summary"><span className={`sh-status sh-status--${check.state}`}>{t(`security.states.${check.state}`)}</span><strong>{t("security.findingCount", { count: check.findingCount })}</strong>{experimental ? <small>{t("security.experimental")}</small> : null}</div>;
}
