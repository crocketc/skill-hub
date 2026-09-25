import type {
  ConflictWorkspace,
  RelationGovernanceFilters,
  RelationGovernanceLedger,
  RelationshipGraphFilters,
  RelationshipGraphStatus,
  RelationshipType,
  SkillRelationshipCandidate,
  SkillRelationshipGraphResult,
} from "../../api/bindings";

export type {
  ConflictWorkspace,
  RelationGovernanceFilters,
  RelationGovernanceLedger,
  RelationshipGraphFilters,
  RelationshipGraphStatus,
  RelationshipType,
  SkillRelationshipCandidate,
  SkillRelationshipGraphResult,
};

/** 图谱筛选（任务 6 消费）：URL 与 query key 都必须携带同一份筛选事实。 */
export interface RelationshipGraphParams {
  skillId: string;
  relationshipTypes?: RelationshipType[];
  statuses?: RelationshipGraphStatus[];
  /** 图谱事实快照修订号；键中携带修订号可避免陈旧缓存回流。 */
  relationshipRevision?: string;
}

/** 治理台账筛选（任务 8 消费）：仅已提交的筛选进入查询。 */
export interface RelationshipGovernanceParams extends RelationGovernanceFilters {
  relationshipRevision?: string;
}

/** 冲突工作台参数（任务 7 消费）：工作台投影当前不带筛选，预留修订号。 */
export interface RelationshipConflictsParams {
  relationshipRevision?: string;
}

/** 候选搜索参数（图谱中心选择消费）。 */
export interface RelationshipCandidatesParams {
  text?: string;
  tags?: string[];
}

/**
 * 技能关系模块共享 query key 命名空间（任务 5）。
 * 约定：键必须包含 skillId、筛选与 relationship_revision（实施计划任务 6），
 * 页面级 hook 在此基础上组合，不得绕过该命名空间自建键。
 */
export const relationshipsKeys = {
  root: ["relationships"] as const,
  candidates: (params: RelationshipCandidatesParams = {}) =>
    [relationshipsKeys.root, "candidates", params] as const,
  graph: (params: RelationshipGraphParams) =>
    [relationshipsKeys.root, "graph", params] as const,
  conflicts: (params: RelationshipConflictsParams = {}) =>
    [relationshipsKeys.root, "conflicts", params] as const,
  governance: (params: RelationshipGovernanceParams = {}) =>
    [relationshipsKeys.root, "governance", params] as const,
  governanceHistory: (params: {
    page: number;
    pageSize: number;
    /** 任务 12C：Skill 详情页按 skill 过滤的摘要查询与治理历史页分开缓存。 */
    skillId?: string | null;
  }) =>
    [relationshipsKeys.root, "governance-history", params] as const,
};

/** 只读关系查询门面；写入类操作由后续任务经统一异步包装接入。 */
export interface RelationshipsFacade {
  listCandidates(params?: RelationshipCandidatesParams): Promise<SkillRelationshipCandidate[]>;
  getGraph(params: RelationshipGraphParams): Promise<SkillRelationshipGraphResult>;
  getConflictWorkspace(params?: RelationshipConflictsParams): Promise<ConflictWorkspace>;
  listGovernance(params?: RelationshipGovernanceParams): Promise<RelationGovernanceLedger>;
}
