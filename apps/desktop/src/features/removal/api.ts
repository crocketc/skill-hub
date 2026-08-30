export type RemovalChoice = "keep_deployed" | "remove_deployment" | "convert_to_copy";
export type RemovalDeployment = {
  id: string;
  label: string;
  path: string;
  physicalId: string;
};
export type RemovalImpact = {
  operationId?: string;
  skillId: string;
  skillName: string;
  deployments: RemovalDeployment[];
  dependentProjects: string[];
};

export type RemovalResult = {
  centralSkillDeleted: boolean;
};

export interface RemovalFacade {
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
  };
}
