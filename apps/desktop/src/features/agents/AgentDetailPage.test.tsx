import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type {
  GovernanceHistoryEntry,
  RelationshipOverview,
  RelationGovernanceRow,
} from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import type { DirectoryPicker } from "../../platform/directoryPicker";
import type { RelationGovernanceFacade } from "../relationships/governance/api";
import { governanceContextCheckStorageKey } from "../relationships/governance/useRelationshipContextCheck";
import { type AgentFacade, type AgentView, agentFixture, customAgentFixture } from "./api";
import { AgentDetailPage } from "./AgentDetailPage";
import { RelationsView } from "./RelationsView";

const pickingPicker: DirectoryPicker = {
  pickDirectory: vi.fn(async () => "D:/Agents/auditor"),
};

const emptyOverview: RelationshipOverview = {
  scope: { type: "agent", value: { agent_client_id: "codex-cli" } },
  directory_nodes: [],
  agent_directory_capabilities: [],
  source_relations: [],
  deployment_relations: [],
  conflict_cases: [],
  pending_governance_tasks: [],
  agent_execution_confirmed: false,
};

function facadeWith(agent: AgentView, overrides: Partial<AgentFacade> = {}): AgentFacade {
  return {
    get: vi.fn(async () => agent),
    list: vi.fn(async () => [agent]),
    rescan: vi.fn(async () => undefined),
    createCustomAgent: vi.fn(async () => undefined),
    updateCustomAgent: vi.fn(async () => undefined),
    removeCustomAgent: vi.fn(async () => undefined),
    getRelationshipOverview: vi.fn(async () => emptyOverview),
    getRelationshipRemovalImpact: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
    ...overrides,
  };
}

async function renderDetailPage(facade: AgentFacade, governanceFacade?: RelationGovernanceFacade) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/agents/custom-reviewer"]}>
        <I18nextProvider i18n={i18n}>
          <AgentDetailPage
            agentId="custom-reviewer"
            facade={facade}
            governanceFacade={governanceFacade}
            picker={pickingPicker}
          />
        </I18nextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("shows discovered directory facts without trust or usability status", async () => {
  const facade = facadeWith(agentFixture());
  await renderDetailPage(facade);

  expect(await screen.findByText("已发现客户端和 Skill 目录")).toBeVisible();
  expect(screen.getByText("可访问")).toBeVisible();
  expect(screen.getByText("2 个 Skill · 5 条部署关系")).toBeVisible();
  expect(screen.queryByText(/已授权|可用|验证通过/)).not.toBeInTheDocument();
  expect(screen.getByText("实验功能，仅供参考")).toBeVisible();
  expect(screen.getByText("研发中")).toBeVisible();
});

it("states contract boundaries instead of showing fake management actions", async () => {
  await renderDetailPage(facadeWith(agentFixture()));

  expect(await screen.findByText("Agent 级忽略需要原生契约支持，暂未提供。")).toBeVisible();
  expect(
    screen.getByText("识别到的内置 Agent 目录来自发现快照，应用内重新定位暂未提供。"),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /重新定位/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /忽略/ })).not.toBeInTheDocument();
});

it("points custom agent relocation at the edit form instead of a missing contract", async () => {
  await renderDetailPage(facadeWith(customAgentFixture()));

  expect(
    await screen.findByText(
      "重新定位目录：编辑该自定义 Agent 并重新选择目录即可；新目录会注册为授权路径。",
    ),
  ).toBeVisible();
  expect(screen.getByText("Agent 级忽略需要原生契约支持，暂未提供。")).toBeVisible();
});

it("offers explicit edit and confirmed removal entries for custom agents", async () => {
  const user = userEvent.setup();
  const facade = facadeWith(customAgentFixture());
  await renderDetailPage(facade);

  expect(await screen.findByRole("button", { name: "编辑" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "编辑" }));
  expect(await screen.findByDisplayValue("Reviewer")).toBeVisible();
  expect((await screen.findAllByText("D:/Agents/reviewer")).length).toBeGreaterThan(0);

  await user.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("button", { name: "编辑" })).toHaveFocus());

  await user.click(screen.getByRole("button", { name: "删除" }));
  expect(await screen.findByText("删除自定义 Agent")).toBeVisible();
  expect(facade.removeCustomAgent).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "确认删除" }));

  await waitFor(() => expect(facade.removeCustomAgent).toHaveBeenCalledWith("custom-reviewer"));
});

it("renders each discovered path as its own readable entry", async () => {
  const multiPath: AgentView = {
    ...agentFixture(),
    discoveredPaths: [
      "C:/Users/demo/AppData/Local/SkillHub/agents/codex/global skills directory",
      "/Users/demo/Library/Application Support/SkillHub/agents/codex/skills",
    ],
  };
  await renderDetailPage(facadeWith(multiPath));

  const paths = await screen.findByRole("list", { name: "已发现路径" });
  // DEV-5：Windows 形态路径经 displayPath 统一为反斜杠；POSIX 路径保持不变。
  expect(within(paths).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "C:\\Users\\demo\\AppData\\Local\\SkillHub\\agents\\codex\\global skills directory",
    "/Users/demo/Library/Application Support/SkillHub/agents/codex/skills",
  ]);
});

it("does not offer custom agent entries for discovered agents", async () => {
  await renderDetailPage(facadeWith(agentFixture()));

  expect(await screen.findByRole("heading", { name: /OpenAI/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
});

it("presents the brand as a branded tag in the header and identity facts", async () => {
  await renderDetailPage(facadeWith(agentFixture()));

  const heading = await screen.findByRole("heading", { name: /OpenAI/ });
  expect(heading.querySelector(".sh-brand-tag")).toHaveClass(
    "sh-brand-tag--openai",
  );

  const facts = screen.getByRole("region", { name: "Agent 身份" });
  expect(facts.querySelector(".sh-brand-tag")).toHaveClass(
    "sh-brand-tag--openai",
  );
});

it("renders two logical clients connected to one physical directory", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <RelationsView relations={agentFixture().relations} />
    </I18nextProvider>,
  );

  expect(screen.getAllByTestId("logical-target")).toHaveLength(2);
  expect(screen.getAllByTestId("physical-target")).toHaveLength(1);
});

it("renders the directory matrix beside the physical relations view", async () => {
  const overview: RelationshipOverview = {
    ...emptyOverview,
    directory_nodes: [{
      node_id: "node-shared",
      path: "C:/Users/demo/.agents/skills",
      path_key: "pk-shared",
      role: "shared_directory",
      profile_id: null,
      agent_client_id: null,
      exists: true,
      observed_at: "2026-09-15T00:00:00Z",
      scan_source: "profile",
    }],
    agent_directory_capabilities: [{
      agent_client_id: "Codex family",
      directory_node_id: "node-shared",
      recognition: "supported",
      precedence: "preferred",
      evidence_reference: "https://developers.openai.com/codex/skills",
      researched_at: "2026-09-01",
      applicable_platforms: ["windows"],
    }],
  };
  await renderDetailPage(facadeWith(agentFixture(), {
    getRelationshipOverview: vi.fn(async () => overview),
  }));

  expect(await screen.findByText("目录与关系")).toBeVisible();
  expect(screen.getAllByTestId("directory-card")).toHaveLength(1);
  // 路径同时出现在目录矩阵卡片和既有物理目录合并视图中。
  expect(screen.getAllByText("C:/Users/demo/.agents/skills").length).toBeGreaterThanOrEqual(1);
  // 物理目录合并展示（既有 RelationsView）保持不变，仍然出现。
  expect(screen.getAllByTestId("physical-target").length).toBeGreaterThan(0);
  // 目录识别不声明运行时加载事实。
  expect(screen.getByTestId("directory-matrix-execution-note")).toBeVisible();
});

it("keeps the rest of the detail page usable when relationship facts are unavailable", async () => {
  await renderDetailPage(facadeWith(agentFixture(), {
    getRelationshipOverview: vi.fn(async () => {
      throw new Error("relationship overview unavailable");
    }),
  }));

  expect(await screen.findByText("目录关系事实暂不可用。")).toBeVisible();
  // 其余页面区块不受影响。
  expect(screen.getByText("Agent 级忽略需要原生契约支持，暂未提供。")).toBeVisible();
});

// —— 任务 12C（12.7/12.14）：Agent 详情页顶层一次 Light check ——

function governanceLedgerRow(relationId: string): RelationGovernanceRow {
  return {
    relation: {
      kind: "deployment" as const,
      fact: {
        relation_id: relationId,
        skill_id: "skill-pdf",
        agent_client_id: "codex-cli",
        path: "C:/agents/codex-cli/skills/pdf-reader",
        path_key: "c:/agents/codex-cli/skills/pdf-reader",
        directory_node_id: null,
        relationship: "managed_copy" as const,
        file_representation: "copy" as const,
        ownership: "skillhub_managed" as const,
        link_target_path: null,
        link_target_path_key: null,
        link_target_directory_id: null,
        content_fingerprint: "sha256:aaa",
        origin: "import" as const,
        match_state: "content_verified" as const,
        active: true,
        observed_at: "1737600000000",
        released_at: null,
      },
    },
    skill_display_name: "PDF 阅读器",
    status: "normal" as const,
    readiness: "eligible_to_centralize" as const,
    primary_action: "centralize_management" as const,
    blockers: [],
    impact: {
      other_consumer_agent_ids: [],
      other_skill_paths: [],
      backup_required: true,
      rollback_available: true,
    },
  };
}

describe("AgentDetailPage context check (12C)", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("runs one light context check for the current agent at the top level", async () => {
    const governanceFacade = {
      listGovernance: vi.fn(async () => ({
        rows: [governanceLedgerRow("r-agent-dep-1")],
        counts: { all: 1, eligible_to_centralize: 0, needs_validation: 0, blocked: 0 },
        bucket: "all" as const,
        total: 1,
        relationship_revision: "rev-1",
        last_verified_at: null,
      })),
      revalidate: vi.fn(async () => ({ items: [], relationship_revision: "rev-2" })),
      listHistory: vi.fn(async () => ({
        items: [] as GovernanceHistoryEntry[],
        total: 0,
        page: 1,
        page_size: 5,
      })),
    } as unknown as RelationGovernanceFacade;
    await renderDetailPage(facadeWith(agentFixture()), governanceFacade);

    expect(await screen.findByText("已发现客户端和 Skill 目录")).toBeVisible();
    await waitFor(() => expect(governanceFacade.revalidate).toHaveBeenCalledTimes(1));
    expect(governanceFacade.revalidate).toHaveBeenCalledWith(["r-agent-dep-1"], "light");
    expect(
      sessionStorage.getItem(governanceContextCheckStorageKey("agent:Codex family")),
    ).toBe("1");
  });
});
