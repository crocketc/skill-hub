import { queryApplication } from "../../api/bindings";
import type {
  RelationshipCandidatesParams,
  RelationshipGraphParams,
  RelationshipGovernanceParams,
  RelationshipsFacade,
} from "./api";

function unexpectedResult(queryType: string): never {
  throw new Error(`${queryType} returned an unexpected native result.`);
}

/**
 * 任务 1 契约的只读查询包装（get_skill_relationship_graph 等）。
 * 页面绝不触发扫描/AI/写入；筛选事实由调用方显式携带。
 * relationship_revision 只进 query key，不发给原生查询（契约不消费它）。
 */
export const nativeRelationshipsFacade: RelationshipsFacade = {
  async listCandidates(params: RelationshipCandidatesParams = {}) {
    const result = await queryApplication({
      type: "list_skill_relationship_candidates",
      payload: params,
    });
    if (result.type !== "skill_relationship_candidates") {
      return unexpectedResult("list_skill_relationship_candidates");
    }
    return result.payload;
  },
  async getGraph(params: RelationshipGraphParams) {
    const result = await queryApplication({
      type: "get_skill_relationship_graph",
      payload: {
        skill_id: params.skillId,
        filters: {
          relationship_types: params.relationshipTypes,
          statuses: params.statuses,
        },
      },
    });
    if (result.type !== "skill_relationship_graph") {
      return unexpectedResult("get_skill_relationship_graph");
    }
    return result.payload;
  },
  async getConflictWorkspace() {
    const result = await queryApplication({
      type: "get_conflict_workspace",
      payload: null,
    });
    if (result.type !== "conflict_workspace") {
      return unexpectedResult("get_conflict_workspace");
    }
    return result.payload;
  },
  async listGovernance(params: RelationshipGovernanceParams = {}) {
    const { relationshipRevision: _revision, ...filters } = params;
    void _revision;
    const result = await queryApplication({
      type: "list_relation_governance",
      payload: { filters },
    });
    if (result.type !== "relation_governance_ledger") {
      return unexpectedResult("list_relation_governance");
    }
    return result.payload;
  },
};
