import { describe, expect, it } from "vitest";
import { buildAgentCardModels, buildAgentDirectoryCardModels, directoryStatusLabel, directoryStatusSuggestion } from "./agentCardModel";
import type { AgentDirectoryProjection } from "../../api/bindings";
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

  it("shows only deployment methods shared by every member of a card", () => {
    const directory = (supportedModes: NonNullable<AgentView["directoryViews"]>[number]["supportedModes"]) => ({
      path: "C:/Users/demo/.codex/skills",
      status: "existing" as const,
      role: "agent_user" as const,
      isSharedDirectory: false,
      supportsSharedDirectory: false,
      sharedReference: false,
      builtin: false,
      readable: true,
      writable: true,
      available: true,
      physicalIdentityVerified: true,
      physicalIdentityKey: "shared-physical-id",
      supportedModes,
      deploymentStatus: "not_deployed" as const,
    });
    const cards = buildAgentCardModels([
      agent({ directoryViews: [directory(["managed_copy", "symbolic_link"])] }),
      agent({
        id: "openai.desktop",
        client: "openai.desktop",
        instance: "Codex Desktop",
        kinds: ["desktop"],
        directoryViews: [directory(["managed_copy", "directory_junction"])],
      }),
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0].supportedModes).toEqual(["managed_copy"]);
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

function projectedDirectory(overrides: Partial<AgentDirectoryProjection["directories"][number]> = {}): AgentDirectoryProjection["directories"][number] {
  return {
    role: "agent_native",
    identity: { kind: "verified_physical", value: "physical-a" },
    path: "C:/Users/demo/.agents/skills",
    status: "existing",
    exists: true,
    readable: true,
    writable: true,
    available: true,
    members: [{
      logical_target_id: "openai.cli.target",
      brand: "OpenAI",
      client_id: "openai.cli",
      kind: "cli",
      availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
      capabilities: {
        deployment: { copy: true, symlink: true, junction: true },
        modes: ["managed_copy", "symbolic_link", "directory_junction"],
        preferred_mode: "symbolic_link",
      },
      deployment_status: "not_deployed",
      managed_deployment_relation_count: 0,
      managed_deployment_count: 0,
    }],
    ...overrides,
  };
}

describe("buildAgentDirectoryCardModels", () => {
  it("presents abnormal directory states with user-readable recovery guidance", () => {
    expect(directoryStatusLabel("pending_creation")).toBe("agents.directoryStatus.pendingCreation");
    expect(directoryStatusSuggestion("pending_creation")).toBe("agents.directoryStatusSuggestion.pendingCreation");
    expect(directoryStatusLabel("non_directory")).toBe("agents.directoryStatus.nonDirectory");
    expect(directoryStatusSuggestion("non_directory")).toBe("agents.directoryStatusSuggestion.nonDirectory");
    expect(directoryStatusLabel("inaccessible")).toBe("agents.directoryStatus.inaccessible");
    expect(directoryStatusSuggestion("inaccessible")).toBe("agents.directoryStatusSuggestion.inaccessible");
    expect(directoryStatusLabel("broken_link")).toBe("agents.directoryStatus.brokenLink");
    expect(directoryStatusSuggestion("broken_link")).toBe("agents.directoryStatusSuggestion.brokenLink");
    expect(directoryStatusLabel("identity_changed")).toBe("agents.directoryStatus.identityChanged");
    expect(directoryStatusSuggestion("identity_changed")).toBe("agents.directoryStatusSuggestion.identityChanged");
  });

  it("uses verified physical identity rather than path spelling and never merges candidate identities", () => {
    const cards = buildAgentDirectoryCardModels({ directories: [
      projectedDirectory({
        identity: { kind: "verified_physical", value: "physical-a" },
        path: "C:/Users/demo/.agents/skills",
      }),
      projectedDirectory({
        identity: { kind: "verified_physical", value: "physical-b" },
        path: "c:\\users\\demo\\.agents\\skills\\",
        members: [{
          ...projectedDirectory().members[0],
          logical_target_id: "cursor.desktop.target",
          brand: "Cursor",
          client_id: "cursor.desktop",
          kind: "desktop",
        }],
      }),
      projectedDirectory({
        identity: { kind: "candidate", value: "candidate-one" },
        status: "missing", exists: false, available: false, path: "C:/candidate/one",
        members: [{ ...projectedDirectory().members[0], logical_target_id: "candidate-one" }],
      }),
      projectedDirectory({
        identity: { kind: "candidate", value: "candidate-two" },
        status: "missing", exists: false, available: false, path: "C:/candidate/two",
        members: [{ ...projectedDirectory().members[0], logical_target_id: "candidate-two" }],
      }),
    ] });

    expect(cards).toHaveLength(4);
    expect(cards.map((card) => card.directories[0].physicalIdentityKey)).toContain("physical-a");
    expect(cards.filter((card) => !card.directories[0].physicalIdentityVerified)).toHaveLength(2);
  });

  it("keeps shared directory independent with recognized brands, kinds, target IDs, and member capabilities", () => {
    const shared = projectedDirectory({
      role: "shared_directory",
      identity: { kind: "verified_physical", value: "physical-shared" },
      members: [
        {
          ...projectedDirectory().members[0],
          logical_target_id: "agent-skills.shared-directory",
          brand: "agent-skills",
          client_id: "agent-skills.shared-directory",
          kind: "shared_directory",
        },
        projectedDirectory().members[0],
        {
          ...projectedDirectory().members[0],
          logical_target_id: "cursor.desktop.target",
          brand: "Cursor",
          client_id: "cursor.desktop",
          kind: "desktop",
          capabilities: {
            deployment: { copy: true, symlink: false, junction: false },
            modes: ["managed_copy"],
            preferred_mode: "managed_copy",
          },
        },
      ],
    });
    const cards = buildAgentDirectoryCardModels({ directories: [shared] });
    expect(cards).toHaveLength(1);
    expect(cards[0].sharedDirectory).toBe(true);
    expect(cards[0].sharedAgentBrands).toEqual(["Cursor", "OpenAI"]);
    expect(cards[0].sharedAgentBrandKinds).toEqual({ Cursor: ["desktop"], OpenAI: ["cli"] });
    expect(cards[0].members.map((member) => member.id)).toEqual(["agent-skills.shared-directory", "openai.cli.target", "cursor.desktop.target"]);
    expect(cards[0].directoryMembers?.map((member) => member.logical_target_id)).toEqual(["agent-skills.shared-directory", "openai.cli.target", "cursor.desktop.target"]);
    expect(cards[0].supportedModes).toEqual(["managed_copy"]);
    expect(cards[0].members.map((member) => [member.deploymentStatus, member.managedDeploymentCount, member.managedDeploymentRelationCount]))
      .toEqual([["not_deployed", 0, 0], ["not_deployed", 0, 0], ["not_deployed", 0, 0]]);
  });

  it("preserves explicit directory roles and unavailable observation states", () => {
    const cards = buildAgentDirectoryCardModels({ directories: [
      projectedDirectory({ status: "missing", exists: false, available: false, role: "agent_native" }),
      projectedDirectory({ status: "inaccessible", available: false, readable: false }),
      projectedDirectory({ status: "broken_link", available: false, readable: false }),
      projectedDirectory({ role: "builtin" }),
      projectedDirectory({ role: "project" }),
    ] });
    expect(cards.map((card) => card.directories[0].role)).toEqual(["agent_native", "agent_native", "agent_native", "builtin", "project"]);
    expect(cards.map((card) => card.directories[0].status)).toEqual(["pending_creation", "inaccessible", "broken_link", "existing", "existing"]);
    expect(cards[0].supportedModes).toEqual(["managed_copy", "symbolic_link", "directory_junction"]);
    expect(cards[3].readOnly).toBe(true);
  });

  it("keeps workspace role separate from project entities and shared-directory capability", () => {
    const workspace = projectedDirectory({ role: "agent_workspace" });
    workspace.members[0].supports_shared_directory = true;
    const cards = buildAgentDirectoryCardModels({ directories: [workspace] });

    expect(cards).toHaveLength(1);
    expect(cards[0].directories[0].role).toBe("agent_workspace");
    expect(cards[0].sharedDirectory).toBe(false);
    expect(cards[0].supportsSharedDirectory).toBe(true);
  });

  it("keeps abnormal target paths visible while missing targets remain pending", () => {
    const cards = buildAgentDirectoryCardModels({ directories: [
      projectedDirectory({
        status: "non_directory", exists: false, available: false, readable: false,
        path: "C:/Users/demo/.codex/skills",
      }),
      projectedDirectory({
        status: "missing", exists: false, available: false, readable: false,
        identity: { kind: "candidate", value: "candidate" },
        path: "C:/Users/demo/.cursor/skills",
      }),
    ] });

    expect(cards[0].directories[0].path).toBe("C:/Users/demo/.codex/skills");
    expect(cards[0].members[0].discoveredPaths).toEqual(["C:/Users/demo/.codex/skills"]);
    expect(cards[1].directories[0].path).toBeNull();
  });
});
