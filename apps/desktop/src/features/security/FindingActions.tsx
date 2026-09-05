import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import type { SecurityFinding } from "./api";

export interface DispositionOptions {
  highRiskConfirmed: boolean;
}

export function FindingActions({ finding, onDisposition }: {
  finding: SecurityFinding;
  onDisposition: (disposition: SecurityFinding["disposition"], options: DispositionOptions) => void;
}) {
  const { t } = useTranslation();
  if (finding.disposition !== "actionable") return <span className="sh-status sh-status--muted">{t(`security.disposition.${finding.disposition}`)}</span>;
  if (!finding.highRisk) {
    return (
      <div className="sh-workflow-actions">
        <Button onClick={() => onDisposition("acknowledged", { highRiskConfirmed: false })} size="sm" variant="secondary">{t("security.actions.acknowledge")}</Button>
      </div>
    );
  }
  const description = t("security.highRiskDescription");
  return (
    <div className="sh-workflow-actions">
      <ConfirmDialog
        cancelLabel={t("actions.cancel")}
        confirmLabel={t("security.actions.confirmAcknowledge")}
        description={description}
        onConfirm={() => onDisposition("acknowledged", { highRiskConfirmed: true })}
        title={t("security.highRiskTitle")}
        trigger={<Button size="sm" variant="secondary">{t("security.actions.acknowledge")}</Button>}
      />
      <ConfirmDialog
        cancelLabel={t("actions.cancel")}
        confirmLabel={t("security.actions.confirmDismiss")}
        description={description}
        onConfirm={() => onDisposition("dismissed", { highRiskConfirmed: true })}
        title={t("security.highRiskTitle")}
        trigger={<Button size="sm" variant="danger">{t("security.actions.dismiss")}</Button>}
      />
    </div>
  );
}
