import { useTranslation } from "react-i18next";
import type { DeploymentRecord, DeploymentTarget } from "../../api/bindings";
import type { SkillTableRow } from "./api";

export interface SkillMatrixProps {
  items: SkillTableRow[];
  deploymentRecords?: DeploymentRecord[];
  deploymentTargets?: DeploymentTarget[];
}

/**
 * FE-04 关系矩阵：Skill × 部署目标的部署关系一览。
 * 数据来自真实部署记录（list_deployments）；列取全部已注册目标，
 * 无部署关系的单元格留空。目标读取失败时如实降级为 target_id 列名。
 */
export function SkillMatrix({ items, deploymentRecords, deploymentTargets }: SkillMatrixProps) {
  const { t } = useTranslation();

  if (!deploymentRecords) {
    return <p role="status">{t("skillLibrary.matrix.loading")}</p>;
  }
  if (deploymentRecords.length === 0) {
    return <p>{t("skillLibrary.matrix.empty")}</p>;
  }

  const labelByTargetId = new Map(
    (deploymentTargets ?? []).map((target) => [target.id, target.label]),
  );
  const targetIds = [...new Set(deploymentRecords.map((record) => record.target_id))];
  const deployed = new Set(
    deploymentRecords
      .filter((record) => record.state !== "removed")
      .map((record) => `${record.skill_id}\u0000${record.target_id}`),
  );
  return (
    <div className="sh-skill-matrix" role="region" aria-label={t("skillLibrary.matrix.ariaLabel")}>
      <table className="sh-skill-matrix__table">
        <thead>
          <tr>
            <th scope="col">{t("skillLibrary.matrix.skillColumn")}</th>
            {targetIds.map((targetId) => (
              <th key={targetId} scope="col">
                {labelByTargetId.get(targetId) ?? targetId}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <th scope="row">{item.name}</th>
              {targetIds.map((targetId) => {
                const hit = deployed.has(`${item.id}\u0000${targetId}`);
                return (
                  <td data-testid={`matrix-${item.id}-${targetId}`} key={targetId}>
                    {hit ? "✓" : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sh-skill-matrix__hint">{t("skillLibrary.matrix.hint")}</p>
    </div>
  );
}
