import { executeCommand, queryApplication, type Project } from "../../api/bindings";
import type { ProjectAgentCandidate, ProjectFacade, ProjectPhysicalTargetView, ProjectRegistration, ProjectView } from "./api";

function isNotFoundError(reason: unknown): boolean {
  return Boolean(reason && typeof reason === "object" && "code" in reason && reason.code === "object.not_found");
}

function projectView(project: Project): ProjectView {
  return {
    agentIds: project.agent_ids ?? [],
    assembly: [],
    description: project.logical.note ?? "",
    devicePath: project.device_path,
    id: project.id,
    name: project.name,
    physicalId: project.physical_id,
    sharedConfig: {
      identityHint: project.logical.identity_hint ?? project.device_path,
      requirements: [],
      targetIds: [],
    },
    tags: project.tags.map((tag) => tag.name),
  };
}

async function listRawProjects(): Promise<Project[]> {
  const result = await queryApplication({ type: "list_projects", payload: null });
  if (result.type !== "projects") throw new Error("list_projects returned an unexpected native result.");
  return result.payload;
}

async function listProjects(): Promise<ProjectView[]> {
  return (await listRawProjects()).map(projectView);
}

export const nativeProjectFacade: ProjectFacade = {
  list: listProjects,
  async get(id) {
    const project = (await listProjects()).find((candidate) => candidate.id === id);
    if (!project) throw new Error(`Project ${id} was not found.`);
    try {
      const result = await executeCommand({ type: "read_shared_project_config", payload: { project_id: id } });
      if (result.type !== "shared_project_config") {
        throw new Error("read_shared_project_config returned an unexpected native result.");
      }
      project.sharedConfig = {
        identityHint: result.payload.project_identity_hint,
        requirements: result.payload.required_skills.map((requirement) => requirement.name),
        targetIds: [...new Set(result.payload.required_skills.flatMap(
          (requirement) => requirement.logical_agent_id ? [requirement.logical_agent_id] : [],
        ))],
      };
    } catch (reason) {
      if (!isNotFoundError(reason)) {
        throw reason;
      }
    }
    return project;
  },
  async register(input: ProjectRegistration) {
    const timestamp = new Date().toISOString();
    const result = await executeCommand({
      type: "register_project",
      payload: {
        project: {
          id: input.id,
          name: input.name,
          device_path: input.path,
          physical_id: "",
          logical: { identity_hint: null, note: null },
          tags: input.tags.map((name) => ({ name })),
          agent_ids: input.agentIds,
          created_at: timestamp,
          updated_at: timestamp,
        },
      },
    });
    if (result.type !== "project") throw new Error("register_project returned an unexpected native result.");
    return projectView(result.payload);
  },
  async updateAgentIds(id, agentIds) {
    const project = (await listRawProjects()).find((candidate) => candidate.id === id);
    if (!project) throw new Error(`Project ${id} was not found.`);
    const result = await executeCommand({
      type: "update_project",
      payload: { project: { ...project, agent_ids: agentIds, updated_at: new Date().toISOString() } },
    });
    if (result.type !== "project") throw new Error("update_project returned an unexpected native result.");
    return projectView(result.payload);
  },
  async listAgentCandidates(): Promise<ProjectAgentCandidate[]> {
    const result = await queryApplication({ type: "get_discovery_snapshot", payload: null });
    if (result.type !== "discovery_snapshot") throw new Error("get_discovery_snapshot returned an unexpected native result.");
    return result.payload.logical_targets.map((target) => ({
      id: target.id,
      label: `${target.profile_id} · ${target.client_id}`,
      available: target.available,
    }));
  },
  async previewDirectory(path) {
    const result = await queryApplication({
      type: "preview_project_directory",
      payload: { path },
    });
    if (result.type !== "project_directory_preview") {
      throw new Error("preview_project_directory returned an unexpected native result.");
    }
    return {
      path: result.payload.path,
      agentTraces: result.payload.agent_traces.map((trace) => ({
        targetId: trace.id,
        label: `${trace.profile_id} · ${trace.client_id}`,
        path: trace.path,
        marker: trace.marker,
        available: trace.available,
      })),
      skillCandidates: result.payload.skill_candidates.map((candidate) => ({
        name: candidate.runtime_name,
        path: candidate.absolute_root,
      })),
    };
  },
  async getAssemblyPlan(projectId) {
    let result: Awaited<ReturnType<typeof queryApplication>>;
    try {
      result = await queryApplication({
        type: "get_project_assembly_plan",
        payload: { project_id: projectId },
      });
    } catch (reason) {
      if (isNotFoundError(reason)) return null;
      throw reason;
    }
    if (result.type !== "assembly_plan") {
      throw new Error("get_project_assembly_plan returned an unexpected native result.");
    }
    return {
      items: result.payload.items.map((item) => ({
        name: item.requirement.name,
        reasons: item.reasons,
        skillId: item.requirement.skill_id,
        status: item.status,
      })),
    };
  },
  async listPhysicalTargets(): Promise<ProjectPhysicalTargetView[]> {
    const result = await queryApplication({ type: "get_discovery_snapshot", payload: null });
    if (result.type !== "discovery_snapshot") {
      throw new Error("get_discovery_snapshot returned an unexpected native result.");
    }
    return result.payload.physical_targets.map((target) => ({
      exists: target.exists,
      id: target.id,
      path: target.path,
      readable: target.readable,
      writable: target.writable,
    }));
  },
};
