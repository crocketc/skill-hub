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
  assembly: ProjectAssemblyItem[];
  description: string;
  id: string;
  name: string;
  sharedConfig: ProjectSharedConfig;
  tags: string[];
}

export interface ProjectFacade {
  list(): Promise<ProjectView[]>;
  get(id: string): Promise<ProjectView>;
}

function unavailable(operation: string): Promise<never> {
  return Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
}

export const unavailableProjectFacade: ProjectFacade = {
  get: () => unavailable("project_get"),
  list: () => unavailable("project_list"),
};

export function projectFixture(): ProjectView {
  return {
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
