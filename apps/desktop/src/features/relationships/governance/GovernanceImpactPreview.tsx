import { useTranslation } from "react-i18next";
import type { RelationGovernanceRow, RemovalImpactFact } from "../../../api/bindings";
import { Button } from "../../../ui/Button";
import { RelationshipRemovalImpactView } from "../../relationshipGovernance/RelationshipRemovalImpactView";
import { fingerprintLabelKey, relationshipLabelKey } from "../../relationshipGovernance/relationshipGovernance";
import { rowNeedsSharedImpactConfirmation } from "./api";
import { displayPath } from "../../../platform/displayPath";
import { AgentIdentity } from "../../skills/AgentDeploymentIcons";

export interface GovernanceImpactPreviewProps {
  row: RelationGovernanceRow;
  mode: "centralize" | "undeploy";
  /** 只读加载该关系边的移除/迁移影响事实（备份、共享影响、回退）。 */
  loadImpact: () => Promise<RemovalImpactFact>;
  busy: boolean;
  /** 后端拒绝后的错误文本；非空时预览保持打开并原样展示。 */
  error: string | null;
  sharedImpactConfirmed: boolean;
  onSharedImpactConfirmChange: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 单条治理预览（任务 8）：先展示确定性影响事实，确认后才执行。
 * 「纳入集中库管理」按冻结解释呈现：保留当前位置的可用入口，改为使用
 * 集中库中的统一版本；后端拒绝时预览保持不变，绝不翻转成成功。
 */
export function GovernanceImpactPreview({
  busy,
  error,
  loadImpact,
  mode,
  onCancel,
  onConfirm,
  onSharedImpactConfirmChange,
  row,
  sharedImpactConfirmed,
}: GovernanceImpactPreviewProps) {
  const { t } = useTranslation();
  const needsSharedImpactConfirmation = rowNeedsSharedImpactConfirmation(row);
  const title = mode === "centralize"
    ? t("relationships.governance.preview.centralizeTitle")
    : t("relationships.governance.preview.undeployTitle");

  return (
    <div aria-label={title} className="sh-governance__dialog" role="dialog">
      <h3>{title}</h3>
      {mode === "centralize" ? (
        <p data-testid="governance-centralize-explain">
          {t("relationships.governance.centralize.explain")}
        </p>
      ) : null}
      <dl className="sh-governance__facts">
        <div>
          <dt>{t("relationships.governance.preview.relationLabel")}</dt>
          <dd>{t(relationshipLabelKey(row.relation.relationship) as never)}</dd>
        </div>
        <div>
          <dt>{t("relationships.governance.preview.targetLabel")}</dt>
          <dd>
            <AgentIdentity agentId={row.relation.agent_client_id} />
            <code>{displayPath(row.relation.path)}</code>
          </dd>
        </div>
        <div>
          <dt>{t("relationships.governance.preview.verificationLabel")}</dt>
          <dd>{t(fingerprintLabelKey(row.relation.match_state) as never)}</dd>
        </div>
      </dl>
      {/* 复用共享移除影响视图：备份、共享消费者、其他路径与回退信息都在这里。 */}
      <RelationshipRemovalImpactView
        defaultOpen
        loadImpact={loadImpact}
        triggerLabel={t("relationshipGovernance.matrix.viewRemovalImpact")}
      />
      {needsSharedImpactConfirmation ? (
        <label className="sh-governance__confirm-check">
          <input
            checked={sharedImpactConfirmed}
            onChange={(event) => onSharedImpactConfirmChange(event.target.checked)}
            type="checkbox"
          />
          {t("relationships.governance.preview.sharedImpactConfirm")}
        </label>
      ) : null}
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
          disabled={busy || (needsSharedImpactConfirmation && !sharedImpactConfirmed)}
          onClick={onConfirm}
        >
          {t("relationships.governance.preview.confirm")}
        </Button>
      </div>
    </div>
  );
}
