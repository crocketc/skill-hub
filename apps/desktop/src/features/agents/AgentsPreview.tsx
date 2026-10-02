import { useMemo } from "react";
import type { AgentDirectoryMemberFact } from "../../api/bindings";
import { type AgentFacade, type AgentView } from "./api";
import { AgentDetailPage } from "./AgentDetailPage";
import { AgentListPage } from "./AgentListPage";

/**
 * Deterministic DEV-only fixture for /__preview/agents. Covers the layout
 * matrix without touching disk, network, or the Tauri backend: long Windows
 * and macOS paths, pending/unavailable directory facts, and custom agents.
 * Card operations are intentionally exercised through the detail link;
 * `?empty=1` renders the empty state.
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
    brand: "Agent Skills",
    client: "agent-skills.shared",
    discoveredPaths: ["/Users/preview/.agents/skills"],
    directoryViews: [{
      path: "/Users/preview/.agents/skills",
      status: "existing",
      role: "shared_directory",
      sharedReference: true,
      builtin: false,
      readable: true,
      writable: true,
      available: true,
      physicalIdentityVerified: true,
      supportedModes: ["managed_copy", "symbolic_link", "directory_junction"],
      preferredMode: "symbolic_link",
      deploymentStatus: "not_deployed",
    }],
    id: "shared-agents-skills",
    instance: "共享目录",
    managedDeploymentCount: 0,
    managedDeploymentRelationCount: 0,
    officialReference: null,
    relations: [],
    status: "accessible",
    kinds: ["shared_directory"],
    supportsSharedDirectory: true,
    sharedAgentBrands: [
      "OpenAI",
      "Anthropic",
      "Cursor",
      "Google",
      "Kimi",
      "CodeBuddy",
      "Trae",
      "GitHub Copilot",
    ],
    sharedAgentBrandKinds: {
      OpenAI: ["cli"],
      Anthropic: ["cli"],
      Cursor: ["ide_extension"],
      Google: ["cli"],
      Kimi: ["desktop"],
      CodeBuddy: ["cli"],
      Trae: ["ide_extension"],
      "GitHub Copilot": ["cli"],
    },
  },
  {
    brand: "Acme Robotics",
    client: "custom",
    discoveredPaths: ["C:/Custom Agents/Auditor/skill library"],
    id: "custom-auditor",
    directoryViews: [{
      path: "C:/Custom Agents/Auditor/skill library", status: "existing", role: "agent_user",
      sharedReference: false, builtin: false, readable: true, writable: true, available: true,
      physicalIdentityVerified: true, supportedModes: ["managed_copy"], deploymentStatus: "not_deployed",
      importCompatibility: { copy: "supported", symlink: "unsupported", junction: "unsupported" },
    }],
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
    getRelationshipOverview: async () => ({
      scope: { type: "agent", value: { agent_client_id: "custom" } },
      directory_nodes: [
        {
          node_id: "node-shared",
          path: "/Users/preview/.agents/skills",
          path_key: "pk-shared",
          role: "shared_directory",
          profile_id: "agent-skills",
          agent_client_id: null,
          exists: true,
          observed_at: "0",
          scan_source: "preview",
        },
        {
          node_id: "node-native",
          path: "/Users/preview/.auditor/skills",
          path_key: "pk-native",
          role: "agent_native",
          profile_id: "auditor",
          agent_client_id: "preview",
          exists: true,
          observed_at: "0",
          scan_source: "preview",
        },
      ],
      agent_directory_capabilities: [
        {
          agent_client_id: "custom",
          directory_node_id: "node-shared",
          recognition: "supported",
          precedence: "preferred",
          evidence_reference: "https://acme.example/docs",
          researched_at: "2026-09-15",
          applicable_platforms: ["macos"],
        },
        {
          agent_client_id: "custom",
          directory_node_id: "node-native",
          recognition: "unknown",
          precedence: "unknown",
          evidence_reference: null,
          researched_at: null,
          applicable_platforms: [],
        },
        {
          agent_client_id: "trae.code",
          directory_node_id: "node-shared",
          recognition: "supported",
          precedence: "preferred",
          evidence_reference: "fixture",
          researched_at: "2026-09-15",
          applicable_platforms: [],
        },
      ],
      source_relations: [],
      deployment_relations: [
        {
          relation_id: "rel:preview:read",
          skill_id: "skill-pdf",
          agent_client_id: "custom",
          path: "/Users/preview/.agents/skills/pdf",
          path_key: "pk-pdf",
          directory_node_id: "node-shared",
          relationship: "shared_directory_read",
          file_representation: "directory",
          ownership: "shared_reference",
          link_target_path: null,
          link_target_path_key: null,
          link_target_directory_id: null,
          content_fingerprint: "sha256:preview-read",
          origin: "scan",
          match_state: "content_verified",
          active: true,
          observed_at: "0",
          released_at: null,
        },
        {
          relation_id: "rel:preview:copy",
          skill_id: "skill-review",
          agent_client_id: "trae.code",
          path: "/Users/preview/.auditor/skills/review",
          path_key: "pk-review",
          directory_node_id: "node-shared",
          relationship: "managed_copy",
          file_representation: "copy",
          ownership: "skillhub_managed",
          link_target_path: null,
          link_target_path_key: null,
          link_target_directory_id: null,
          content_fingerprint: "sha256:preview-copy",
          origin: "import",
          match_state: "name_only",
          active: true,
          observed_at: "0",
          released_at: null,
        },
      ],
      conflict_cases: [],
      pending_governance_tasks: [],
      agent_execution_confirmed: false,
    }),
    getRelationshipRemovalImpact: async (relationId) => ({
      backup: {
        backup_location: null,
        detail: "preview",
        required: false,
        rollback_available: false,
      },
      current_agent_reads_shared_directory: true,
      governance_tasks: [],
      minimal_action: "remove_current_relation_keep_shared_files",
      other_consumers: [
        {
          agent_client_id: "trae.code",
          directory_node_id: "node-shared",
          recognition: "supported",
          relation_id: null,
        },
      ],
      other_skill_paths: [],
      ownership: "shared_reference",
      permission_limited: false,
      relation: null,
      relation_id: relationId,
    }),
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
  const params = new URLSearchParams(window.location.search);
  const compatibilityScenario = params.get("compatibility") === "1";
  const failCompatibilityWrite = params.get("actionError") === "1";
  const facade = useMemo(
    () => {
      const member: AgentDirectoryMemberFact = {
        logical_target_id: "preview-agent",
        brand: "OpenAI",
        client_id: "openai.codex-desktop",
        kind: "desktop",
        availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
        capabilities: { deployment: { copy: true, symlink: true, junction: true }, modes: ["managed_copy", "symbolic_link", "directory_junction"], preferred_mode: "directory_junction" },
        deployment_status: "deployed",
        managed_deployment_relation_count: 1,
        managed_deployment_count: 1,
      };
      return {
        ...createPreviewAgentFacade(false),
        get: async () => compatibilityScenario ? { ...previewDetailAgent, directoryMembers: [member] } : previewDetailAgent,
        ...(compatibilityScenario ? {
          recordCompatibility: async () => {
            if (failCompatibilityWrite) throw new Error("library.locked: preview write failure");
            window.sessionStorage.setItem("preview-agent-compatibility-verified", "1");
          },
        } : {}),
      };
    },
    [compatibilityScenario, failCompatibilityWrite],
  );
  return <AgentDetailPage agentId="custom-auditor" facade={facade} picker={previewPicker} />;
}

/** DEV-only agents board (/__preview/agents); never wired into production. */
export function AgentsPreview() {
  const empty = new URLSearchParams(window.location.search).has("empty");
  const facade = useMemo(() => createPreviewAgentFacade(empty), [empty]);
  return <AgentListPage facade={facade} picker={previewPicker} />;
}
