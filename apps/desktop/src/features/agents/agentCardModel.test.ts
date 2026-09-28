import { describe, expect, it } from "vitest";
import { buildAgentCardModels } from "./agentCardModel";
import type { AgentView } from "./api";

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    brand: "OpenAI",
    client: "openai.cli",
    discoveredPaths: ["C:/Users/demo/.codex/skills"],
    id: "openai.cli",
    instance: "Codex CLI",
    managedDeploymentCount: 0,
    managedDeploymentRelationCount: 0,
    officialReference: null,
    relations: [],
    status: "accessible",
    ...overrides,
  };
}

describe("AgentCardModel", () => {
  it("merges same-brand clients on one verified directory and keeps types", () => {
    const cards = buildAgentCardModels([
      agent(),
      agent({
        client: "openai.desktop",
        id: "openai.desktop",
        instance: "Codex Desktop",
        kinds: ["desktop"],
      }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].kinds).toEqual(expect.arrayContaining(["cli", "desktop"]));
  });

  it("keeps same-brand different directories as separate cards", () => {
    const cards = buildAgentCardModels([
      agent(),
      agent({
        id: "openai.desktop",
        client: "openai.desktop",
        instance: "Codex Desktop",
        discoveredPaths: ["C:/Users/demo/.agents/skills"],
        kinds: ["desktop"],
      }),
    ]);
    expect(cards).toHaveLength(2);
  });

  it("renders an identified but uncreated directory as pending", () => {
    const cards = buildAgentCardModels([agent({
      discoveredPaths: [],
      directoryViews: [{
        path: null,
        status: "pending_creation",
        role: "agent_native",
        sharedReference: false,
        builtin: false,
        readable: false,
        writable: false,
        available: false,
        physicalIdentityVerified: false,
        supportedModes: ["managed_copy"],
        preferredMode: "managed_copy",
        deploymentStatus: "not_deployed",
      }],
    })]);
    expect(cards[0].directories[0].status).toBe("pending_creation");
    expect(cards[0].directories[0].path).toBeNull();
  });

  it("keeps shared directory as an independent card with supported brands", () => {
    const cards = buildAgentCardModels([
      agent({
        brand: "Agent Skills",
        client: "agent-skills.shared-directory",
        id: "agent-skills.shared-directory",
        instance: "Agent 共享目录",
        kinds: ["shared_directory"],
        sharedAgentBrands: ["OpenAI", "Cursor"],
        directoryViews: [{
          path: "C:/Users/demo/.agents/skills",
          status: "existing",
          role: "shared_directory",
          sharedReference: false,
          builtin: false,
          readable: true,
          writable: true,
          available: true,
          physicalIdentityVerified: true,
          physicalIdentityKey: "fs:shared",
          supportedModes: ["managed_copy", "symbolic_link"],
          preferredMode: "symbolic_link",
          deploymentStatus: "not_deployed",
        }],
      }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].sharedDirectory).toBe(true);
    expect(cards[0].sharedAgentBrands).toEqual(["Cursor", "OpenAI"]);
  });
});
