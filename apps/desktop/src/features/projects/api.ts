import type { AssemblyItemStatus } from "../../api/bindings";

export type ProjectAssemblyStatus = "satisfied" | "skipped" | "conflict" | "failed";

export interface ProjectAssemblyItem {
  message: string;
  skillId: string;
  skillName: string;
  status: ProjectAssemblyStatus;
}

export interface ProjectSharedConfig {
  identityHint: string;
  requirements: string[];
  targetIds: string[];
}

export interface ProjectView {
  agentIds: string[];
  assembly: ProjectAssemblyItem[];
  description: string;
  devicePath: string;
  id: string;
  name: string;
  physicalId: string;
  sharedConfig: ProjectSharedConfig;
  tags: string[];
}

export interface ProjectRegistration {
  agentIds: string[];
  id: string;
  name: string;
  path: string;
  tags: string[];
}

export interface ProjectAgentCandidate { id: string; label: string; available: boolean; }

export interface ProjectAgentTrace {
  available: boolean;
  label: string;
  marker: string;
  path: string;
  targetId: string;
}

export interface ProjectSkillCandidatePreview {
  name: string;
  path: string;
}

/** Read-only facts about a chosen directory, gathered before registration. */
export interface ProjectDirectoryPreview {
  agentTraces: ProjectAgentTrace[];
  path: string;
  skillCandidates: ProjectSkillCandidatePreview[];
}

export interface ProjectPhysicalTargetView {
  exists: boolean;
  id: string;
  path: string;
  readable: boolean;
  writable: boolean;
}

export type ProjectAssemblyPlanStatus = AssemblyItemStatus;

export interface ProjectAssemblyPlanItemView {
  name: string;
  reasons: string[];
  skillId: string;
  status: ProjectAssemblyPlanStatus;
}

export interface ProjectAssemblyPlanView {
  items: ProjectAssemblyPlanItemView[];
}

export type ProjectAccessState = "accessible" | "inaccessible" | "read_only" | "untracked";

export interface ProjectFacade {
  list(): Promise<ProjectView[]>;
  get(id: string): Promise<ProjectView>;
  register(input: ProjectRegistration): Promise<ProjectView>;
  updateAgentIds(projectId: string, agentIds: string[]): Promise<ProjectView>;
  listAgentCandidates(): Promise<ProjectAgentCandidate[]>;
  previewDirectory(path: string): Promise<ProjectDirectoryPreview>;
  getAssemblyPlan(projectId: string): Promise<ProjectAssemblyPlanView | null>;
  listPhysicalTargets(): Promise<ProjectPhysicalTargetView[]>;
}

function unavailable(operation: string): Promise<never> {
  return Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
}

export const unavailableProjectFacade: ProjectFacade = {
  get: () => unavailable("project_get"),
  list: () => unavailable("project_list"),
  register: () => unavailable("project_register"),
  updateAgentIds: () => unavailable("project_update_agent_ids"),
  listAgentCandidates: () => unavailable("project_agent_candidates"),
  previewDirectory: () => unavailable("project_preview_directory"),
  getAssemblyPlan: () => unavailable("project_assembly_plan"),
  listPhysicalTargets: () => unavailable("project_physical_targets"),
};

export function projectFixture(): ProjectView {
  return {
    agentIds: [],
    assembly: [
      { message: "已满足项目要求", skillId: "pdf-reader", skillName: "PDF Reader", status: "satisfied" },
      { message: "项目选择跳过此 Skill", skillId: "browser-helper", skillName: "Browser Helper", status: "skipped" },
      { message: "需要确认目标目录冲突", skillId: "release-notes", skillName: "Release Notes", status: "conflict" },
      { message: "读取来源失败", skillId: "api-review", skillName: "API Review", status: "failed" },
    ],
    description: "用于验证项目级 Skill 组合的示例项目",
    devicePath: "D:/Work/demo",
    id: "demo-project",
    name: "Demo Project",
    physicalId: "fs:demo-project",
    sharedConfig: {
      identityHint: "C:/Projects/demo",
      requirements: ["Rust", "文档审阅"],
      targetIds: ["codex-cli", "claude-code"],
    },
    tags: ["客户项目", "Rust", "演示"],
  };
}

/** Access state of the registered project directory on this device. */
export function resolveProjectAccessState(
  physicalId: string,
  targets: ProjectPhysicalTargetView[],
): ProjectAccessState {
  const target = targets.find((candidate) => candidate.id === physicalId);
  if (!target) return "untracked";
  if (!target.exists || !target.readable) return "inaccessible";
  if (!target.writable) return "read_only";
  return "accessible";
}

export interface ProjectAssemblyGroup {
  items: ProjectAssemblyPlanItemView[];
  status: ProjectAssemblyPlanStatus;
}

const assemblyGroupOrder: ProjectAssemblyPlanStatus[] = [
  "already_satisfied",
  "succeeded",
  "ready_to_acquire",
  "conflict_needs_choice",
  "skipped",
  "failed",
];

/** Groups plan items by status so the detail page can show per-state buckets. */
export function groupAssemblyItems(items: ProjectAssemblyPlanItemView[]): ProjectAssemblyGroup[] {
  return assemblyGroupOrder
    .map((status) => ({ items: items.filter((item) => item.status === status), status }))
    .filter((group) => group.items.length > 0);
}

function toComparablePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** True when `candidate` is the trace path itself or lives inside it. */
function isInsideTracePath(candidate: string, tracePath: string): boolean {
  const normalizedCandidate = toComparablePath(candidate);
  const normalizedTrace = toComparablePath(tracePath);
  if (!normalizedTrace) return false;
  const tracePrefix = normalizedTrace.endsWith("/") ? normalizedTrace : `${normalizedTrace}/`;
  return normalizedCandidate === normalizedTrace || normalizedCandidate.startsWith(tracePrefix);
}

function rootSegment(path: string): string {
  return toComparablePath(path).split("/").filter(Boolean)[0] ?? "";
}

export type SkillCandidateAffinity = 0 | 1 | 2;

/**
 * Front-end only ordering for preview candidates: 0 = inside a traced Agent
 * directory, 1 = same root segment as a traced directory, 2 = no relation.
 */
export function skillCandidateAffinity(
  candidatePath: string,
  tracePaths: string[],
): SkillCandidateAffinity {
  for (const tracePath of tracePaths) {
    if (isInsideTracePath(candidatePath, tracePath)) return 0;
  }
  const candidateRoot = rootSegment(candidatePath);
  if (candidateRoot && tracePaths.some((tracePath) => rootSegment(tracePath) === candidateRoot)) return 1;
  return 2;
}

/** Sorts preview candidates by Agent trace affinity without mutating the input. */
export function sortSkillCandidatesByTraceAffinity(
  candidates: ProjectSkillCandidatePreview[],
  traces: ProjectAgentTrace[],
): ProjectSkillCandidatePreview[] {
  const tracePaths = traces.map((trace) => trace.path).filter((path) => path.length > 0);
  return candidates
    .map((candidate, index) => ({ candidate, index, rank: skillCandidateAffinity(candidate.path, tracePaths) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.candidate);
}
