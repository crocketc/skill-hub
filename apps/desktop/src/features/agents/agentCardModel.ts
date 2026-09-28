import { normalizeBrandKey } from "../../ui/BrandTag";
import { normalizeAgentKinds, type AgentKindKey } from "../../ui/AgentPresentation";
import type {
  AgentDeploymentStatus,
  AgentDeploymentMode,
  AgentDirectoryRole,
  AgentDirectoryStatus,
  AgentDirectoryView,
  AgentView,
} from "./api";

export interface AgentCardModel {
  id: string;
  brand: string;
  brandLabel: string;
  kinds: AgentKindKey[];
  directories: AgentDirectoryView[];
  sharedDirectory: boolean;
  supportsSharedDirectory: boolean;
  sharedAgentBrands: string[];
  sharedAgentBrandKinds: Record<string, string[]>;
  builtin: boolean;
  readOnly: boolean;
  supportedModes: AgentDeploymentMode[];
  preferredMode?: AgentDeploymentMode;
  deploymentStatus: AgentDeploymentStatus;
  detailTarget: string;
  members: AgentView[];
}

function directoryKey(directory: AgentDirectoryView): string {
  const identity = directory.physicalIdentityVerified && directory.physicalIdentityKey
    ? `physical:${directory.physicalIdentityKey}`
    : `candidate:${directory.candidateIdentityKey ?? (directory.path ?? "待创建").trim().replaceAll("\\", "/").replace(/\/+$/g, "").toLowerCase()}`;
  return `${directory.role}:${directory.builtin ? "builtin" : "normal"}:${identity}`;
}

function fallbackDirectory(agent: AgentView): AgentDirectoryView[] {
  const paths = agent.discoveredPaths.length > 0 ? agent.discoveredPaths : [null];
  const sharedPaths = new Set((agent.sharedReferencePaths ?? []).map((path) => path.trim().replaceAll("\\", "/").toLowerCase()));
  return paths.map((path) => {
    const candidateIdentityKey = path
      ? path.trim().replaceAll("\\", "/").replace(/\/+$/g, "").toLowerCase()
      : agent.id;
    return {
    path,
    status: path ? "existing" : "pending_creation",
    role: agent.builtin ? "builtin" : sharedPaths.has(path?.trim().replaceAll("\\", "/").toLowerCase() ?? "") ? "shared_directory" : "agent_native",
    sharedReference: sharedPaths.has(path?.trim().replaceAll("\\", "/").toLowerCase() ?? ""),
    builtin: Boolean(agent.builtin),
    readable: Boolean(path),
    writable: Boolean(path),
    available: agent.status === "accessible",
    physicalIdentityVerified: false,
    candidateIdentityKey,
    supportedModes: [],
    deploymentStatus: "unknown",
    };
  });
}

function directoriesOf(agent: AgentView): AgentDirectoryView[] {
  return agent.directoryViews && agent.directoryViews.length > 0
    ? agent.directoryViews
    : fallbackDirectory(agent);
}

function mergeDirectories(target: AgentDirectoryView[], incoming: AgentDirectoryView[]): AgentDirectoryView[] {
  const result = [...target];
  for (const directory of incoming) {
    const key = directoryKey(directory);
    const existing = result.find((candidate) => directoryKey(candidate) === key);
    if (!existing) {
      result.push(directory);
      continue;
    }
    existing.supportedModes = [...new Set([...existing.supportedModes, ...directory.supportedModes])];
    existing.preferredMode ??= directory.preferredMode;
    if (existing.status !== "existing" && directory.status === "existing") existing.status = directory.status;
    existing.available ||= directory.available;
    existing.readable ||= directory.readable;
    existing.writable ||= directory.writable;
  }
  return result;
}

function createModel(agent: AgentView, directories: AgentDirectoryView[], members: AgentView[]): AgentCardModel {
  const sharedDirectory = directories.some((directory) => directory.role === "shared_directory")
    || agent.kinds?.includes("shared_directory") === true;
  const supportedModes = [...new Set(directories.flatMap((directory) => directory.supportedModes))];
  const preferredMode = directories.find((directory) => directory.preferredMode)?.preferredMode;
  const status = directories.some((directory) => directory.deploymentStatus === "deployed")
    ? "deployed"
    : directories.some((directory) => directory.deploymentStatus === "partially_deployed")
      ? "partially_deployed"
      : directories.every((directory) => directory.deploymentStatus === "not_deployed")
        ? "not_deployed"
        : "unknown";
  return {
    id: `${normalizeBrandKey(agent.brand)}:${directories.map(directoryKey).sort().join("|")}`,
    brand: agent.brand,
    brandLabel: agent.instance,
    kinds: normalizeAgentKinds(members.flatMap((member) => member.kinds ?? []), agent.client, agent.instance),
    directories,
    sharedDirectory,
    supportsSharedDirectory: members.some((member) => member.supportsSharedDirectory)
      || directories.some((directory) => directory.sharedReference),
    sharedAgentBrands: [...new Set(members.flatMap((member) => member.sharedAgentBrands ?? []))].sort(),
    sharedAgentBrandKinds: mergeSharedBrandKinds(members),
    builtin: directories.every((directory) => directory.builtin),
    readOnly: directories.every((directory) => directory.builtin || !directory.writable),
    supportedModes,
    preferredMode,
    deploymentStatus: status,
    detailTarget: agent.id,
    members,
  };
}

/**
 * Single card projection used by the Agent page and its other entry points.
 * It deliberately keeps user-facing dimensions separate from backend ids and
 * never uses a fallback path as a verified physical identity.
 */
export function buildAgentCardModels(agents: readonly AgentView[]): AgentCardModel[] {
  const models: AgentCardModel[] = [];
  for (const agent of agents) {
    const allDirectories = directoriesOf(agent);
    const nativeDirectories = allDirectories.filter((directory) => !directory.sharedReference);
    const visibleDirectories = nativeDirectories.length > 0 ? nativeDirectories : allDirectories;
    if (agent.kinds?.includes("shared_directory") || allDirectories.some((directory) => directory.role === "shared_directory")) {
      const shared = models.find((model) => model.sharedDirectory && model.directories.some((directory) => visibleDirectories.some((candidate) => directoryKey(candidate) === directoryKey(directory))));
      if (shared) {
        shared.members.push(agent);
        shared.directories = mergeDirectories(shared.directories, visibleDirectories);
        shared.sharedAgentBrands = [...new Set([...shared.sharedAgentBrands, ...(agent.sharedAgentBrands ?? [])])].sort();
        shared.sharedAgentBrandKinds = mergeSharedBrandKinds([...shared.members, agent]);
      } else {
        models.push(createModel(agent, visibleDirectories, [agent]));
      }
      continue;
    }
    for (const directory of visibleDirectories) {
      const key = directoryKey(directory);
      const existing = models.find((model) => !model.sharedDirectory
        && normalizeBrandKey(model.brand) === normalizeBrandKey(agent.brand)
        && model.directories.some((candidate) => directoryKey(candidate) === key));
      if (existing) {
        existing.members.push(agent);
        existing.kinds = normalizeAgentKinds([
          ...existing.kinds,
          ...normalizeAgentKinds(agent.kinds, agent.client, agent.instance),
        ], agent.client, agent.instance);
        existing.directories = mergeDirectories(existing.directories, [directory]);
        existing.supportsSharedDirectory ||= Boolean(agent.supportsSharedDirectory) || directory.sharedReference;
        continue;
      }
      models.push(createModel(agent, [directory], [agent]));
    }
  }
  return models;
}

function mergeSharedBrandKinds(members: readonly AgentView[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const member of members) {
    for (const brand of member.sharedAgentBrands ?? []) {
      result[brand] = [...new Set([
        ...(result[brand] ?? []),
        ...(member.sharedAgentBrandKinds?.[brand] ?? []),
      ])].sort();
    }
  }
  return result;
}

export function directoryStatusLabel(status: AgentDirectoryStatus): string {
  return status;
}

export function directoryRoleLabel(role: AgentDirectoryRole): string {
  return role;
}
