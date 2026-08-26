import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import type { SkillDetailSummary } from "./api";

interface DetailStatusRailProps {
  summary: SkillDetailSummary;
}

export function DetailStatusRail({ summary }: DetailStatusRailProps) {
  const { t } = useTranslation();
  const deployments = summary.agentDeploymentCount + summary.projectDeploymentCount;
  return (
    <aside aria-label={t("skillDetail.statusRail.label")} className="sh-skill-detail__status-rail">
      <StatusBadge tone={summary.basicCheck === "passed" ? "success" : "warning"}>
        {summary.basicCheck === "passed"
          ? t("skillDetail.statusRail.basicPassed")
          : t("skillDetail.statusRail.basicOther", { state: summary.basicCheck })}
      </StatusBadge>
      <dl>
        <div><dt>{t("skillDetail.statusRail.versionLabel")}</dt><dd>{summary.currentVersion}</dd></div>
        <div><dt>{t("skillDetail.statusRail.deploymentLabel")}</dt><dd>{t("skillDetail.statusRail.deployments", { count: deployments })}</dd></div>
      </dl>
    </aside>
  );
}
