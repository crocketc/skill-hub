import { beforeEach, expect, it, vi } from "vitest";
import { queryApplication } from "../../api/bindings";
import { nativeAgentFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({ queryApplication: vi.fn() }));

const query = vi.mocked(queryApplication);

beforeEach(() => query.mockReset());

it("maps discovered client instances and their logical targets without fixture data", async () => {
  query
    .mockResolvedValueOnce({
      type: "discovery_snapshot",
      payload: {
        generation: "generation-1",
        observed_at: "2026-09-02T00:00:00Z",
        instances: [{
          profile_id: "openai",
          client_id: "codex-cli",
          kind: "cli",
          supported_os: ["windows"],
          client_presence: "Unknown",
        }],
        logical_targets: [{
          id: "openai.codex-cli.user",
          profile_id: "openai",
          client_id: "codex-cli",
          scope: "global",
          path: "C:/Users/Test/.codex/skills",
          marker: "SKILL.md",
          precedence: "preferred",
          exists: true,
          readable: true,
          writable: true,
          available: true,
          physical_id: "physical-1",
        }],
        physical_targets: [{
          id: "physical-1",
          path: "C:/Users/Test/.codex/skills",
          exists: true,
          readable: true,
          writable: true,
          case_behavior: "insensitive",
          logical_target_ids: ["openai.codex-cli.user"],
        }],
      },
    })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] });

  await expect(nativeAgentFacade.list()).resolves.toEqual([{
    id: "openai.codex-cli",
    brand: "openai",
    client: "codex-cli",
    instance: "codex-cli",
    discoveredPaths: ["C:/Users/Test/.codex/skills"],
    relations: [{
      logicalLabel: "openai.codex-cli.user",
      logicalTargetId: "openai.codex-cli.user",
      physicalPath: "C:/Users/Test/.codex/skills",
      physicalTargetId: "physical-1",
    }],
  }]);
});

it("maps registered custom agents and keeps their granted directory visible", async () => {
  query
    .mockResolvedValueOnce({
      type: "discovery_snapshot",
      payload: { generation: "g", observed_at: "now", instances: [], logical_targets: [], physical_targets: [] },
    })
    .mockResolvedValueOnce({
      type: "custom_agents",
      payload: [{
        id: "custom-reviewer",
        display_name: "Reviewer",
        directory: { grant_id: "grant-1", path: "D:/Agents/reviewer", operating_system: "windows" },
        profile: { profile_version: 1, research_date: "2026-09-02", official_references: [], brand: "Acme", clients: [] },
      }],
    });

  const agents = await nativeAgentFacade.list();
  expect(agents).toEqual([expect.objectContaining({
    id: "custom-reviewer",
    brand: "Acme",
    client: "custom",
    instance: "Reviewer",
    discoveredPaths: ["D:/Agents/reviewer"],
  })]);
});
