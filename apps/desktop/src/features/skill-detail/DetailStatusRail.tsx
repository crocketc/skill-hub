import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import type { SkillDetailSummary } from "./api";
import type { SkillDetailFacade } from "./api";
import { TrialActions } from "./TrialActions";
import { VersionUpdateNotice } from "./VersionUpdateNotice";

interface DetailStatusRailProps {
  facade: SkillDetailFacade;
  skillId: string;
  summary: SkillDetailSummary;
}

export function DetailStatusRail({ facade, skillId, summary }: DetailStatusRailProps) {
  const { t } = useTranslation();
  const deployments = summary.agentDeploymentCount + summary.projectDeploymentCount;
  return (
    <div
      aria-label={t("skillDetail.statusRail.label")}
      className="sh-skill-detail__status-summary"
      role="group"
    >
      <StatusBadge tone={summary.basicCheck === "passed" ? "success" : "warning"}>
        {summary.basicCheck === "passed"
          ? t("skillDetail.statusRail.basicPassed")
          : t("skillDetail.statusRail.basicOther", { state: summary.basicCheck })}
      </StatusBadge>
      <dl>
        <div>
          <dt>{t("skillDetail.statusRail.versionLabel")}</dt>
          <dd>{summary.currentVersion}</dd>
          <VersionUpdateNotice compact summary={summary} />
        </div>
        <div><dt>{t("skillDetail.statusRail.deploymentLabel")}</dt><dd>{t("skillDetail.statusRail.deployments", { count: deployments })}</dd></div>
      </dl>
      <TrialActions facade={facade} skillId={skillId} summary={summary} />
    </div>
  );
}
