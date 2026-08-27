import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DataState } from "../../ui/DataState";
import { FindingActions } from "./FindingActions";
import { type SecurityCheck, type SecurityFacade, type SecurityFinding, unavailableSecurityFacade } from "./api";

export interface SecurityResultsProps {
  facade?: SecurityFacade;
  skillId: string;
  versionId: string;
}

export function SecurityResults({ facade = unavailableSecurityFacade, skillId, versionId }: SecurityResultsProps) {
  const { t } = useTranslation();
  const [checks, setChecks] = useState<SecurityCheck[]>([]);
  const [findings, setFindings] = useState<SecurityFinding[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void Promise.all([facade.getChecks(skillId, versionId), facade.listFindings(skillId, versionId)])
      .then(([nextChecks, nextFindings]) => { if (active) { setChecks(nextChecks); setFindings(nextFindings); } })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [facade, skillId, versionId]);

  const checkByKind = (kind: SecurityCheck["kind"]) => checks.find((check) => check.kind === kind);
  const handleDisposition = async (finding: SecurityFinding, disposition: SecurityFinding["disposition"]) => {
    await facade.setFindingDisposition(finding.id, disposition);
    setFindings((current) => current.map((item) => item.id === finding.id ? { ...item, disposition } : item));
  };

  if (error) return <DataState message={error} state="unavailable" />;
  if (!checks.length && !findings.length) return <DataState message={t("security.states.loading")} state="loading" />;
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
        </section>
      </div>
      <section aria-labelledby="security-findings-heading" className="sh-workflow-card">
        <div className="sh-section-heading"><h2 id="security-findings-heading">{t("security.findingsHeading")}</h2><span className="sh-count-badge">{findings.length}</span></div>
        {findings.length === 0 ? <p>{t("security.noFindings")}</p> : <ul className="sh-workflow-list">{findings.map((finding) => <li className="sh-workflow-list__item" key={finding.id}><div><strong>{finding.code}</strong><p>{finding.message}</p><small>{finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : t("security.locationUnknown")}</small></div><FindingActions finding={finding} onDisposition={(disposition) => void handleDisposition(finding, disposition)} /></li>)}</ul>}
      </section>
    </main>
  );
}

function CheckSummary({ check, experimental = false }: { check?: SecurityCheck; experimental?: boolean }) {
  const { t } = useTranslation();
  if (!check) return <p>{t("security.notChecked")}</p>;
  return <div className="sh-check-summary"><span className={`sh-status sh-status--${check.state}`}>{t(`security.states.${check.state}`)}</span><strong>{t("security.findingCount", { count: check.findingCount })}</strong>{experimental ? <small>{t("security.experimental")}</small> : null}</div>;
}
