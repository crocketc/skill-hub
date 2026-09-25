import { describe, expect, it } from "vitest";
import type { AgentView } from "./api";
import { countDiscoveredAgentCards } from "./agentCards";

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

    expect(countDiscoveredAgentCards(agents)).toBe(3);
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
