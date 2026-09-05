import {
  executeCommand,
  queryApplication,
  type AgentClient,
  type AgentProfile,
  type CustomAgent,
  type CustomAgentDraft,
  type DeploymentRecord,
  type DiscoverySnapshot,
  type LogicalTarget,
  type OperatingSystem,
} from "../../api/bindings";
import type { AgentFacade, AgentRelation, AgentStatus, AgentView, CustomAgentFormValues } from "./api";

function unexpectedResult(operation: string): Error {
  return new Error(`${operation} returned an unexpected native result.`);
}

function relationOf(target: LogicalTarget, snapshot: DiscoverySnapshot): AgentRelation {
  const physical = snapshot.physical_targets.find((candidate) => candidate.id === target.physical_id);
  return {
    logicalLabel: target.id,
    logicalTargetId: target.id,
    physicalPath: physical?.path ?? target.path,
    physicalTargetId: target.physical_id,
  };
}

function managedDeploymentStats(targetIds: string[], deployments: DeploymentRecord[]): {
  relations: number;
  skills: number;
} {
  const active = deployments.filter(
    (deployment) => deployment.managed && deployment.state !== "removed" && targetIds.includes(deployment.target_id),
  );
  return {
    relations: active.length,
    skills: new Set(active.map((deployment) => deployment.skill_id)).size,
  };
}

function discoveredStatus(targets: LogicalTarget[]): AgentStatus {
  if (!targets.length) return "directory_only";
  return targets.some((target) => target.available) ? "accessible" : "inaccessible";
}

function discoveredAgents(snapshot: DiscoverySnapshot, deployments: DeploymentRecord[]): AgentView[] {
  return snapshot.instances.map((instance) => {
    const targets = snapshot.logical_targets.filter(
      (target) => target.profile_id === instance.profile_id && target.client_id === instance.client_id,
    );
    const stats = managedDeploymentStats(targets.map((target) => target.id), deployments);
    return {
      id: `${instance.profile_id}.${instance.client_id}`,
      brand: instance.profile_id,
      client: instance.client_id,
      instance: instance.client_id,
      managedDeploymentCount: stats.skills,
      managedDeploymentRelationCount: stats.relations,
      discoveredPaths: [...new Set(targets.map((target) => target.path))],
      officialReference: null,
      relations: targets.map((target) => relationOf(target, snapshot)),
      status: discoveredStatus(targets),
    };
  });
}

function customAgent(agent: CustomAgent, deployments: DeploymentRecord[]): AgentView {
  const client = agent.profile.clients[0]?.id ?? "custom";
  const stats = managedDeploymentStats([agent.id], deployments);
  return {
    id: agent.id,
    brand: agent.profile.brand,
    client,
    instance: agent.display_name,
    managedDeploymentCount: stats.skills,
    managedDeploymentRelationCount: stats.relations,
    discoveredPaths: [agent.directory.path],
    officialReference: agent.profile.official_references[0] ?? null,
    relations: [{
      logicalLabel: agent.display_name,
      logicalTargetId: agent.id,
      physicalPath: agent.directory.path,
      physicalTargetId: agent.directory.grant_id,
    }],
    status: "custom",
  };
}

async function listAgents(): Promise<AgentView[]> {
  const [discovery, custom, deployments] = await Promise.all([
    queryApplication({ type: "get_discovery_snapshot", payload: null }),
    queryApplication({ type: "list_custom_agents", payload: null }),
    queryApplication({ type: "list_deployments", payload: { skill_id: null } }),
  ]);
  if (discovery.type !== "discovery_snapshot") throw unexpectedResult("get_discovery_snapshot");
  if (custom.type !== "custom_agents") throw unexpectedResult("list_custom_agents");
  if (deployments.type !== "deployments") throw unexpectedResult("list_deployments");
  return [
    ...discoveredAgents(discovery.payload, deployments.payload),
    ...custom.payload.map((agent) => customAgent(agent, deployments.payload)),
  ];
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "agent";
}

function currentOperatingSystem(): OperatingSystem {
  return /mac/i.test(globalThis.navigator?.userAgent ?? "") ? "macos" : "windows";
}

/**
 * Builds the native draft for a custom agent. The directory grant id carries
 * the identifier issued by the desktop file picker (its canonical path); the
 * host must register that grant before the command can resolve it.
 */
function customAgentDraft(id: string, values: CustomAgentFormValues): CustomAgentDraft {
  const client: AgentClient = {
    id: `${id}-client`,
    kind: "cli",
    supported_os: [currentOperatingSystem()],
    path_candidates: [{
      path: values.directoryPath,
      scope: "global",
      precedence: "preferred",
      marker: "SKILL.md",
    }],
    skill_marker: "SKILL.md",
    deployment: { copy: true, symlink: true, junction: true },
    call_policy: "unknown",
  };
  const profile: AgentProfile = {
    profile_version: 1,
    research_date: new Date().toISOString().slice(0, 10),
    official_references: [values.referenceUrl],
    brand: values.brand,
    clients: [client],
  };
  return {
    id,
    display_name: values.displayName,
    directory: { grant_id: values.directoryPath },
    profile,
  };
}

async function saveCustomAgent(command: "create_custom_agent" | "update_custom_agent", id: string, values: CustomAgentFormValues): Promise<void> {
  const result = await executeCommand({ type: command, payload: { agent: customAgentDraft(id, values) } });
  if (result.type !== "custom_agent") throw unexpectedResult(command);
}

export const nativeAgentFacade: AgentFacade = {
  list: listAgents,
  async get(id) {
    const agent = (await listAgents()).find((candidate) => candidate.id === id);
    if (!agent) throw new Error(`Agent ${id} was not found.`);
    return agent;
  },
  async rescan() {
    const result = await executeCommand({ type: "discover_agent_targets", payload: null });
    if (result.type !== "discovery_snapshot") throw unexpectedResult("discover_agent_targets");
  },
  async createCustomAgent(values) {
    const id = `custom-${slugify(values.displayName)}`;
    await saveCustomAgent("create_custom_agent", id, values);
  },
  async updateCustomAgent(id, values) {
    await saveCustomAgent("update_custom_agent", id, values);
  },
  async removeCustomAgent(id) {
    const result = await executeCommand({ type: "remove_custom_agent", payload: { id } });
    if (result.type !== "operation_summary") throw unexpectedResult("remove_custom_agent");
  },
};
