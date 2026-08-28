import { useTranslation } from "react-i18next";

export interface UsageEvidencePanelProps {
  evidence?: string[];
}

export function UsageEvidencePanel({ evidence = [] }: UsageEvidencePanelProps) {
  const { t } = useTranslation();
  return (
    <section className="sh-agent-evidence" aria-labelledby="agent-evidence-title">
      <div className="sh-agent-section-heading">
        <div>
          <p className="sh-agent-eyebrow">{t("agents.evidence.eyebrow")}</p>
          <h2 id="agent-evidence-title">{t("agents.evidence.title")}</h2>
        </div>
        <span className="sh-agent-experimental">{t("agents.experimental")}</span>
      </div>
      {evidence.length ? <ul>{evidence.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{t("agents.evidence.empty")}</p>}
    </section>
  );
}
