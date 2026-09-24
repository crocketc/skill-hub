import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type GovernanceHistoryPage,
  type ListGovernanceHistory,
  type RelationGovernanceBatchOutcome,
  type RelationshipCheckLevel,
  type RelationshipCheckReport,
  type RemovalImpactFact,
  type RemovalResult,
  type SourceCopyRelationFact,
} from "../../../api/bindings";
import { nativeRelationshipsFacade } from "../nativeApi";
import type {
  GovernableRelation,
  GovernanceHistoryParams,
  RelationGovernanceBatchRequest,
  RelationGovernanceFacade,
  RelationUndeployPreparation,
} from "./api";

function unexpectedResult(queryType: string): never {
  throw new Error(`${queryType} returned an unexpected native result.`);
}

/** 治理历史驼峰参数 → 生成契约的 snake_case 查询载荷。 */
function historyQuery(params: GovernanceHistoryParams): ListGovernanceHistory {
  return {
    page: params.page,
    page_size: params.pageSize,
    relation_id: params.relationId ?? null,
    skill_id: params.skillId ?? null,
    agent_client_id: params.agentClientId ?? null,
    project_id: params.projectId ?? null,
    result: params.result ?? null,
  };
}

const MANAGED_RELATION_PREFIX = "managed:";

/**
 * 「从 Agent/项目移除」命令族走 deployment_id 命名空间。行类别（scope）
 * 由调用方读生成 DTO 的 `kind` 字段判定（计划 9.9）；这里只做一次确定性的
 * id 命名空间翻译——SkillHub 创建的部署关系在台账里的 relation_id 约定为
 * `managed:<deployment_id>`（relationship_repository 写入时的格式）。观测型
 * 关系（kind=source_copy 等）由 DTO 判定直接拒绝，绝不猜测。
 */
function deploymentIdForRelation(relation: GovernableRelation): {
  relationId: string;
  deploymentId: string;
} {
  if (relation.kind !== "deployment") {
    throw new Error("governance.undeploy_requires_deployment_relation");
  }
  const relationId = relation.fact.relation_id;
  if (!relationId.startsWith(MANAGED_RELATION_PREFIX)) {
    throw new Error("governance.undeploy_requires_managed_relation");
  }
  return {
    relationId,
    deploymentId: relationId.slice(MANAGED_RELATION_PREFIX.length),
  };
}

/**
 * 任务 3 治理契约的原生包装：清单复用任务 5 的只读查询，
 * 编排命令走 prepare/commit/rollback，单条移除走既有 undeploy 命令族。
 * 页面不直接调用这些命令——统一执行由 runTrackedOperation 桥承接。
 */
export const nativeGovernanceFacade: RelationGovernanceFacade = {
  listGovernance: (params) => nativeRelationshipsFacade.listGovernance(params),

  /** 计划 9.4：重校验是 RunRelationshipCheck 命令，事实由 Full/Light 校验落库。 */
  async revalidate(
    relationIds: string[],
    level: RelationshipCheckLevel = "full",
  ): Promise<RelationshipCheckReport> {
    const result = await executeCommand({
      type: "run_relationship_check",
      payload: {
        level,
        scope: relationIds.length > 0
          ? { relation_ids: { relation_ids: relationIds } }
          : "all_active",
      },
    });
    if (result.type !== "relationship_check_report") {
      return unexpectedResult("run_relationship_check");
    }
    return result.payload;
  },

  /** 计划 9.4：治理历史走独立分页查询，不混入通用清单。 */
  async listHistory(params: GovernanceHistoryParams): Promise<GovernanceHistoryPage> {
    const result = await queryApplication({
      type: "list_governance_history",
      payload: historyQuery(params),
    });
    if (result.type !== "governance_history_page") {
      return unexpectedResult("list_governance_history");
    }
    return result.payload;
  },

  /** 计划 8.15：保留来源副本——单条命令，幂等。 */
  async retainSourceCopy(relationId: string): Promise<SourceCopyRelationFact> {
    const result = await executeCommand({
      type: "retain_source_copy",
      payload: { source_relation_id: relationId },
    });
    if (result.type !== "source_copy_relation_updated") {
      return unexpectedResult("retain_source_copy");
    }
    return result.payload;
  },

  /** 计划 8.8/8.15：重关联——身份/内容校验与槽位判定都在后端完成。 */
  async relinkSourceCopy(relationId: string, newSourcePath: string): Promise<SourceCopyRelationFact> {
    const result = await executeCommand({
      type: "relink_source_copy",
      payload: { source_relation_id: relationId, new_source_path: newSourcePath },
    });
    if (result.type !== "source_copy_relation_updated") {
      return unexpectedResult("relink_source_copy");
    }
    return result.payload;
  },

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
        action: request.action,
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

  async prepareRelationUndeploy(relation: GovernableRelation): Promise<RelationUndeployPreparation> {
    const { relationId, deploymentId } = deploymentIdForRelation(relation);
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
