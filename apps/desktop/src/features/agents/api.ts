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
  /** Number of unique deployed skills behind this agent. */
  managedDeploymentCount: number;
  /** Raw deployment relation count kept as auxiliary context. */
  managedDeploymentRelationCount: number;
  /** First official profile reference of a custom agent, when registered. */
  officialReference: string | null;
  relations: AgentRelation[];
  status: AgentStatus;
}

/** View-level values collected by the custom agent form. */
export interface CustomAgentFormValues {
  brand: string;
  displayName: string;
  directoryPath: string;
  referenceUrl: string;
}

export interface AgentFacade {
  list(): Promise<AgentView[]>;
  get(id: string): Promise<AgentView>;
  rescan(): Promise<void>;
  createCustomAgent(values: CustomAgentFormValues): Promise<void>;
  updateCustomAgent(id: string, values: CustomAgentFormValues): Promise<void>;
  removeCustomAgent(id: string): Promise<void>;
}

function unavailable(operation: string): Promise<never> {
  return Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
}

export const unavailableAgentFacade: AgentFacade = {
  get: () => unavailable("agent_get"),
  list: () => unavailable("agent_list"),
  rescan: () => unavailable("agent_rescan"),
  createCustomAgent: () => unavailable("create_custom_agent"),
  updateCustomAgent: () => unavailable("update_custom_agent"),
  removeCustomAgent: () => unavailable("remove_custom_agent"),
};

export function sharedTargetFixture(): AgentView {
  return {
    brand: "OpenAI",
    client: "Codex family",
    discoveredPaths: ["C:/Users/demo/.agents/skills"],
    id: "openai-codex",
    instance: "Codex CLI",
    managedDeploymentCount: 2,
    managedDeploymentRelationCount: 5,
    officialReference: null,
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

export function customAgentFixture(): AgentView {
  return {
    brand: "Acme",
    client: "custom",
    discoveredPaths: ["D:/Agents/reviewer"],
    id: "custom-reviewer",
    instance: "Reviewer",
    managedDeploymentCount: 0,
    managedDeploymentRelationCount: 0,
    officialReference: "https://acme.example/docs",
    relations: [
      {
        logicalLabel: "Reviewer",
        logicalTargetId: "custom-reviewer",
        physicalPath: "D:/Agents/reviewer",
        physicalTargetId: "grant-1",
      },
    ],
    status: "custom",
  };
}
