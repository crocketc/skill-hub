import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type RelationGovernanceBatchOutcome,
  type RemovalImpactFact,
  type RemovalResult,
} from "../../../api/bindings";
import { nativeRelationshipsFacade } from "../nativeApi";
import type {
  RelationGovernanceBatchRequest,
  RelationGovernanceFacade,
  RelationUndeployPreparation,
} from "./api";

function unexpectedResult(queryType: string): never {
  throw new Error(`${queryType} returned an unexpected native result.`);
}

/**
 * SkillHub 创建的部署关系在关系台账里的 relation_id 约定为
 * `managed:<deployment_id>`（relationship_repository 写入时的格式）。
 * 「从 Agent/项目移除」命令族走 deployment_id 命名空间，这里在
 * 适配层做一次确定性翻译；观测型关系没有 SkillHub 创建的目标入口，
 * 本来就不该出现移除动作，因此直接抛错而不是猜测。
 */
const MANAGED_RELATION_PREFIX = "managed:";

function deploymentIdForRelation(relationId: string): string {
  if (!relationId.startsWith(MANAGED_RELATION_PREFIX)) {
    throw new Error("governance.undeploy_requires_managed_relation");
  }
  return relationId.slice(MANAGED_RELATION_PREFIX.length);
}

/**
 * 任务 3 治理契约的原生包装：清单复用任务 5 的只读查询，
 * 编排命令走 prepare/commit/rollback，单条移除走既有 undeploy 命令族。
 * 页面不直接调用这些命令——统一执行由 runTrackedOperation 桥承接。
 */
export const nativeGovernanceFacade: RelationGovernanceFacade = {
  listGovernance: (params) => nativeRelationshipsFacade.listGovernance(params),

  async getRelationshipRemovalImpact(relationId: string): Promise<RemovalImpactFact> {
    const result = await queryApplication({
      type: "get_relationship_removal_impact",
      payload: { relation_id: relationId },
    });
    if (result.type !== "relationship_removal_impact") {
      return unexpectedResult("get_relationship_removal_impact");
    }
    return result.payload;
  },

  async prepareGovernanceBatch(
    request: RelationGovernanceBatchRequest,
  ): Promise<RelationGovernanceBatchOutcome> {
    const confirmations = Object.entries(request.confirmations)
      .filter(([, token]) => token.trim().length > 0);
    const result = await executeCommand({
      type: "prepare_relation_governance_batch",
      payload: {
        action: "centralize_management",
        relation_ids: request.relationIds,
        confirmations: confirmations.length > 0 ? Object.fromEntries(confirmations) : undefined,
      },
    });
    if (result.type !== "relation_governance_batch") {
      return unexpectedResult("prepare_relation_governance_batch");
    }
    return result.payload;
  },

  async commitGovernanceBatch(batchId: string, relationIds: string[]): Promise<RelationGovernanceBatchOutcome> {
    const result = await executeCommand({
      type: "commit_relation_governance_batch",
      payload: { batch_id: batchId, relation_ids: relationIds },
    });
    if (result.type !== "relation_governance_batch") {
      return unexpectedResult("commit_relation_governance_batch");
    }
    return result.payload;
  },

  async rollbackGovernanceBatch(batchId: string, relationIds: string[]): Promise<RelationGovernanceBatchOutcome> {
    const result = await executeCommand({
      type: "rollback_relation_governance_batch",
      payload: { batch_id: batchId, relation_ids: relationIds },
    });
    if (result.type !== "relation_governance_batch") {
      return unexpectedResult("rollback_relation_governance_batch");
    }
    return result.payload;
  },

  async prepareRelationUndeploy(relationId: string): Promise<RelationUndeployPreparation> {
    const deploymentId = deploymentIdForRelation(relationId);
    const result = await executeCommand({
      type: "prepare_undeploy",
      payload: { deployment_id: deploymentId },
    });
    if (result.type !== "removal_impact") {
      return unexpectedResult("prepare_undeploy");
    }
    return { relationId, deploymentId, operationId: result.payload.operation_id };
  },

  async commitRelationUndeploy(operationId: string): Promise<RemovalResult> {
    const result: AppCommandResult = await executeCommand({
      type: "commit_undeploy",
      payload: { prepared_undeploy_id: operationId, decision: "remove_owned_target" },
    });
    if (result.type !== "removal_result") {
      return unexpectedResult("commit_undeploy");
    }
    return result.payload;
  },
};
