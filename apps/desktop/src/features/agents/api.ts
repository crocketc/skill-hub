import type { AgentKindKey } from "../../ui/AgentPresentation";
import type { AgentDirectoryMemberFact, RelationshipOverview, RemovalImpactFact } from "../../api/bindings";
import type { AgentCardModel } from "./agentCardModel";

export type { RelationshipOverview, RemovalImpactFact };
export type {
  AgentDirectoryAvailability,
  AgentDirectoryFact,
  AgentDirectoryIdentity,
  AgentDirectoryMemberCapabilities,
  AgentDirectoryMemberFact,
  AgentDirectoryProjection,
} from "../../api/bindings";

export interface AgentRelation {
  logicalLabel: string;
  logicalTargetId: string;
  physicalPath: string;
  physicalTargetId: string;
}

export type AgentStatus = "accessible" | "directory_only" | "inaccessible" | "custom";
export type AgentDirectoryStatus = "existing" | "pending_creation" | "inaccessible" | "non_directory" | "broken_link";
export type AgentDirectoryRole = "agent_native" | "shared_directory" | "project" | "builtin";
export type AgentDeploymentMode = "managed_copy" | "symbolic_link" | "directory_junction";
export type AgentDeploymentStatus = "deployed" | "partially_deployed" | "not_deployed" | "unknown";

export interface AgentDirectoryView {
  path: string | null;
  status: AgentDirectoryStatus;
  role: AgentDirectoryRole;
  sharedReference: boolean;
  builtin: boolean;
  readable: boolean;
  writable: boolean;
  available: boolean;
  physicalIdentityVerified: boolean;
  physicalIdentityKey?: string;
  /** Stable candidate identity used only when the directory is not yet verified. */
  candidateIdentityKey?: string;
  supportedModes: AgentDeploymentMode[];
  preferredMode?: AgentDeploymentMode;
  deploymentStatus: AgentDeploymentStatus;
}

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
  /**
   * DEV-88：shared_reference 的目录路径（.agents\skills 等，原始拼法）。
   * 渲染层按文件系统身份把对应路径行替换为「支持共享目录」chip。
   */
  sharedReferencePaths?: string[];
  /** First official profile reference of a custom agent, when registered. */
  officialReference: string | null;
  relations: AgentRelation[];
  status: AgentStatus;
  /** Unified directory facts used by every Agent presentation surface. */
  directoryViews?: AgentDirectoryView[];
  /** Member-scoped target and capability facts from the canonical projection. */
  directoryMembers?: AgentDirectoryMemberFact[];
  /** Managed deployment state for this view or the represented directory card. */
  deploymentStatus?: AgentDeploymentStatus;
  /** Whether this recognised brand can consume the shared directory. */
  supportsSharedDirectory?: boolean;
  /** Brands shown on the independent shared-directory card. */
  sharedAgentBrands?: string[];
  /** Display types shown in each shared-directory brand logo tooltip. */
  sharedAgentBrandKinds?: Record<string, string[]>;
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
  /** Canonical directory-card read path; optional for older preview/test facades. */
  listCardModels?(): Promise<AgentCardModel[]>;
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
