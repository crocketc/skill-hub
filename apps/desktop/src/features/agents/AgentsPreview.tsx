import { useMemo } from "react";
import { type AgentFacade, type AgentView } from "./api";
import { AgentDetailPage } from "./AgentDetailPage";
import { AgentListPage } from "./AgentListPage";

/**
 * Deterministic DEV-only fixture for /__preview/agents. Covers the layout
 * matrix without touching disk, network, or the Tauri backend: long Windows
 * and macOS paths, an inaccessible client, a directory-only instance, and a
 * custom agent with edit/remove actions. `?empty=1` renders the empty state.
 */
const previewAgents: AgentView[] = [
  {
    brand: "OpenAI",
    client: "codex-cli",
    discoveredPaths: ["C:/Users/Developer/AppData/Local/SkillHub/agents/codex/skills"],
    id: "openai.codex-cli",
    instance: "Codex CLI",
    managedDeploymentCount: 12,
    managedDeploymentRelationCount: 18,
    officialReference: null,
    relations: [],
    status: "accessible",
  },
  {
    brand: "anthropic",
    client: "claude-code",
    discoveredPaths: [
      "/Users/preview/Library/Application Support/SkillHub/agents/claude/skills",
    ],
    id: "anthropic.claude-code",
    instance: "Claude Code",
    managedDeploymentCount: 3,
    managedDeploymentRelationCount: 4,
    officialReference: null,
    relations: [],
    status: "accessible",
  },
  {
    brand: "cursor",
    client: "cursor",
    discoveredPaths: ["D:/Very/Long/Windows/Library/Directory/On/A/Second/Volume/with/project/workspace/skills"],
    id: "cursor.missing",
    instance: "Cursor on drive D",
    managedDeploymentCount: 0,
    managedDeploymentRelationCount: 0,
    officialReference: null,
    relations: [],
    status: "inaccessible",
  },
  {
    brand: "windsurf",
    client: "windsurf",
    discoveredPaths: ["/mnt/secondary/Volumes/TeamDrive/Agents/windsurf/skills"],
    id: "windsurf.detect-only",
    instance: "Windsurf (directory only)",
    managedDeploymentCount: 0,
    managedDeploymentRelationCount: 0,
    officialReference: null,
    relations: [],
    status: "directory_only",
  },
  {
    brand: "Acme Robotics",
    client: "custom",
    discoveredPaths: ["C:/Custom Agents/Auditor/skill library"],
    id: "custom-auditor",
    instance: "Auditor",
    managedDeploymentCount: 5,
    managedDeploymentRelationCount: 7,
    officialReference: "https://acme.example/docs",
    relations: [],
    status: "custom",
  },
  {
    brand: "Acme Robotics",
    client: "custom",
    discoveredPaths: ["D:/Custom Agents/Release Reviewer/global skill directory"],
    id: "custom-reviewer",
    instance: "Release Reviewer",
    managedDeploymentCount: 0,
    managedDeploymentRelationCount: 0,
    officialReference: "https://acme.example/reviewer",
    relations: [],
    status: "custom",
  },
];

function createPreviewAgentFacade(empty: boolean): AgentFacade {
  return {
    list: async () => (empty ? [] : previewAgents),
    get: async (id) => previewAgents.find((agent) => agent.id === id) ?? previewAgents[0]!,
    rescan: async () => undefined,
    createCustomAgent: async () => undefined,
    updateCustomAgent: async () => undefined,
    removeCustomAgent: async () => undefined,
  };
}

const previewPicker = { pickDirectory: async () => "C:/Preview/auditor" };

/** DEV-only detail state: long paths, multiple logical clients, and evidence. */
const previewDetailAgent: AgentView = {
  brand: "Acme Robotics",
  client: "custom",
  discoveredPaths: [
    "C:/Users/preview/AppData/Local/SkillHub/agents/auditor/very/long/global skill directory",
    "/Users/preview/Library/Application Support/SkillHub/agents/auditor/skills",
  ],
  id: "custom-auditor",
  instance: "Auditor",
  managedDeploymentCount: 12,
  managedDeploymentRelationCount: 18,
  officialReference: "https://acme.example/docs",
  relations: [
    { logicalLabel: "Auditor CLI", logicalTargetId: "auditor-cli", physicalPath: "C:/Users/preview/AppData/Local/SkillHub/agents/auditor", physicalTargetId: "auditor-physical" },
    { logicalLabel: "Auditor Desktop", logicalTargetId: "auditor-desktop", physicalPath: "C:/Users/preview/AppData/Local/SkillHub/agents/auditor", physicalTargetId: "auditor-physical" },
  ],
  status: "custom",
};

/** DEV-only agents detail board (/__preview/agents/detail); never in production. */
export function AgentDetailPreview() {
  const facade = useMemo(
    () => ({ ...createPreviewAgentFacade(false), get: async () => previewDetailAgent }),
    [],
  );
  return <AgentDetailPage agentId="custom-auditor" facade={facade} picker={previewPicker} />;
}

/** DEV-only agents board (/__preview/agents); never wired into production. */
export function AgentsPreview() {
  const empty = new URLSearchParams(window.location.search).has("empty");
  const facade = useMemo(() => createPreviewAgentFacade(empty), [empty]);
  return <AgentListPage facade={facade} picker={previewPicker} />;
}
