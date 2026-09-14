import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import type {
  SkillImportProvenance,
  SkillObservedDeployment,
} from "./api";

/**
 * OPT-20260914-08：导入存证 + 已观察部署关系的最小展示。
 *
 * 只读呈现：存证回答"这个 Skill 从哪里来"（导入那一刻的不可变事实），
 * 已观察关系回答"哪些 Agent 目录里已经部署着它"。来源不明（无 Agent
 * 归属）显式标注"未识别"，绝不猜测；内容分叉/同名疑似只标注不冒充。
 */
export function ProvenancePanel({
  provenance,
  observedDeployments,
}: {
  provenance: SkillImportProvenance | null;
  observedDeployments: SkillObservedDeployment[];
}) {
  const { t } = useTranslation();
  const hasProvenance = provenance !== null;
  const hasRelations = observedDeployments.length > 0;
  return (
    <div className="sh-detail-provenance" data-testid="provenance-panel">
      {hasProvenance ? (
        <section data-testid="import-provenance">
          <p>
            <strong>{t("skillDetail.provenance.source")}</strong>{" "}
            {t(`skillDetail.provenance.sourceKinds.${provenance.sourceKind}`, {
              defaultValue: provenance.sourceKind,
            })}
            <span>{provenance.sourceLocator}</span>
          </p>
          <p>
            <strong>{t("skillDetail.provenance.agent")}</strong>{" "}
            {provenance.agentClientId ??
              t("skillDetail.provenance.unknownAgent")}
          </p>
          <p>
            <strong>{t("skillDetail.provenance.originalPath")}</strong>{" "}
            <span>{provenance.originalPath}</span>
          </p>
          <p>
            <strong>{t("skillDetail.provenance.importedAt")}</strong>{" "}
            {provenance.importedAt}
          </p>
          <p>
            <strong>{t("skillDetail.provenance.fingerprint")}</strong>{" "}
            <span>{provenance.contentFingerprint}</span>
          </p>
          <p>
            <strong>{t("skillDetail.provenance.ownership")}</strong>{" "}
            {t(`skillDetail.provenance.ownerships.${provenance.ownership}`, {
              defaultValue: provenance.ownership,
            })}
          </p>
        </section>
      ) : (
        <p data-testid="provenance-absent">
          {t("skillDetail.provenance.absent")}
        </p>
      )}
      {hasRelations ? (
        <ul data-testid="observed-deployments">
          {observedDeployments.map((relation) => (
            <li key={relation.id} data-testid="observed-deployment">
              <span>{relation.originalPath}</span>
              <span>{relation.clientId}</span>
              <StatusBadge
                tone={relation.matchState === "content_verified" ? "success" : "neutral"}
              >
                {t(`skillDetail.provenance.matchStates.${relation.matchState}`)}
              </StatusBadge>
              <StatusBadge tone={relation.status === "active" ? "success" : "neutral"}>
                {t(`skillDetail.provenance.statuses.${relation.status}`)}
              </StatusBadge>
            </li>
          ))}
        </ul>
      ) : (
        <p data-testid="observed-absent">
          {t("skillDetail.provenance.noObservedDeployments")}
        </p>
      )}
    </div>
  );
}
