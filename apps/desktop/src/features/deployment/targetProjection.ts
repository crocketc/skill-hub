import type { DeploymentRecord } from "../../api/bindings";

/**
 * 逻辑目标与物理部署目标的 id 投影（DEV-22-A）。
 *
 * 真实提交把 `deployments.target_id` 写成物理目标 id（`TargetPlan` 的
 * `physical_target_id`），而 Agent 页/详情页拿到的是逻辑目标（`LogicalTarget.id`
 * 与 `DeploymentTarget.id`）。两个 id 空间必须互投影：否则同一条部署在
 * Agent 页计数为 0，而概览（后端按 `targets.agent_id` 分组）却数得出来——
 * 各视图口径不一致。
 */
export interface TargetIdPair {
  /** 逻辑目标 id（`LogicalTarget.id` / `DeploymentTarget.id`）。 */
  id: string;
  /** 物理目标 id（`physical_id`），即 `deployments.target_id` 的记录值。 */
  physicalId: string;
}

/** 一条部署记录可能落在哪个 id 空间：逻辑与物理都接受。 */
export function deploymentTargetIdSpace(targets: readonly TargetIdPair[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const target of targets) {
    ids.add(target.id);
    ids.add(target.physicalId);
  }
  return ids;
}

/** 按「逻辑 id 或物理 id」双键建索引，供关系/详情按任一 id 空间回查目标。 */
export function indexTargetsByAnyId<T extends { id: string; physical_id: string }>(
  targets: readonly T[],
): Map<string, T> {
  const index = new Map<string, T>();
  for (const target of targets) {
    index.set(target.id, target);
    index.set(target.physical_id, target);
  }
  return index;
}

/**
 * 受管部署统计：关系条数与去重后的 Skill 数。
 * 已移除与非受管记录不计入（与既有口径一致）。
 */
export function countManagedDeployments(
  deployments: readonly DeploymentRecord[],
  acceptedTargetIds: ReadonlySet<string>,
): { relations: number; skills: number } {
  const active = deployments.filter(
    (deployment) => deployment.managed
      && deployment.state !== "removed"
      && acceptedTargetIds.has(deployment.target_id),
  );
  return {
    relations: active.length,
    skills: new Set(active.map((deployment) => deployment.skill_id)).size,
  };
}
