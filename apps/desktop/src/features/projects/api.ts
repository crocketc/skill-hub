export type ProjectAssemblyStatus = "satisfied" | "skipped" | "conflict" | "failed";

export interface ProjectAssemblyItem {
  message: string;
  skillId: string;
  skillName: string;
  status: ProjectAssemblyStatus;
}

export interface ProjectSharedConfig {
  identityHint: string;
  requirements: string[];
  targetIds: string[];
}

export interface ProjectView {
  agentIds: string[];
  assembly: ProjectAssemblyItem[];
  description: string;
  id: string;
  name: string;
  sharedConfig: ProjectSharedConfig;
  tags: string[];
}

export interface ProjectRegistration {
  agentIds: string[];
  id: string;
  name: string;
  path: string;
  tags: string[];
}

export interface ProjectFacade {
  list(): Promise<ProjectView[]>;
  get(id: string): Promise<ProjectView>;
  register(input: ProjectRegistration): Promise<ProjectView>;
  updateAgentIds(projectId: string, agentIds: string[]): Promise<ProjectView>;
  listAgentCandidates(): Promise<ProjectAgentCandidate[]>;
}

export interface ProjectAgentCandidate { id: string; label: string; available: boolean; }

function unavailable(operation: string): Promise<never> {
  return Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
}

export const unavailableProjectFacade: ProjectFacade = {
  get: () => unavailable("project_get"),
  list: () => unavailable("project_list"),
  register: () => unavailable("project_register"),
  updateAgentIds: () => unavailable("project_update_agent_ids"),
  listAgentCandidates: () => unavailable("project_agent_candidates"),
};

export function projectFixture(): ProjectView {
  return {
    agentIds: [],
    assembly: [
      { message: "已满足项目要求", skillId: "pdf-reader", skillName: "PDF Reader", status: "satisfied" },
      { message: "项目选择跳过此 Skill", skillId: "browser-helper", skillName: "Browser Helper", status: "skipped" },
      { message: "需要确认目标目录冲突", skillId: "release-notes", skillName: "Release Notes", status: "conflict" },
      { message: "读取来源失败", skillId: "api-review", skillName: "API Review", status: "failed" },
    ],
    description: "用于验证项目级 Skill 组合的示例项目",
    id: "demo-project",
    name: "Demo Project",
    sharedConfig: {
      identityHint: "C:/Projects/demo",
      requirements: ["Rust", "文档审阅"],
      targetIds: ["codex-cli", "claude-code"],
    },
    tags: ["客户项目", "Rust", "演示"],
  };
}
