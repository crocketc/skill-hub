import { normalizeBrandKey } from "../../ui/BrandTag";
import { normalizeAgentKinds, type AgentKindKey } from "../../ui/AgentPresentation";
import type {
  AgentDirectoryFact,
  AgentDirectoryMemberFact,
  AgentDirectoryProjection,
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
  /** Raw per-target facts used to expand a selected directory into operations. */
  directoryMembers?: AgentDirectoryMemberFact[];
}

function projectedStatus(status: AgentDirectoryFact["status"]): AgentDirectoryView["status"] {
  return status === "missing" ? "pending_creation" : status;
}

function projectedDeploymentStatus(members: readonly AgentDirectoryMemberFact[]): AgentDeploymentStatus {
  if (members.some((member) => member.deployment_status === "deployed")) return "deployed";
  if (members.some((member) => member.deployment_status === "partially_deployed")) return "partially_deployed";
  return members.length > 0 && members.every((member) => member.deployment_status === "not_deployed")
    ? "not_deployed"
    : "unknown";
}

function projectedMemberView(directory: AgentDirectoryFact, member: AgentDirectoryMemberFact): AgentView {
  const brand = member.brand ?? "Agent Skills";
  const displayName = member.brand ?? "共享目录";
  return {
    id: member.logical_target_id,
    brand,
    client: member.client_id ?? "shared-directory",
    instance: displayName,
    discoveredPaths: directory.exists ? [directory.path] : [],
    managedDeploymentCount: member.managed_deployment_count,
    managedDeploymentRelationCount: member.managed_deployment_relation_count,
    officialReference: null,
    relations: [{
      logicalLabel: displayName,
      logicalTargetId: member.logical_target_id,
      physicalPath: directory.path,
      physicalTargetId: directory.identity.kind === "verified_physical" ? directory.identity.value : "",
    }],
    status: member.availability.available ? "accessible" : "inaccessible",
    kinds: member.kind ? [member.kind] : undefined,
    directoryMembers: [member],
    deploymentStatus: member.deployment_status,
  };
}

function supportedModesForMembers(members: readonly AgentDirectoryMemberFact[]): AgentDeploymentMode[] {
  const selectable = members.filter((member) => member.availability.exists && member.availability.available);
  if (selectable.length === 0) return [];
  return selectable[0].capabilities.modes.filter((mode) =>
    selectable.every((member) => member.capabilities.modes.includes(mode)),
  ) as AgentDeploymentMode[];
}

function projectedDirectoryView(directory: AgentDirectoryFact): AgentDirectoryView {
  const verified = directory.identity.kind === "verified_physical";
  const candidate = directory.identity.kind === "candidate";
  return {
    path: directory.exists ? directory.path : null,
    status: projectedStatus(directory.status),
    role: directory.role,
    sharedReference: directory.role === "shared_directory",
    builtin: directory.role === "builtin",
    readable: directory.readable,
    writable: directory.writable,
    available: directory.available,
    physicalIdentityVerified: verified,
    physicalIdentityKey: verified ? directory.identity.value : undefined,
    candidateIdentityKey: candidate ? directory.identity.value : undefined,
    supportedModes: supportedModesForMembers(directory.members),
    preferredMode: directory.members.length > 0
      && directory.members.every((member) => member.capabilities.preferred_mode === directory.members[0].capabilities.preferred_mode)
      ? directory.members[0].capabilities.preferred_mode ?? undefined
      : undefined,
    deploymentStatus: projectedDeploymentStatus(directory.members),
  };
}

/**
 * Converts the generated directory projection into the compatibility AgentView
 * shape. Internal target identifiers stay in data fields and are never used as
 * presentation labels.
 */
export function agentDirectoryProjectionToAgentViews(projection: AgentDirectoryProjection): AgentView[] {
  return projection.directories.map((directory) => {
    const members = directory.members.map((member) => projectedMemberView(directory, member));
    const shared = directory.role === "shared_directory";
    const brand = shared ? "Agent Skills" : directory.members.find((member) => member.brand)?.brand ?? "Agent";
    const identity = directory.identity.kind === "verified_physical"
      ? `physical:${directory.identity.value}`
      : `candidate:${directory.identity.value}`;
    const kinds = shared
      ? ["shared_directory" as const]
      : [...new Set(directory.members.flatMap((member) => member.kind ? [member.kind] : []))];
    const representative = members[0];
    return {
      ...(representative ?? {
        id: identity,
        brand,
        client: "unknown",
        instance: shared ? "共享目录" : brand,
        discoveredPaths: directory.exists ? [directory.path] : [],
        managedDeploymentCount: 0,
        managedDeploymentRelationCount: 0,
        officialReference: null,
        relations: [],
        status: directory.available ? "accessible" as const : "inaccessible" as const,
      }),
      id: representative?.id ?? identity,
      brand,
      instance: shared ? "共享目录" : representative?.instance ?? brand,
      kinds,
      discoveredPaths: directory.exists ? [directory.path] : [],
      relations: directory.members.map((member) => ({
        logicalLabel: member.brand ?? "共享目录",
        logicalTargetId: member.logical_target_id,
        physicalPath: directory.path,
        physicalTargetId: directory.identity.kind === "verified_physical" ? directory.identity.value : "",
      })),
      directoryViews: [projectedDirectoryView(directory)],
      directoryMembers: directory.members,
      deploymentStatus: projectedDeploymentStatus(directory.members),
      builtin: directory.role === "builtin" || undefined,
      supportsSharedDirectory: directory.role === "shared_directory",
      sharedAgentBrands: shared ? recognizedSharedBrands(directory.members) : undefined,
      sharedAgentBrandKinds: shared ? sharedBrandKindsFromFacts(directory.members) : undefined,
    };
  });
}

function sharedBrandKindsFromFacts(members: readonly AgentDirectoryMemberFact[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const member of members) {
    if (!member.brand || normalizeBrandKey(member.brand) === "agent-skills" || !member.kind) continue;
    result[member.brand] = [...new Set([...(result[member.brand] ?? []), member.kind])].sort();
  }
  return result;
}

function recognizedSharedBrands(members: readonly AgentDirectoryMemberFact[]): string[] {
  return [...new Set(members.flatMap((member) =>
    member.brand && normalizeBrandKey(member.brand) !== "agent-skills" ? [member.brand] : [],
  ))].sort();
}

/** Additive canonical card builder for the generated directory projection. */
export function buildAgentDirectoryCardModels(projection: AgentDirectoryProjection): AgentCardModel[] {
  return projection.directories.map((directory) => {
    const directoryView = projectedDirectoryView(directory);
    const members = directory.members.map((member) => projectedMemberView(directory, member));
    const shared = directory.role === "shared_directory";
    const brands = shared
      ? recognizedSharedBrands(directory.members)
      : [];
    const kinds = shared
      ? ["shared_directory" as const]
      : normalizeAgentKinds(directory.members.flatMap((member) => member.kind ? [member.kind] : []));
    const identityKey = directory.identity.kind === "verified_physical"
      ? `physical:${directory.identity.value}`
      : `candidate:${directory.identity.value}`;
    const supportedModes = supportedModesForMembers(directory.members);
    const preferredMode = directory.members.length > 0
      && directory.members.every((member) => member.capabilities.preferred_mode === directory.members[0].capabilities.preferred_mode)
      ? directory.members[0].capabilities.preferred_mode ?? undefined
      : undefined;
    return {
      id: `${directory.role}:${identityKey}`,
      brand: shared ? "Agent Skills" : directory.members.find((member) => member.brand)?.brand ?? "Agent",
      brandLabel: shared ? "共享目录" : directory.members.find((member) => member.brand)?.brand ?? "Agent",
      kinds,
      directories: [directoryView],
      sharedDirectory: shared,
      supportsSharedDirectory: shared,
      sharedAgentBrands: brands,
      sharedAgentBrandKinds: shared ? sharedBrandKindsFromFacts(directory.members) : {},
      builtin: directory.role === "builtin",
      readOnly: directory.role === "builtin" || !directory.writable,
      supportedModes,
      preferredMode,
      deploymentStatus: projectedDeploymentStatus(directory.members),
      detailTarget: members[0]?.id ?? identityKey,
      members,
      directoryMembers: directory.members,
    };
  });
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
