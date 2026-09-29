import { describe, expect, it } from "vitest";
import type { AgentView } from "./api";
import { countDiscoveredAgentCards } from "./agentCards";
import type { AgentDirectoryProjection } from "../../api/bindings";

function agent(overrides: Partial<AgentView> & Pick<AgentView, "id" | "brand" | "client">): AgentView {
  return {
    discoveredPaths: [],
    instance: overrides.client,
    managedDeploymentCount: 0,
    managedDeploymentRelationCount: 0,
    officialReference: null,
    relations: [],
    status: "accessible",
    ...overrides,
  };
}

describe("countDiscoveredAgentCards", () => {
  it("counts merged brand cards once, matching what the agent page renders", () => {
    // 验收反馈（2026-09-25）：概览「已发现」必须等于 Agent 页卡片数——
    // 同品牌同目录的 cli/desktop 合并计 1；仅发现相关目录的客户端并入品牌卡，
    // 不单独计数；内置只读视图是独立卡片，照常计数。
    const agents: AgentView[] = [
      agent({ id: "openai.codex-cli", brand: "OpenAI", client: "codex-cli", discoveredPaths: ["C:/u/.codex/skills"] }),
      agent({ id: "openai.codex-desktop", brand: "OpenAI", client: "codex-desktop", discoveredPaths: ["C:/u/.codex/skills"] }),
      // 仅发现相关目录：并入 OpenAI 的目录卡，不加卡。
      agent({ id: "openai.codex-ghost", brand: "OpenAI", client: "codex-other", status: "directory_only" }),
      // 内置只读视图：独立一张卡。
      agent({
        id: "openai.codex-cli.builtin",
        brand: "OpenAI",
        client: "codex-cli",
        discoveredPaths: ["C:/u/.codex/skills/.system"],
        builtin: true,
      }),
      // 另一品牌一张卡。
      agent({ id: "zcode.desktop", brand: "ZCode", client: "zcode-desktop", discoveredPaths: ["C:/u/.zcode/skills"] }),
    ];

    // 无物理目录的类型不能与已有目录合并；只有确认同一物理目录才合卡。
    expect(countDiscoveredAgentCards(agents)).toBe(4);
  });

  it("excludes custom agents from the discovered caliber", () => {
    const agents: AgentView[] = [
      agent({ id: "custom-reviewer", brand: "Acme", client: "custom", status: "custom", discoveredPaths: ["D:/Agents/reviewer"] }),
      agent({ id: "zcode.desktop", brand: "ZCode", client: "zcode-desktop", discoveredPaths: ["C:/u/.zcode/skills"] }),
    ];

    expect(countDiscoveredAgentCards(agents)).toBe(1);
  });
});

describe("buildAgentCardViews kind presentation", () => {
  it("uses the backend ClientKind instead of guessing from id strings", async () => {
    // 2026-09-25 验收反馈：pi.coding-agent / OpenClaw / Hermes 的 id 不含
    // cli/headless 等关键词，字符串推断落到 unknown，类型徽标显示「Agent」。
    // 权威事实在 discovery 快照的 ClientKind 里，必须随 AgentView 传递。
    const { buildAgentCardViews } = await import("./agentCards");
    const agents: AgentView[] = [
      agent({ id: "pi.coding-agent", brand: "Pi", client: "pi.coding-agent", kinds: ["cli"], discoveredPaths: ["C:/u/.pi/agent/skills"] }),
      agent({ id: "openclaw.core", brand: "OpenClaw", client: "openclaw.core", kinds: ["headless"], discoveredPaths: ["C:/u/.agents/skills"] }),
    ];

    const cards = [...buildAgentCardViews(agents)].flatMap(([, group]) => group);
    expect(cards.map((card) => card.kinds)).toEqual([["cli"], ["headless"]]);
  });

  it("keeps string inference as the fallback when kinds are absent", async () => {
    const { buildAgentCardViews } = await import("./agentCards");
    const agents: AgentView[] = [
      agent({ id: "openai.codex-cli", brand: "OpenAI", client: "codex-cli", discoveredPaths: ["C:/u/.codex/skills"] }),
    ];

    const cards = [...buildAgentCardViews(agents)].flatMap(([, group]) => group);
    expect(cards[0].kinds).toEqual(["cli"]);
  });
});

describe("buildAgentCardViews shared-reference facts (DEV-88)", () => {
  it("keeps shared-directory support separate from card merging", async () => {
    // 共享目录是独立卡；品牌卡只保留是否支持的事实，不把共享路径作为
    // 合卡依据，也不重复展示共享目录路径。
    const { buildAgentCardViews } = await import("./agentCards");
    const agents: AgentView[] = [
      agent({
        id: "openai.codex-cli",
        brand: "OpenAI",
        client: "codex-cli",
        kinds: ["cli"],
        discoveredPaths: ["C:/u/.codex/skills", "C:/u/.agents/skills"],
        sharedReferencePaths: ["C:\\u\\.agents\\skills"],
        supportsSharedDirectory: true,
      }),
      agent({
        id: "openai.codex-desktop",
        brand: "OpenAI",
        client: "codex-desktop",
        kinds: ["desktop"],
        discoveredPaths: ["C:/u/.codex/skills", "c:\U\.AGENTS\skills"],
        sharedReferencePaths: ["c:\\U\\.AGENTS\\skills"],
        supportsSharedDirectory: true,
      }),
      agent({
        id: "zcode.desktop",
        brand: "ZCode",
        client: "zcode-desktop",
        kinds: ["desktop"],
        discoveredPaths: ["C:/u/.zcode/skills"],
      }),
    ];

    const views = buildAgentCardViews(agents);
    const openai = views.get("openai")![0];
    expect(openai.sharedPathKeys).toHaveLength(0);
    expect(openai.agent.supportsSharedDirectory).toBe(true);
    const zcode = views.get("zcode")![0];
    expect(zcode.sharedPathKeys).toHaveLength(0);
  });
});

describe("directory projection compatibility adapter", () => {
  it("adapts shared facts into one readable AgentView while retaining internal target mapping", async () => {
    const { agentDirectoryProjectionToViews, buildAgentDirectoryCardViews } = await import("./agentCards");
    const projection: AgentDirectoryProjection = {
      directories: [{
        role: "shared_directory" as const,
        identity: { kind: "verified_physical" as const, value: "physical-shared-id" },
        path: "C:/Users/demo/.agents/skills",
        status: "existing" as const,
        exists: true,
        readable: true,
        writable: true,
        available: true,
        members: [
          {
            logical_target_id: "openai.cli.internal-target",
            brand: "OpenAI",
            client_id: "openai.cli.internal-client",
            kind: "cli" as const,
            availability: { status: "existing" as const, exists: true, readable: true, writable: true, available: true },
            capabilities: { deployment: { copy: true, symlink: true, junction: false }, modes: ["managed_copy", "symbolic_link"], preferred_mode: "symbolic_link" },
            deployment_status: "deployed",
            managed_deployment_relation_count: 2,
            managed_deployment_count: 1,
          },
          {
            logical_target_id: "cursor.desktop.internal-target",
            brand: "Cursor",
            client_id: "cursor.desktop.internal-client",
            kind: "desktop",
            availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
            capabilities: { deployment: { copy: true, symlink: false, junction: false }, modes: ["managed_copy"], preferred_mode: "managed_copy" },
            deployment_status: "not_deployed",
            managed_deployment_relation_count: 0,
            managed_deployment_count: 0,
          },
        ],
      }],
    };

    const views = agentDirectoryProjectionToViews(projection);
    expect(views).toHaveLength(1);
    expect(views[0].instance).toBe("共享目录");
    expect(views[0].sharedAgentBrands).toEqual(["Cursor", "OpenAI"]);
    expect(views[0].relations[0].logicalTargetId).toBe("openai.cli.internal-target");
    expect(views[0].directoryMembers?.[0].capabilities.modes).toEqual(["managed_copy", "symbolic_link"]);
    expect(views[0].managedDeploymentCount).toBe(1);
    expect(views[0].managedDeploymentRelationCount).toBe(2);
    expect(views[0].deploymentStatus).toBe("deployed");
    expect(views[0].directoryMembers?.map((member) => [member.deployment_status, member.managed_deployment_count, member.managed_deployment_relation_count]))
      .toEqual([["deployed", 1, 2], ["not_deployed", 0, 0]]);
    expect(views[0].directoryViews?.[0].physicalIdentityVerified).toBe(true);

    const cards = [...buildAgentDirectoryCardViews(projection).values()].flat();
    expect(cards).toHaveLength(1);
    expect(cards[0].sharedDirectory).toBe(true);
    expect(cards[0].agent.brand).toBe("Agent Skills");
    expect(cards[0].agent.instance).toBe("共享目录");
    expect(cards[0].agent.instance).not.toContain("internal");
    expect(cards[0].agent.directoryMembers?.map((member) => member.managed_deployment_count)).toEqual([1, 0]);
    expect(cards[0].agent.deploymentStatus).toBe("deployed");
    expect(cards[0].agents.map((member) => [member.deploymentStatus, member.managedDeploymentCount, member.managedDeploymentRelationCount]))
      .toEqual([["deployed", 1, 2], ["not_deployed", 0, 0]]);
  });
});
