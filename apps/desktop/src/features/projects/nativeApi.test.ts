import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { nativeProjectFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({ executeCommand: vi.fn(), queryApplication: vi.fn() }));

const query = vi.mocked(queryApplication);
const execute = vi.mocked(executeCommand);

beforeEach(() => { query.mockReset(); execute.mockReset(); });

it("maps registered project facts and does not invent assembly results", async () => {
  query.mockResolvedValue({
    type: "projects",
    payload: [{
      id: "project-aurora",
      name: "Aurora",
      device_path: "D:/Work/Aurora",
      physical_id: "physical-project",
      logical: { identity_hint: "github.com/acme/aurora", note: "Release workspace" },
      tags: [{ name: "Rust" }, { name: "Desktop" }],
      created_at: "2026-09-02T00:00:00Z",
      updated_at: "2026-09-02T00:00:00Z",
    }],
  });

  await expect(nativeProjectFacade.list()).resolves.toEqual([{
    agentIds: [],
    assembly: [],
    description: "Release workspace",
    devicePath: "D:/Work/Aurora",
    id: "project-aurora",
    name: "Aurora",
    physicalId: "physical-project",
    sharedConfig: {
      identityHint: "github.com/acme/aurora",
      requirements: [],
      targetIds: [],
    },
    tags: ["Rust", "Desktop"],
  }]);
});

it("maps physical target access facts from the discovery snapshot", async () => {
  query.mockResolvedValue({
    type: "discovery_snapshot",
    payload: {
      generation: "generation-1",
      observed_at: "2026-09-06T00:00:00Z",
      instances: [],
      logical_targets: [],
      physical_targets: [
        {
          id: "fs-aurora",
          path: "D:/Work/Aurora",
          exists: true,
          readable: true,
          writable: false,
          case_behavior: "case_insensitive",
          logical_target_ids: [],
        },
      ],
    },
  });

  await expect(nativeProjectFacade.listPhysicalTargets()).resolves.toEqual([
    { exists: true, id: "fs-aurora", path: "D:/Work/Aurora", readable: true, writable: false },
  ]);
});

it("maps the project assembly plan items without inventing fields", async () => {
  query.mockResolvedValueOnce({
    type: "assembly_plan",
    payload: {
      id: "plan-1",
      operation_id: "op-1",
      project_id: "project-aurora",
      committed: false,
      items: [{
        requirement: {
          skill_id: "pdf-reader",
          source: "github.com/acme/pdf-reader",
          name: "PDF Reader",
          version_constraint: null,
          version_id: null,
          content_identity: null,
          logical_agent_id: null,
          project_subdirectory: null,
          note: null,
        },
        status: "ready_to_acquire",
        version_id: null,
        reasons: ["需要获取版本"],
        choice: null,
        conflict_kind: null,
        allowed_choices: ["acquire", "skip", "use_existing"],
      }],
    },
  });

  await expect(nativeProjectFacade.getAssemblyPlan("project-aurora")).resolves.toEqual({
    items: [{ name: "PDF Reader", reasons: ["需要获取版本"], skillId: "pdf-reader", status: "ready_to_acquire" }],
  });
});

it("reports a missing assembly plan as null and keeps other failures visible", async () => {
  query.mockRejectedValueOnce({ code: "object.not_found" });
  await expect(nativeProjectFacade.getAssemblyPlan("project-aurora")).resolves.toBeNull();

  query.mockRejectedValueOnce({ code: "internal.error", message: "boom" });
  await expect(nativeProjectFacade.getAssemblyPlan("project-aurora")).rejects.toMatchObject({ code: "internal.error" });
});

it("distinguishes a missing project from an unavailable native result", async () => {
  query.mockResolvedValue({ type: "projects", payload: [] });
  await expect(nativeProjectFacade.get("missing")).rejects.toThrow("Project missing was not found.");
});

it("loads portable shared requirements for project detail", async () => {
  query.mockResolvedValue({
    type: "projects",
    payload: [{ id: "project-aurora", name: "Aurora", device_path: "D:/Aurora", physical_id: "p", logical: { identity_hint: null, note: null }, tags: [], created_at: "now", updated_at: "now" }],
  });
  execute.mockResolvedValue({
    type: "shared_project_config",
    payload: {
      schema_version: 1,
      project_identity_hint: "github.com/acme/aurora",
      required_skills: [{
        skill_id: "pdf-reader",
        source: "github.com/acme/pdf-reader",
        name: "PDF Reader",
        version_constraint: null,
        version_id: null,
        content_identity: null,
        logical_agent_id: "openai.codex-cli",
        project_subdirectory: null,
        note: null,
      }],
    },
  });

  await expect(nativeProjectFacade.get("project-aurora")).resolves.toEqual(expect.objectContaining({
    sharedConfig: {
      identityHint: "github.com/acme/aurora",
      requirements: ["PDF Reader"],
      targetIds: ["openai.codex-cli"],
    },
  }));
});

it("registers a selected local directory without writing a shared project config", async () => {
  execute.mockResolvedValue({
    type: "project",
    payload: {
      id: "project-aurora",
      name: "Aurora",
      device_path: "D:/Work/Aurora",
      physical_id: "fs:project-aurora",
      logical: { identity_hint: null, note: null },
      tags: [{ name: "Desktop" }],
      created_at: "2026-09-05T00:00:00Z",
      updated_at: "2026-09-05T00:00:00Z",
    },
  });

  await expect(nativeProjectFacade.register({
    id: "project-aurora",
    name: "Aurora",
    path: "D:/Work/Aurora",
    tags: ["Desktop"],
    agentIds: [],
  })).resolves.toEqual(expect.objectContaining({
    id: "project-aurora",
    name: "Aurora",
    tags: ["Desktop"],
  }));

  expect(execute).toHaveBeenCalledWith({
    type: "register_project",
    payload: {
      project: expect.objectContaining({
        id: "project-aurora",
        name: "Aurora",
        device_path: "D:/Work/Aurora",
        logical: { identity_hint: null, note: null },
        physical_id: "",
        tags: [{ name: "Desktop" }],
      }),
    },
  });
});

it("updates only a project's Agent associations while preserving its local facts", async () => {
  const rawProject = {
    id: "project-aurora",
    name: "Aurora",
    device_path: "D:/Work/Aurora",
    physical_id: "fs:project-aurora",
    logical: { identity_hint: "github.com/acme/aurora", note: "Release workspace" },
    tags: [{ name: "Desktop" }],
    agent_ids: ["codex-cli"],
    created_at: "2026-09-02T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
  };
  query.mockResolvedValue({ type: "projects", payload: [rawProject] });
  execute.mockResolvedValue({ type: "project", payload: { ...rawProject, agent_ids: ["claude-code"] } });

  await expect(nativeProjectFacade.updateAgentIds("project-aurora", ["claude-code"])).resolves.toEqual(expect.objectContaining({
    agentIds: ["claude-code"],
    sharedConfig: expect.objectContaining({ identityHint: "github.com/acme/aurora" }),
  }));

  expect(execute).toHaveBeenCalledWith({
    type: "update_project",
    payload: { project: expect.objectContaining({
      id: "project-aurora",
      device_path: "D:/Work/Aurora",
      physical_id: "fs:project-aurora",
      logical: { identity_hint: "github.com/acme/aurora", note: "Release workspace" },
      tags: [{ name: "Desktop" }],
      agent_ids: ["claude-code"],
    }) },
  });
});

it("previews a chosen project directory read-only before registration", async () => {
  query.mockResolvedValueOnce({
    type: "project_directory_preview",
    payload: {
      path: "D:/Work/Aurora",
      agent_traces: [{
        id: "anthropic:claude-code:project:D:/Work/Aurora/.claude/skills",
        profile_id: "anthropic",
        client_id: "anthropic.claude-code",
        scope: "project",
        path: "D:/Work/Aurora/.claude/skills",
        marker: "SKILL.md",
        precedence: "preferred",
        exists: true,
        readable: true,
        writable: true,
        available: true,
        physical_id: "fs:claude-skills",
      }],
      skill_candidates: [{
        source: { kind: "local", locator: { local_path: "D:/Work/Aurora" } },
        absolute_root: "D:/Work/Aurora/.agents/skills/research",
        relative_root: ".agents/skills/research",
        marker: "SKILL.md",
        runtime_name: "research",
        ownership: "unclassified",
        default_action: "review",
        ownership_detail: null,
      }],
    },
  });

  await expect(nativeProjectFacade.previewDirectory("D:/Work/Aurora")).resolves.toEqual({
    path: "D:/Work/Aurora",
    agentTraces: [{
      targetId: "anthropic:claude-code:project:D:/Work/Aurora/.claude/skills",
      label: "anthropic · anthropic.claude-code",
      path: "D:/Work/Aurora/.claude/skills",
      marker: "SKILL.md",
      available: true,
    }],
    skillCandidates: [{
      name: "research",
      path: "D:/Work/Aurora/.agents/skills/research",
    }],
  });
  expect(query).toHaveBeenCalledWith({
    type: "preview_project_directory",
    payload: { path: "D:/Work/Aurora" },
  });
  expect(execute).not.toHaveBeenCalled();
});

it("rejects unreadable directories instead of showing an empty preview", async () => {
  query.mockRejectedValueOnce({ code: "input.invalid", message: "path must be an existing readable project directory" });

  await expect(nativeProjectFacade.previewDirectory("Z:/missing")).rejects.toMatchObject({
    code: "input.invalid",
  });
  expect(execute).not.toHaveBeenCalled();
});
