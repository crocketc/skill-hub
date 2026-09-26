import { useTranslation } from "react-i18next";
import { displayPath } from "../../platform/displayPath";
import { AgentPresentation } from "../../ui/AgentPresentation";
import type { RemovalDeployment, RemovalImpact } from "./api";
import "./removal.css";

/**
 * DEV-97：删除影响呈现的共享组件——单删对话框、批量删除抽屉与批量对话框
 * 用同一套部署目标行与影响矩阵渲染，避免多套实现各自漂移。
 */

/** 部署目标行：品牌厂商 + 用户可理解类型徽标（AGENTS.md Agent 呈现约定），
 *  路径规范化展示；agentId 缺失的历史数据回退到调用方 label。 */
export function RemovalDeploymentTarget({ deployment }: { deployment: RemovalDeployment }) {
  return (
    <span className="sh-removal-impact__target">
      {deployment.agentId ? (
        <AgentPresentation
          agentId={deployment.agentId}
          brand={deployment.brand}
          sharedDirectory={deployment.sharedDirectory}
        />
      ) : (
        <strong>{deployment.label}</strong>
      )}
      <small>{displayPath(deployment.path)}</small>
    </span>
  );
}

interface RemovalImpactDimension {
  label: string;
  values: string[];
}

/** QA-001 影响矩阵的结构化呈现：每个维度一行、值逐条列出——
 *  删除影响供用户决策，不能把多条路径拼成一段长文本。 */
export function RemovalImpactMatrix({ impact }: { impact: RemovalImpact }) {
  const { t } = useTranslation();
  // 桌面契约按缺省空集归一，但预览/夹具可能省略字段：逐维度容错。
  const dependentProjects = impact.dependentProjects ?? [];
  const declaredDependencies = impact.declaredDependencies ?? [];
  const pinnedVersions = impact.pinnedVersions ?? [];
  const combinations = impact.combinations ?? [];
  const relatedSkills = impact.relatedSkills ?? [];
  const unknownExternalReferences = impact.unknownExternalReferences ?? [];
  const dimensions: RemovalImpactDimension[] = [];
  if (dependentProjects.length > 0) {
    dimensions.push({ label: t("removal.dependentsLabel"), values: dependentProjects });
  }
  if (declaredDependencies.length > 0) {
    dimensions.push({
      label: t("removal.batch.impact.declaredDependencies"),
      values: declaredDependencies,
    });
  }
  if (pinnedVersions.length > 0) {
    // 项目 id 与版本哈希是技术标识，不进界面：固定版本保持计数呈现。
    dimensions.push({
      label: t("removal.batch.impact.pinnedVersions", { count: pinnedVersions.length }),
      values: [],
    });
  }
  if (combinations.length > 0) {
    dimensions.push({ label: t("removal.batch.impact.combinations"), values: combinations });
  }
  if (relatedSkills.length > 0) {
    dimensions.push({ label: t("removal.batch.impact.relatedSkills"), values: relatedSkills });
  }
  if (unknownExternalReferences.length > 0) {
    dimensions.push({
      label: t("removal.batch.impact.unknownExternalReferences"),
      values: unknownExternalReferences.map((reference) => displayPath(reference)),
    });
  }
  if (dimensions.length === 0) return null;
  return (
    <ul className="sh-removal-impact__matrix">
      {dimensions.map((dimension) => (
        <li className="sh-removal-impact__dimension" key={dimension.label}>
          <span className="sh-removal-impact__dimension-label">{dimension.label}</span>
          {dimension.values.length > 0 ? (
            <ul className="sh-removal-impact__values">
              {dimension.values.map((value) => (
                <li key={value}>{value}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
