import { useTranslation } from "react-i18next";
import type { RelationGovernanceRow } from "../../../api/bindings";
import { Button } from "../../../ui/Button";
import { AgentIdentity } from "../../skills/AgentDeploymentIcons";
import { displayPath } from "../../../platform/displayPath";
import { relationAgentIdOf, relationPathOf } from "./api";

export interface SourceCleanupResultProps {
  row: RelationGovernanceRow;
  busy: boolean;
  /** 打开目标已预选的批量部署页；只导航，绝不自动提交部署。 */
  onDeployNow: () => void;
  /** 稍后部署：只关闭结果，回到治理清单。 */
  onLater: () => void;
}

/**
 * 来源副本清理成功结果（任务 11.9）：本地来源副本（AgentLocal）清理完成后，
 * 主入口是把该 Skill 重新部署回此 Agent（目标已预选，预检与提交仍在部署页
 * 显式完成）；“稍后部署”只是关闭结果，不做任何写操作。
 */
export function SourceCleanupResult({
  busy,
  onDeployNow,
  onLater,
  row,
}: SourceCleanupResultProps) {
  const { t } = useTranslation();
  const agentId = relationAgentIdOf(row.relation);

  return (
    <div
      aria-label={t("relationships.governance.clean.resultTitle")}
      data-testid="governance-clean-result"
      role="status"
    >
      <h3>{t("relationships.governance.clean.resultTitle")}</h3>
      <p>
        {agentId ? <AgentIdentity agentId={agentId} /> : null}
        <span>{t("agents.pathLabel")} <code>{displayPath(relationPathOf(row.relation))}</code></span>
      </p>
      <div className="sh-governance__dialog-actions">
        <Button
          data-testid="governance-clean-deploy"
          disabled={busy}
          onClick={onDeployNow}
          variant="primary"
        >
          {t("relationships.governance.clean.deployNow")}
        </Button>
        <Button
          data-testid="governance-clean-later"
          disabled={busy}
          onClick={onLater}
          variant="secondary"
        >
          {t("relationships.governance.clean.deployLater")}
        </Button>
      </div>
    </div>
  );
}
