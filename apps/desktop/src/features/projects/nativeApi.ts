import { executeCommand, queryApplication, type Project } from "../../api/bindings";
import type { ProjectFacade, ProjectRegistration, ProjectView } from "./api";

function projectView(project: Project): ProjectView {
  return {
    assembly: [],
    description: project.logical.note ?? "",
    id: project.id,
    name: project.name,
    sharedConfig: {
      identityHint: project.logical.identity_hint ?? project.device_path,
      requirements: [],
      targetIds: [],
    },
    tags: project.tags.map((tag) => tag.name),
  };
}

async function listProjects(): Promise<ProjectView[]> {
  const result = await queryApplication({ type: "list_projects", payload: null });
  if (result.type !== "projects") throw new Error("list_projects returned an unexpected native result.");
  return result.payload.map(projectView);
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
      if (!(reason && typeof reason === "object" && "code" in reason && reason.code === "object.not_found")) {
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
          created_at: timestamp,
          updated_at: timestamp,
        },
      },
    });
    if (result.type !== "project") throw new Error("register_project returned an unexpected native result.");
    return projectView(result.payload);
  },
};
