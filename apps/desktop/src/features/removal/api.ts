export type RemovalChoice = "keep_deployed" | "remove_deployment" | "convert_to_copy";
export type RemovalDeployment = {
  id: string;
  label: string;
  path: string;
  physicalId: string;
  agentId?: string;
  brand?: string;
  sharedDirectory?: boolean;
};
/** QA-001：项目对某 Skill 的固定版本（US-051）。 */
export type RemovalVersionPin = {
  projectId: string;
  versionId: string;
};
export type RemovalImpact = {
  operationId?: string;
  skillId: string;
  skillName: string;
  deployments: RemovalDeployment[];
  /** 共享项目配置要求该 Skill 的项目名。 */
  dependentProjects: string[];
  /** QA-001：删除前重新扫描的其余影响维度（US-051）。 */
  declaredDependencies: string[];
  pinnedVersions: RemovalVersionPin[];
  combinations: string[];
  relatedSkills: string[];
  unknownExternalReferences: string[];
};

/** K2：多目标删除逐项执行状态（生成绑定 RemovalItemStatus）。 */
export type RemovalItemStatus = "applied" | "failed" | "pending";
/** K2：删除整体执行状态（生成绑定 RemovalResultState）。 */
export type RemovalResultState = "committed" | "partially_committed" | "failed";
/** 单个部署关系的删除执行结果（生成绑定 DeploymentRemovalResult 的桌面映射）。 */
export type RemovalItemOutcome = {
  deploymentId: string;
  status: RemovalItemStatus;
  errorCode?: string | null;
};

export type RemovalResult = {
  centralSkillDeleted: boolean;
  /** 绑定注释：旧载荷缺省按已提交（committed）读取。 */
  state?: RemovalResultState;
  /** delete_skill 失败时登记的恢复候选操作 id，指向恢复中心。 */
  recoveryOperationId?: string | null;
  /** 中央 Skill 删除失败的错误码；非空即「目标已回收，中央 Skill 未删除」。 */
  centralDeleteError?: string | null;
  /** 逐项执行结果；旧载荷缺省视为无逐项数据（不冒充成功）。 */
  items?: RemovalItemOutcome[];
};

export type UndeployDecision = "remove_owned_target" | "keep_shared_deployment" | "remove_relation_only";
export type UndeployImpact = {
  deploymentId: string;
  label: string;
  operationId: string;
  sharedTarget: boolean;
};

export interface RemovalFacade {
  prepareUndeploy(deploymentId: string, label: string): Promise<UndeployImpact>;
  commitUndeploy(operationId: string, decision: UndeployDecision): Promise<void>;
  prepareDelete(skillId: string, skillName?: string): Promise<RemovalImpact>;
  commitDelete(
    operationId: string,
    choices: Record<string, RemovalChoice>,
  ): Promise<RemovalResult>;
}

export function removalImpactFixture(): RemovalImpact {
  return {
    skillId: "skill-pdf",
    skillName: "PDF Reader",
    deployments: [
      { id: "codex", label: "Codex CLI", path: "C:/Users/demo/.codex/skills", physicalId: "codex-skills" },
      { id: "claude", label: "Claude Code", path: "C:/Users/demo/.claude/skills", physicalId: "claude-skills" },
    ],
    dependentProjects: ["Demo Project"],
    declaredDependencies: [],
    pinnedVersions: [],
    combinations: [],
    relatedSkills: [],
    unknownExternalReferences: [],
  };
}
