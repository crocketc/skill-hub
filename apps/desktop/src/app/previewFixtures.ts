import type { BootstrapSnapshot } from "../api/bindings";
import type {
  AgentFacade,
  AgentView,
} from "../features/agents/api";
import { agentFixture } from "../features/agents/api";
import type {
  BootstrapRuntime,
  OnboardingOperations,
} from "../features/bootstrap/api";
import type {
  DeploymentFacade,
  DeploymentPlan,
  DeploymentResult,
} from "../features/deployment/api";
import { deploymentTargetsFixture } from "../features/deployment/api";
import type {
  ImportFacade,
} from "../features/import/api";
import { createMockImportFacade } from "../features/import/api";
import type {
  OperationFacade,
  OperationState,
} from "../features/operations/api";
import type {
  PendingFacade,
  PendingItem,
} from "../features/pending/api";
import type {
  ProjectFacade,
  ProjectView,
} from "../features/projects/api";
import { projectFixture } from "../features/projects/api";
import type { RemovalImpact } from "../features/removal/api";
import type {
  SecurityCheck,
  SecurityFacade,
  SecurityFinding,
} from "../features/security/api";
import { separateCheckFixture } from "../features/security/api";
import {
  settingsFixture,
  type SettingsCommand,
  type SettingsFacade,
  type SettingsSnapshot,
} from "../features/settings/api";

export const previewBootstrapSnapshot: BootstrapSnapshot = {
  agent_count: 4,
  deployed_count: 12,
  deployment_categories: [
    { dimension: "agent", key: "openai-codex", label_code: "Codex CLI", count: 5 },
    { dimension: "agent", key: "claude-code", label_code: "Claude Code", count: 4 },
    { dimension: "agent", key: "gemini-cli", label_code: "Gemini CLI", count: 3 },
    { dimension: "project", key: "demo-project", label_code: "Demo Project", count: 7 },
    { dimension: "project", key: "docs-project", label_code: "Docs Project", count: 5 },
  ],
  last_scan_at: "2026-08-28T08:30:00Z",
  pending: { by_kind: { security_finding: 1, recovery: 1, trial_due: 1 }, total: 3 },
  project_count: 6,
  recent_operations: [],
  recovery_state: "clean",
  skill_count: 80,
};

export function createPreviewAgentFacade(): AgentFacade {
  const agent = agentFixture();
  const entries: AgentView[] = [
    agent,
    { ...agent, id: "anthropic-claude", brand: "Anthropic", client: "Claude family", instance: "Claude Code", discoveredPaths: ["C:/Users/demo/.claude/skills"] },
    { ...agent, id: "google-gemini", brand: "Google", client: "Gemini family", instance: "Gemini CLI", discoveredPaths: ["C:/Users/demo/.gemini/skills"] },
    { ...agent, id: "xai-grok", brand: "xAI", client: "Grok family", instance: "Grok", discoveredPaths: ["C:/Users/demo/.grok/skills"] },
  ];
  return {
    list: async () => structuredClone(entries),
    get: async (id) => structuredClone(entries.find((entry) => entry.id === id) ?? entries[0]),
  };
}

export function createPreviewProjectFacade(): ProjectFacade {
  const demo = projectFixture();
  const entries: ProjectView[] = [
    demo,
    { ...demo, id: "docs-project", name: "Docs Project", description: "文档处理和发布工作流", tags: ["文档", "演示"] },
    { ...demo, id: "ops-project", name: "Operations", description: "本地运维自动化项目", tags: ["Rust", "运维"] },
  ];
  return {
    list: async () => structuredClone(entries),
    get: async (id) => structuredClone(entries.find((entry) => entry.id === id) ?? entries[0]),
  };
}

export function createPreviewDeploymentFacade(): DeploymentFacade {
  const targets = deploymentTargetsFixture();
  return {
    listTargets: async () => structuredClone(targets),
    preview: async (selected) => ({
      skillId: "skill-pdf",
      versionId: "v1.4.0",
      targets: selected.map((target) => ({ targetId: target.id, label: target.label, mode: target.modes[0] ?? "managed_copy", warnings: target.id === "claude-code" ? ["目标目录存在旧版本，将保留原目录备份"] : [] })),
      warnings: selected.length > 1 ? ["批量部署将逐个目标执行并分别报告结果"] : [],
    } satisfies DeploymentPlan),
    commit: async (plan) => plan.targets.map<DeploymentResult>((target) => ({ targetId: target.targetId, label: target.label, status: "succeeded", message: "已创建部署关系" })),
  };
}

export function createPreviewSecurityFacade(): SecurityFacade {
  const fixture = separateCheckFixture();
  let findings = structuredClone(fixture.findings);
  return {
    getChecks: async () => structuredClone(fixture.checks) as SecurityCheck[],
    listFindings: async () => structuredClone(findings) as SecurityFinding[],
    setFindingDisposition: async (findingId, disposition) => {
      findings = findings.map((finding) => finding.id === findingId ? { ...finding, disposition } : finding);
    },
  };
}

const previewPendingItems: PendingItem[] = [
  { id: "pending-trial", subject: "Browser Automation", kind: "trial_due", message: "试用标签已存在，请转正或移除。" },
  { id: "pending-security", subject: "PDF Reader", kind: "security_finding", message: "基础检查发现疑似凭据字符串。" },
  { id: "pending-recovery", subject: "批量部署操作", kind: "recovery", message: "一个目标需要恢复。" },
];

export function createPreviewPendingFacade(): PendingFacade {
  let items = structuredClone(previewPendingItems);
  const remove = (item: PendingItem) => { items = items.filter((candidate) => candidate.id !== item.id); };
  return {
    list: async () => structuredClone(items),
    resolve: async (item) => remove(item),
    recheck: async (item) => remove(item),
    convert: async (item) => remove(item),
    remove: async (item) => remove(item),
    recover: async (item) => remove(item),
  };
}

const previewOperation: OperationState = { operationId: "op-preview-42", phase: "verifying", completed: 2, total: 3, message: "正在核对 3 个部署目标，已完成 2 个。" };

export function createPreviewOperationFacade(): OperationFacade {
  let operation = structuredClone(previewOperation);
  return {
    get: async () => structuredClone(operation),
    acknowledgeRecovery: async () => { operation = { ...operation, phase: "rolled_back", message: "已完成恢复并保留集中库 Skill。" }; },
  };
}

export function createPreviewSettingsFacade(): SettingsFacade {
  let settings: SettingsSnapshot = settingsFixture();
  return {
    get: async () => structuredClone(settings),
    execute: async (command: SettingsCommand) => {
      if (command.type === "set_network_enabled") settings = { ...settings, network: { ...settings.network, networkEnabled: command.payload.enabled } };
    },
  };
}

export const previewRemovalImpact: RemovalImpact = {
  dependentProjects: ["Demo Project"],
  deployments: [
    { id: "remove-codex", label: "Codex CLI", path: "C:/Users/demo/.codex/skills/pdf-reader", physicalId: "codex-skills" },
    { id: "remove-claude", label: "Claude Code", path: "C:/Users/demo/.claude/skills/pdf-reader", physicalId: "claude-skills" },
  ],
  skillId: "skill-pdf",
  skillName: "PDF Reader",
};

export function createPreviewImportFacade(): ImportFacade {
  return createMockImportFacade({ scenario: "agent-owned-partial" });
}

export const previewOnboardingOperations: OnboardingOperations = {
  completeOnboarding: async () => undefined,
  discoverAgents: async () => ({ targets: [
    { id: "codex-cli", label: "Codex CLI", availability: "available" },
    { id: "claude-code", label: "Claude Code", availability: "available" },
    { id: "gemini-cli", label: "Gemini CLI", availability: "unavailable" },
  ] }),
};

export const previewBootstrapRuntime: BootstrapRuntime = {
  getBootstrapView: async () => ({ snapshot: previewBootstrapSnapshot, verification: { kind: "unavailable" } }),
  runInitializationScan: async () => ({ kind: "in_progress", operationId: "op-scan-preview", phase: "verifying" }),
};
