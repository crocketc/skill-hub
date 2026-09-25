import type { AgentKindKey } from "../../ui/AgentPresentation";
import type { RelationshipOverview, RemovalImpactFact } from "../../api/bindings";

export type { RelationshipOverview, RemovalImpactFact };

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
  /**
   * 2026-09-25 验收裁决：`true` 标记内置技能目录视图（如
   * `.codex/skills/.system`）——只读观察，不参与部署/删除。
   */
  builtin?: boolean;
  /**
   * 2026-09-25 验收反馈：后端 discovery 快照的权威 ClientKind。展示层
   * 不再从 id 字符串猜类型（pi.coding-agent 等不含关键词的 id 会被
   * 猜成 unknown →「Agent」徽标）。
   */
  kinds?: AgentKindKey[];
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
  /** Task 7：目录矩阵的确定性事实来源（typed facade，只读查询）。 */
  getRelationshipOverview(agentClientId: string): Promise<RelationshipOverview>;
  /** Task 7：按关系读取移除影响（读取既有 RemovalImpact 契约）。 */
  getRelationshipRemovalImpact(relationId: string): Promise<RemovalImpactFact>;
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
  getRelationshipOverview: () => unavailable("get_relationship_overview"),
  getRelationshipRemovalImpact: () => unavailable("get_relationship_removal_impact"),
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
