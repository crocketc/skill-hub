import { beforeEach, expect, it, vi } from "vitest";
import {
  executeCommand,
  queryApplication,
  type DeploymentRecord,
  type DiscoverySnapshot,
} from "../../api/bindings";
import { nativeAgentFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));

const query = vi.mocked(queryApplication);
const command = vi.mocked(executeCommand);

const emptySnapshot: DiscoverySnapshot = {
  generation: "g",
  observed_at: "now",
  instances: [],
  logical_targets: [],
  physical_targets: [],
};

function snapshotWithTarget(overrides: Partial<{
  targetId: string;
  profileId: string;
  clientId: string;
  available: boolean;
  physicalId: string;
}>): DiscoverySnapshot {
  const targetId = overrides.targetId ?? "openai.codex-cli.user";
  const physicalId = overrides.physicalId ?? "physical-1";
  return {
    generation: "generation-1",
    observed_at: "2026-09-02T00:00:00Z",
    instances: [{
      profile_id: overrides.profileId ?? "openai",
      client_id: overrides.clientId ?? "codex-cli",
      kind: "cli",
      supported_os: ["windows"],
      client_presence: "Unknown",
    }],
    logical_targets: [{
      id: targetId,
      profile_id: overrides.profileId ?? "openai",
      client_id: overrides.clientId ?? "codex-cli",
      scope: "global",
      path: "C:/Users/Test/.codex/skills",
      marker: "SKILL.md",
      precedence: "preferred",
      exists: overrides.available ?? true,
      readable: overrides.available ?? true,
      writable: overrides.available ?? true,
      available: overrides.available ?? true,
      physical_id: physicalId,
    }],
    physical_targets: [{
      id: physicalId,
      path: "C:/Users/Test/.codex/skills",
      exists: overrides.available ?? true,
      readable: overrides.available ?? true,
      writable: overrides.available ?? true,
      case_behavior: "insensitive",
      logical_target_ids: [targetId],
    }],
  };
}

function deployments(targetId: string, states: DeploymentRecord["state"][]): DeploymentRecord[] {
  return states.map((state, index) => ({
    id: `deployment-${index}`,
    skill_id: `skill-${index}`,
    version_id: `version-${index}`,
    target_id: targetId,
    state,
    mode: "managed_copy",
    managed: true,
    runtime_name: "runtime",
    expected_hash: "hash",
    observed_hash: null,
  }));
}

beforeEach(() => {
  query.mockReset();
  command.mockReset();
});

it("maps discovered clients with availability status and active deployment counts", async () => {
  query
    .mockResolvedValueOnce({ type: "discovery_snapshot", payload: snapshotWithTarget({}) })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({
      type: "deployments",
      payload: [
        ...deployments("openai.codex-cli.user", ["deployed", "needs_recovery"]),
        ...deployments("other-target", ["deployed"]),
      ],
    });

  const agents = await nativeAgentFacade.list();

  expect(agents).toEqual([expect.objectContaining({
    id: "openai.codex-cli",
    status: "accessible",
    managedDeploymentCount: 2,
  })]);
});

it("marks agents whose targets are not available as inaccessible", async () => {
  query
    .mockResolvedValueOnce({
      type: "discovery_snapshot",
      payload: snapshotWithTarget({ available: false }),
    })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({
      type: "deployments",
      payload: deployments("openai.codex-cli.user", ["deployed"]),
    });

  const agents = await nativeAgentFacade.list();

  expect(agents).toEqual([expect.objectContaining({
    status: "inaccessible",
    managedDeploymentCount: 1,
  })]);
});

it("marks registered custom agents as custom with their granted directory", async () => {
  query
    .mockResolvedValueOnce({ type: "discovery_snapshot", payload: emptySnapshot })
    .mockResolvedValueOnce({
      type: "custom_agents",
      payload: [{
        id: "custom-reviewer",
        display_name: "Reviewer",
        directory: { grant_id: "grant-1", path: "D:/Agents/reviewer", operating_system: "windows" },
        profile: {
          profile_version: 1,
          research_date: "2026-09-02",
          official_references: ["https://acme.example/docs"],
          brand: "Acme",
          clients: [],
        },
      }],
    })
    .mockResolvedValueOnce({ type: "deployments", payload: [] });

  const agents = await nativeAgentFacade.list();

  expect(agents).toEqual([expect.objectContaining({
    id: "custom-reviewer",
    brand: "Acme",
    client: "custom",
    instance: "Reviewer",
    discoveredPaths: ["D:/Agents/reviewer"],
    officialReference: "https://acme.example/docs",
    status: "custom",
    managedDeploymentCount: 0,
  })]);
});

it("aggregates managed deployments by unique skill while keeping the relation total", async () => {
  const record = (skillId: string, index: number, state: DeploymentRecord["state"] = "deployed"): DeploymentRecord => ({
    id: `deployment-${index}`,
    skill_id: skillId,
    version_id: `version-${index}`,
    target_id: "openai.codex-cli.user",
    state,
    mode: "managed_copy",
    managed: true,
    runtime_name: "runtime",
    expected_hash: "hash",
    observed_hash: null,
  });
  query
    .mockResolvedValueOnce({ type: "discovery_snapshot", payload: snapshotWithTarget({}) })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({
      type: "deployments",
      payload: [
        record("skill-a", 0),
        record("skill-a", 1),
        record("skill-b", 2),
        record("skill-a", 3, "removed"),
      ],
    });

  const agents = await nativeAgentFacade.list();

  expect(agents).toEqual([expect.objectContaining({
    id: "openai.codex-cli",
    managedDeploymentCount: 2,
    managedDeploymentRelationCount: 3,
  })]);
});

it("creates custom agents through the native command with the picked directory grant", async () => {
  command.mockResolvedValue({
    type: "custom_agent",
    payload: {
      id: "custom-reviewer",
      display_name: "Reviewer",
      directory: { grant_id: "D:/Agents/reviewer", path: "D:/Agents/reviewer", operating_system: "windows" },
      profile: {
        profile_version: 1,
        research_date: "2026-09-06",
        official_references: ["https://acme.example/docs"],
        brand: "Acme",
        clients: [],
      },
    },
  });

  await nativeAgentFacade.createCustomAgent({
    brand: "Acme",
    displayName: "Reviewer",
    directoryPath: "D:/Agents/reviewer",
    referenceUrl: "https://acme.example/docs",
  });

  expect(command).toHaveBeenCalledTimes(1);
  const request = command.mock.calls[0][0];
  expect(request.type).toBe("create_custom_agent");
  if (request.type !== "create_custom_agent") throw new Error("unexpected command");
  expect(request.payload.agent.id).toBe("custom-reviewer");
  expect(request.payload.agent.display_name).toBe("Reviewer");
  expect(request.payload.agent.directory.grant_id).toBe("D:/Agents/reviewer");
  expect(request.payload.agent.profile.brand).toBe("Acme");
  expect(request.payload.agent.profile.official_references).toEqual(["https://acme.example/docs"]);
  expect(request.payload.agent.profile.clients).toHaveLength(1);
  expect(request.payload.agent.profile.clients[0].path_candidates).toEqual([{
    marker: "SKILL.md",
    path: "D:/Agents/reviewer",
    precedence: "preferred",
    scope: "global",
  }]);
});

it("updates custom agents under their existing identifier", async () => {
  command.mockResolvedValue({
    type: "custom_agent",
    payload: {
      id: "custom-reviewer",
      display_name: "Reviewer 2",
      directory: { grant_id: "D:/Agents/reviewer", path: "D:/Agents/reviewer", operating_system: "windows" },
      profile: {
        profile_version: 1,
        research_date: "2026-09-06",
        official_references: ["https://acme.example/docs"],
        brand: "Acme",
        clients: [],
      },
    },
  });

  await nativeAgentFacade.updateCustomAgent("custom-reviewer", {
    brand: "Acme",
    displayName: "Reviewer 2",
    directoryPath: "D:/Agents/reviewer",
    referenceUrl: "https://acme.example/docs",
  });

  const request = command.mock.calls[0][0];
  expect(request.type).toBe("update_custom_agent");
  if (request.type !== "update_custom_agent") throw new Error("unexpected command");
  expect(request.payload.agent.id).toBe("custom-reviewer");
  expect(request.payload.agent.display_name).toBe("Reviewer 2");
});

it("surfaces create failures instead of pretending the agent was saved", async () => {
  command.mockRejectedValue(new Error("agent_invalid"));

  await expect(nativeAgentFacade.createCustomAgent({
    brand: "Acme",
    displayName: "Reviewer",
    directoryPath: "D:/Agents/reviewer",
    referenceUrl: "https://acme.example/docs",
  })).rejects.toThrow("agent_invalid");
});

it("removes custom agents by identifier through the native command", async () => {
  command.mockResolvedValue({
    type: "operation_summary",
    payload: { operation_id: "op-1", phase: "committed", message_code: "custom_agent.removed", error_code: null },
  });

  await nativeAgentFacade.removeCustomAgent("custom-reviewer");

  expect(command).toHaveBeenCalledWith({
    type: "remove_custom_agent",
    payload: { id: "custom-reviewer" },
  });
});

it("surfaces remove failures instead of pretending the agent was removed", async () => {
  command.mockRejectedValue(new Error("remove failed"));

  await expect(nativeAgentFacade.removeCustomAgent("custom-reviewer")).rejects.toThrow("remove failed");
});

it("reruns agent discovery through the native command", async () => {
  command.mockResolvedValue({
    type: "discovery_snapshot",
    payload: emptySnapshot,
  });

  await nativeAgentFacade.rescan();

  expect(command).toHaveBeenCalledWith({
    type: "discover_agent_targets",
    payload: null,
  });
});

it("surfaces rescan failures instead of pretending the scan ran", async () => {
  command.mockRejectedValue(new Error("scan failed"));
  await expect(nativeAgentFacade.rescan()).rejects.toThrow("scan failed");
});
