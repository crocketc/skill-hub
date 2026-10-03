import { useTranslation } from "react-i18next";
import type { RelationGovernanceRow } from "../../../api/bindings";
import { Button } from "../../../ui/Button";
import { AgentIdentity } from "../../skills/AgentDeploymentIcons";
import { fingerprintLabelKey, relationshipLabelKey } from "../../relationshipGovernance/relationshipGovernance";
import { RelationshipPath } from "../RelationshipPath";
import {
  governanceSkillDisplayName,
} from "./GovernanceRelationTable";
import {
  relationAgentIdOf,
  relationPathOf,
  relationVerificationKeyOf,
  relationshipKeyOf,
} from "./api";

export type GovernanceDecisionAction = "revoke_retention" | "end_relationship";

export function GovernanceDecisionPreview({
  action,
  busy,
  error,
  onCancel,
  onConfirm,
  row,
}: {
  action: GovernanceDecisionAction;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  row: RelationGovernanceRow;
}) {
  const { t } = useTranslation();
  const title = String(t(`relationships.governance.preview.${action}Title` as never));
  const agentId = relationAgentIdOf(row.relation);

  return (
    <section aria-label={title} className="sh-governance__dialog" role="dialog">
      <h3>{title}</h3>
      <p data-testid="governance-decision-impact">
        {t(`relationships.governance.preview.${action}Impact` as never)}
      </p>
      <dl className="sh-governance__facts">
        <div>
          <dt>{t("relationships.governance.preview.skillLabel")}</dt>
          <dd>{governanceSkillDisplayName(row, t)}</dd>
        </div>
        <div>
          <dt>{t("relationships.governance.preview.relationLabel")}</dt>
          <dd>{t(relationshipLabelKey(relationshipKeyOf(row.relation) as never) as never)}</dd>
        </div>
        <div>
          <dt>{t("relationships.governance.preview.targetLabel")}</dt>
          <dd>
            {agentId ? <AgentIdentity agentId={agentId} /> : null}
            <RelationshipPath path={relationPathOf(row.relation)} />
          </dd>
        </div>
        <div>
          <dt>{t("relationships.governance.preview.verificationLabel")}</dt>
          <dd>{t(fingerprintLabelKey(relationVerificationKeyOf(row.relation) as never) as never)}</dd>
        </div>
      </dl>
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
        <Button disabled={busy} onClick={onConfirm}>
          {t(`relationships.governance.preview.${action}Confirm` as never)}
        </Button>
      </div>
    </section>
  );
}
