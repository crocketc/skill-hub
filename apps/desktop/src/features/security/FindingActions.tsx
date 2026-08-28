import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { SecurityFinding } from "./api";

export function FindingActions({ finding, onDisposition }: { finding: SecurityFinding; onDisposition: (finding: SecurityFinding["disposition"]) => void }) {
  const { t } = useTranslation();
  if (finding.disposition !== "actionable") return <span className="sh-status sh-status--muted">{t(`security.disposition.${finding.disposition}`)}</span>;
  return (
    <div className="sh-workflow-actions">
      <Button onClick={() => onDisposition("acknowledged")} size="sm" variant="secondary">{t("security.actions.acknowledge")}</Button>
      {finding.highRisk ? <Button onClick={() => onDisposition("dismissed")} size="sm" variant="danger">{t("security.actions.confirmDismiss")}</Button> : null}
    </div>
  );
}
