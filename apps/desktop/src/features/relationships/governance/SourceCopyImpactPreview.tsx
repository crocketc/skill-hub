import { useTranslation } from "react-i18next";
import type { RelationGovernanceRow, RemovalImpactFact } from "../../../api/bindings";
import { Button } from "../../../ui/Button";
import { relationshipLabelKey } from "../../relationshipGovernance/relationshipGovernance";
import { RelationshipRemovalImpactView } from "../../relationshipGovernance/RelationshipRemovalImpactView";
import { AgentIdentity } from "../../skills/AgentDeploymentIcons";
import { displayPath } from "../../../platform/displayPath";
import {
  relationAgentIdOf,
  relationPathOf,
  relationSkillIdOf,
  relationshipKeyOf,
} from "./api";

export interface SourceCopyImpactPreviewProps {
  row: RelationGovernanceRow;
  busy: boolean;
  /** 后端拒绝后的错误文本；非空时预览保持打开并原样展示。 */
  error: string | null;
  /** 只读加载该来源边的移除影响事实（备份位置、共享影响、回退）。 */
  loadImpact: () => Promise<RemovalImpactFact>;
  ownershipConfirmed: boolean;
  onOwnershipConfirmChange: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 来源副本清理预览（任务 11.8）：先如实列出将要发生什么——删除哪个
 * Agent/类型/路径上的副本、原入口停止使用、集中库不受影响、以后可重新
 * 部署、备份/回滚与阻断原因——所有权确认勾选是提交的硬门槛。
 */
export function SourceCopyImpactPreview({
  busy,
  error,
  loadImpact,
  onCancel,
  onConfirm,
  onOwnershipConfirmChange,
  ownershipConfirmed,
  row,
}: SourceCopyImpactPreviewProps) {
  const { t } = useTranslation();
  const title = t("relationships.governance.clean.previewTitle");
  const agentId = relationAgentIdOf(row.relation);
  const skillName = row.skill_display_name ?? relationSkillIdOf(row.relation)
    ?? t("relationshipGovernance.matrix.unknownSkill");

  return (
    <div aria-label={title} className="sh-governance__dialog" data-testid="governance-clean-preview" role="dialog">
      <h3>{title}</h3>
      <p>{t("relationships.governance.clean.explain", { skill: skillName })}</p>
      <dl className="sh-governance__facts">
        <div>
          <dt>{t("relationships.governance.preview.relationLabel")}</dt>
          <dd>{t(relationshipLabelKey(relationshipKeyOf(row.relation) as never) as never)}</dd>
        </div>
        <div>
          <dt>{t("relationships.governance.preview.targetLabel")}</dt>
          <dd>
            {agentId ? <AgentIdentity agentId={agentId} /> : null}
            <span>{t("agents.pathLabel")} <code>{displayPath(relationPathOf(row.relation))}</code></span>
          </dd>
        </div>
      </dl>
      <ul className="sh-governance__clean-facts">
        <li>{t("relationships.governance.clean.stopUsing")}</li>
        <li>{t("relationships.governance.clean.centralUnaffected")}</li>
        <li>{t("relationships.governance.clean.redeployLater")}</li>
        <li>
          {row.impact.rollback_available
            ? t("relationships.governance.clean.backupRollback")
            : t("relationships.governance.clean.noRollback")}
        </li>
      </ul>
      {row.blockers.length > 0 ? (
        <ul className="sh-governance__blockers">
          {row.blockers.map((blocker) => (
            <li key={blocker}>{t(`relationships.governance.blockers.${blocker}` as never)}</li>
          ))}
        </ul>
      ) : null}
      {/* 复用共享移除影响视图：备份位置、共享消费者与回退细节都在这里。 */}
      <RelationshipRemovalImpactView
        defaultOpen
        loadImpact={loadImpact}
        triggerLabel={t("relationshipGovernance.matrix.viewRemovalImpact")}
      />
      <label className="sh-governance__confirm-check">
        <input
          checked={ownershipConfirmed}
          data-testid="governance-clean-ownership"
          onChange={(event) => onOwnershipConfirmChange(event.target.checked)}
          type="checkbox"
        />
        {t("relationships.governance.clean.ownership")}
      </label>
      {error ? (
        <div role="alert">
          <p>{t("relationships.governance.preview.rejectedNote")}</p>
          <p>{error}</p>
        </div>
      ) : null}
      <div className="sh-governance__dialog-actions">
        <Button disabled={busy} onClick={onCancel} variant="secondary">
          {t("actions.cancel")}
        </Button>
        <Button
          data-testid="governance-clean-commit"
          disabled={busy || !ownershipConfirmed}
          onClick={onConfirm}
          variant="danger"
        >
          {t("relationships.governance.clean.commit")}
        </Button>
      </div>
    </div>
  );
}
