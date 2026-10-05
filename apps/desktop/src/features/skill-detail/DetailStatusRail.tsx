import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import { SecurityAlertBadge } from "../shared/SecurityAlertBadge";
import { CHECK_STATE_LABEL_KEYS, checkStateTone } from "../shared/checkState";
import type { SkillDetailSummary } from "./api";
import type { SkillDetailFacade } from "./api";
import { TrialActions } from "./TrialActions";
import { VersionUpdateNotice } from "./VersionUpdateNotice";

interface DetailStatusRailProps {
  facade: SkillDetailFacade;
  skillId: string;
  summary: SkillDetailSummary;
  /** 活跃部署关系数（与「关系」区块同一查询的长度）；缺省回退 summary 汇总。 */
  deployments?: number;
}

export function DetailStatusRail({ deployments: deploymentsOverride, facade, skillId, summary }: DetailStatusRailProps) {
  const { t } = useTranslation();
  const deployments = deploymentsOverride
    ?? (summary.agentDeploymentCount !== undefined && summary.projectDeploymentCount !== undefined
      ? summary.agentDeploymentCount + summary.projectDeploymentCount
      : undefined);
  // G-16：关系构成来自 get_skill 真实计数；两个计数独立缺省，各自有值才
  // 进入文案——0 如实显示 0，全部未知时诚实声明未知，不伪造空事实。
  const relationParts: string[] = [];
  if (summary.managedLinkCount !== undefined) {
    relationParts.push(t("skillDetail.statusRail.relationsManaged", { count: summary.managedLinkCount }));
  }
  if (summary.independentCopyCount !== undefined) {
    relationParts.push(t("skillDetail.statusRail.relationsIndependent", { count: summary.independentCopyCount }));
  }
  return (
    <div
      aria-label={t("skillDetail.statusRail.label")}
      className="sh-skill-detail__status-summary"
      role="group"
    >
      {/* 2026-10-05 枚举定稿：徽标 tone 与状态词与列表共用同一映射，
          5 态语义（通过/警告/失败/未运行/不可用）逐态可读，不裸露枚举值。 */}
      <StatusBadge tone={checkStateTone(summary.basicCheck)}>
        {summary.basicCheck === "passed"
          ? t("skillDetail.statusRail.basicPassed")
          : t("skillDetail.statusRail.basicOther", {
              state: t(CHECK_STATE_LABEL_KEYS[summary.basicCheck]),
            })}
      </StatusBadge>
      {/* W3-1：与列表 security_status 单元格共用同一预警徽标与事实来源。 */}
      {summary.securityAlert ? <SecurityAlertBadge level={summary.securityAlert} /> : null}
      <dl>
        <div>
          <dt>{t("skillDetail.statusRail.versionLabel")}</dt>
          <dd>{summary.currentVersion}</dd>
          <VersionUpdateNotice compact summary={summary} />
        </div>
        <div>
          <dt>{t("skillDetail.statusRail.deploymentLabel")}</dt>
          <dd>{deployments === undefined
            ? t("skillDetail.statusRail.deploymentsUnavailable")
            : t("skillDetail.statusRail.deployments", { count: deployments })}</dd>
        </div>
        <div>
          <dt>{t("skillDetail.statusRail.relationLabel")}</dt>
          <dd>{relationParts.length > 0
            ? relationParts.join(" · ")
            : t("skillDetail.statusRail.relationsUnavailable")}</dd>
        </div>
      </dl>
      <TrialActions facade={facade} skillId={skillId} summary={summary} />
    </div>
  );
}
