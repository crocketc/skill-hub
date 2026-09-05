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
    assembly: [],
    description: "Release workspace",
    id: "project-aurora",
    name: "Aurora",
    sharedConfig: {
      identityHint: "github.com/acme/aurora",
      requirements: [],
      targetIds: [],
    },
    tags: ["Rust", "Desktop"],
  }]);
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
