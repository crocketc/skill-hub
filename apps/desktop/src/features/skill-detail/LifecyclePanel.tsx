import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import type { SkillDetailSummary } from "./api";

export function LifecyclePanel({ summary }: { summary: SkillDetailSummary }) {
  const { t } = useTranslation();
  return (
    <div className="sh-lifecycle-panel">
      <StatusBadge tone={summary.lifecycle === "archived" ? "neutral" : summary.lifecycle === "trial" ? "info" : "success"}>
        {t(`skillDetail.lifecycle.${summary.lifecycle}`)}
      </StatusBadge>
      <p>{t(`skillDetail.lifecycle.description.${summary.lifecycle}`)}</p>
      {summary.trialDue ? <p>{t("skillDetail.lifecycle.reviewDue", { date: summary.trialDue })}</p> : null}
    </div>
  );
}
