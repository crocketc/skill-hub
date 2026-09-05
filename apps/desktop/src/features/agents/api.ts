export interface AgentRelation {
  logicalLabel: string;
  logicalTargetId: string;
  physicalPath: string;
  physicalTargetId: string;
}

export type AgentStatus = "accessible" | "directory_only" | "inaccessible" | "custom";

export interface AgentView {
  brand: string;
  client: string;
  discoveredPaths: string[];
  id: string;
  instance: string;
  managedDeploymentCount: number;
  relations: AgentRelation[];
  status: AgentStatus;
}

export interface AgentFacade {
  list(): Promise<AgentView[]>;
  get(id: string): Promise<AgentView>;
  rescan(): Promise<void>;
}

function unavailable(operation: string): Promise<never> {
  return Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
}

export const unavailableAgentFacade: AgentFacade = {
  get: () => unavailable("agent_get"),
  list: () => unavailable("agent_list"),
  rescan: () => unavailable("agent_rescan"),
};

export function sharedTargetFixture(): AgentView {
  return {
    brand: "OpenAI",
    client: "Codex family",
    discoveredPaths: ["C:/Users/demo/.agents/skills"],
    id: "openai-codex",
    instance: "Codex CLI",
    managedDeploymentCount: 0,
    relations: [
      {
        logicalLabel: "Codex CLI",
        logicalTargetId: "codex-cli",
        physicalPath: "C:/Users/demo/.agents/skills",
        physicalTargetId: "shared-agents-skills",
      },
      {
        logicalLabel: "Codex Desktop",
        logicalTargetId: "codex-desktop",
        physicalPath: "C:/Users/demo/.agents/skills",
        physicalTargetId: "shared-agents-skills",
      },
    ],
    status: "accessible",
  };
}

export function agentFixture(): AgentView {
  return sharedTargetFixture();
}
