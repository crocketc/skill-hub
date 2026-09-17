import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, vi } from "vitest";
import type {
  BootstrapSnapshot,
  ConflictWorkspace,
  SkillRelationshipCandidate,
} from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import type { RelationshipsFacade } from "../relationships/api";
import baseCss from "../../styles/base.css?raw";
import { ThemeProvider } from "../../styles/ThemeProvider";
import overviewCss from "./overview.css?raw";
import tagRuntime from "./TagDistributionChartRuntime.tsx?raw";
import { OverviewPage } from "./OverviewPage";

const overviewSnapshot: BootstrapSnapshot = {
  initialization_state: "initialized",
  library_path: "C:\\Users\\Test\\SkillHub",
  onboarding_skipped: false,
  agent_count: 3,
  discovered_agent_count: 5,
  deployed_count: 18,
  deployment_categories: [
    { count: 12, dimension: "agent", key: "openai.codex-cli", label_code: "Codex" },
    { count: 3, dimension: "agent", key: "anthropic.claude-code", label_code: "Claude Code" },
    { count: 3, dimension: "project", key: "project-aurora", label_code: "Aurora" },
  ],
  tag_categories: [
    { key: "writing", count: 5 },
    { key: "pdf", count: 2 },
  ],
  last_scan_at: null,
  pending: { by_kind: { recovery: 1, security_finding: 2, trial_due: 1 }, total: 4 },
  project_count: 2,
  recent_operations: [
    {
      created_at: "2026-08-24T08:00:00Z",
      error_code: null,
      kind: "Should not display",
      operation_id: "operation-1",
      phase: "committed",
      state: "completed",
    },
  ],
  recovery_state: "clean",
  skill_count: 12,
};

const manyProjectCategories = Array.from({ length: 12 }, (_, index) => ({
  count: 12 - index,
  dimension: "project" as const,
  key: `project-${index + 1}`,
  label_code: `Project ${index + 1}`,
}));

function conflictCase(conflictId: string) {
  return {
    case: {
      classification: "uncertain" as const,
      conflict_id: conflictId,
      evidence: { fingerprints_match: null, names_match: true, sufficient_identity_evidence: false },
      member_skill_ids: [],
    },
    latest_analysis: null,
    analysis_stale: false,
    recommended_decision: null,
  };
}

/** 任务 2 冻结投影：cases=待确认全集（2），handled 是历史、不回流计数。 */
const populatedConflictWorkspace: ConflictWorkspace = {
  cases: [conflictCase("conflict-1"), conflictCase("conflict-2")],
  handled_count: 1,
  handled: [
    {
      conflict_id: "conflict-0",
      decision: "keep_distinct",
      conclusion: "distinct_skill",
      decided_at: "2026-09-01T00:00:00Z",
    },
  ],
  relationship_revision: "7",
  last_verified_at: null,
};

/** 确定性关系门面：图谱候选 2、待确认冲突 2、治理关系边 7。 */
const populatedRelationshipsFacade: RelationshipsFacade = {
  async listCandidates() {
    return [
      {
        display_name: "Writer",
        last_verified_at: null,
        matched_alias: null,
        relationship_count: 2,
        relationship_revision: "7",
        runtime_name: "writer",
        skill_id: "skill-writer" as SkillRelationshipCandidate["skill_id"],
        tags: [],
      },
      {
        display_name: "Reader",
        last_verified_at: null,
        matched_alias: null,
        relationship_count: 1,
        relationship_revision: "7",
        runtime_name: "reader",
        skill_id: "skill-reader" as SkillRelationshipCandidate["skill_id"],
        tags: [],
      },
    ];
  },
  async getGraph() {
    throw new Error("the overview never renders a full graph");
  },
  async getConflictWorkspace() {
    return populatedConflictWorkspace;
  },
  async listGovernance() {
    return {
      bucket: "all" as const,
      counts: { all: 7, blocked: 1, eligible_to_centralize: 4, needs_validation: 2 },
      last_verified_at: null,
      relationship_revision: "7",
      rows: [],
      total: 7,
    };
  },
};

/** 零关系事实门面：三个来源全空但查询成功（真实空态，不是失败）。 */
const emptyRelationshipsFacade: RelationshipsFacade = {
  async listCandidates() {
    return [];
  },
  async getGraph() {
    throw new Error("the overview never renders a full graph");
  },
  async getConflictWorkspace() {
    return { ...populatedConflictWorkspace, cases: [], handled: [], handled_count: 0 };
  },
  async listGovernance() {
    return {
      bucket: "all" as const,
      counts: { all: 0, blocked: 0, eligible_to_centralize: 0, needs_validation: 0 },
      last_verified_at: null,
      relationship_revision: "7",
      rows: [],
      total: 0,
    };
  },
};

/** 永不结算的门面：锁定加载中的诚实占位。 */
const pendingRelationshipsFacade: RelationshipsFacade = {
  listCandidates() {
    return new Promise(() => undefined);
  },
  async getGraph() {
    throw new Error("the overview never renders a full graph");
  },
  getConflictWorkspace() {
    return new Promise(() => undefined);
  },
  listGovernance() {
    return new Promise(() => undefined);
  },
};

/** 三个关系查询全部失败的门面：概览其余内容必须照常。 */
const failingRelationshipsFacade: RelationshipsFacade = {
  async listCandidates() {
    throw new Error("ipc unavailable");
  },
  async getGraph() {
    throw new Error("the overview never renders a full graph");
  },
  async getConflictWorkspace() {
    throw new Error("ipc unavailable");
  },
  async listGovernance() {
    throw new Error("ipc unavailable");
  },
};

function LocationDisplay() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function OverviewRoute({ snapshot }: { snapshot: BootstrapSnapshot }) {
  return <Outlet context={{ refreshSnapshot: async () => undefined, snapshot }} />;
}

function mockBrowserPreferences() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? false : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

async function renderOverview(
  snapshot = overviewSnapshot,
  facade: RelationshipsFacade = populatedRelationshipsFacade,
) {
  const i18n = await createSkillHubI18n(["en-US"]);
  mockBrowserPreferences();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route element={<OverviewRoute snapshot={snapshot} />}>
                <Route index element={<OverviewPage relationshipsFacade={facade} />} />
                <Route path="agents" element={<LocationDisplay />} />
                <Route path="agents/:agentKey" element={<LocationDisplay />} />
                <Route path="projects/:projectKey" element={<LocationDisplay />} />
                <Route path="library" element={<LocationDisplay />} />
                <Route path="discovery/local" element={<LocationDisplay />} />
                <Route path="pending" element={<LocationDisplay />} />
                <Route path="relationships" element={<LocationDisplay />} />
                <Route path="relationships/decisions" element={<LocationDisplay />} />
                <Route path="relationships/governance" element={<LocationDisplay />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>,
  );

  // 让关系查询的解析（成功/失败，或永不结算的 pending 桩）在 act 内落地，
  // 避免测试结束后出现 "not wrapped in act" 警告。
  await act(async () => {});
  await act(async () => {});
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});

it("drills down into the library filtered by tag from the overview", async () => {
  await renderOverview();

  const tagList = await screen.findByRole("list", { name: "Skill count by tag" });
  const link = within(tagList).getByRole("button", { name: "View 5 skills tagged writing" });
  fireEvent.click(link);

  expect(screen.getByTestId("location")).toHaveTextContent("/library?tag=writing");
});

it("keeps configured and discovered agent calibers distinct inside the combined frozen metric", async () => {
  await renderOverview();

  // 冻结指标把两个口径并列在同一条指标名里（已配置 3 · 已发现 5），不再是
  // 两条独立钻取；口径仍分开命名、分开计数，不混用。
  expect(
    await screen.findByRole("link", { name: "3 Agents (3 configured · 5 discovered)" }),
  ).toBeVisible();
  expect(screen.queryByRole("link", { name: "5 discovered agents" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "3 configured agents" })).not.toBeInTheDocument();
});

it("drills the combined agent metric into the agent management workspace", async () => {
  await renderOverview();

  // 冻结契约：合并后的 Agent 指标统一去 /agents 管理已登记部署目标。
  const agentMetric = screen.getByRole("link", { name: "3 Agents (3 configured · 5 discovered)" });
  expect(agentMetric).toHaveAttribute("href", "/agents");

  fireEvent.click(agentMetric);

  expect(screen.getByTestId("location")).toHaveTextContent("/agents");
});

it("links every pending summary item to the pending workbench", async () => {
  await renderOverview();

  const findingLink = screen.getByRole("link", { name: "2 security findings" });
  expect(findingLink).toHaveAttribute("href", "/pending");
  expect(screen.getByRole("link", { name: "1 recovery action" })).toHaveAttribute(
    "href",
    "/pending",
  );
  expect(screen.getByRole("link", { name: "1 trial due" })).toHaveAttribute("href", "/pending");

  fireEvent.click(findingLink);

  expect(screen.getByTestId("location")).toHaveTextContent("/pending");
});

it("renders each compact stat as a two-line card with a numeric figure and a metric name", async () => {
  await renderOverview();

  // 冲突指标计数来自异步的关系投影；等它落地后再锁定整条指标带。
  await screen.findByRole("link", { name: "Open conflict workspace (2 unconfirmed conflicts)" });

  // 密度结构：数字与指标名是两个可寻址元素，可访问名称仍由二者组成。
  const statsList = screen.getByRole("list", { name: "Key stats" });
  const compactStats = [
    ["3", "Agents (3 configured · 5 discovered)"],
    ["2", "Manage projects"],
    ["18", "Skill deployment relations (15 to agents · 3 to projects)"],
    ["2", "Unconfirmed relationship conflicts"],
  ] as const;
  for (const [count, name] of compactStats) {
    const stat = within(statsList).getByRole("link", { name: `${count} ${name}` });
    expect(within(stat).getByText(count, { exact: true })).toBeVisible();
    expect(within(stat).getByText(name)).toBeVisible();
  }

  const hero = screen.getByRole("link", { name: "12 Total skills" });
  expect(within(hero).getByText("12", { exact: true })).toBeVisible();
  expect(within(hero).getByText("Total skills")).toBeVisible();
});

it("locks the density ladder and the two-row metrics contract in overview.css", () => {
  // 注意：本用例以正则匹配 CSS 源文本锁定布局契约（团队既有模式）。重排
  // overview.css / base.css（含 prettier 空格换行差异）时需同步更新这些断言。
  // 比例阶梯：hero ≥ 7rem，紧凑卡 ≥ 5rem，图表区承担视口剩余高度。
  const heroRule = overviewCss.match(/\.sh-overview__hero\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(heroRule).toContain("min-height: 5rem");
  const statRule = overviewCss.match(/\.sh-overview__stat\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(statRule).toContain("min-height: 5rem");
  expect(overviewCss).toContain("grid-auto-rows: minmax(5rem, 1fr)");

  // M-20 两行指标契约：宽容器下 hero 独占第一行（跨全部 4 列），紧凑统计
  // 通过 display:contents 落到第二行；禁止 hero+统计并入单行 5 卡横带。
  expect(overviewCss).toMatch(
    /@container workspace \(min-width: 60rem\) \{[\s\S]*?\.sh-overview \.sh-overview__metrics \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/,
  );
  expect(overviewCss).toMatch(
    /@container workspace \(min-width: 60rem\) \{[\s\S]*?\.sh-overview \.sh-overview__hero \{[\s\S]*?grid-column: 1 \/ -1/,
  );
  expect(overviewCss).toMatch(
    /@container workspace \(min-width: 60rem\) \{[\s\S]*?\.sh-overview \.sh-overview__stats \{[\s\S]*?display: contents/,
  );
  expect(overviewCss).not.toMatch(/\.sh-overview__stats\s*\{[^}]*repeat\(4/);
  expect(overviewCss).not.toMatch(/grid-template-columns: minmax\(0, 1\.35fr\) repeat\(4/);
});

it("keeps the relationship band inside the fill grid so 100% zoom keeps the outer shell still", () => {
  // jsdom 量不出滚动条：按团队既有模式锁定 CSS 源契约——概览网格必须是
  // 「auto / 剩余高度 / auto」三行，关系带占固定 auto 行、三卡单行排布且
  // 自身可压缩（min-height: 0），不得把外层 PageFrame 撑出滚动。
  // 真实几何验收（1280×900 纵向无滚动条）由 Task 10 的概览 e2e 承担。
  expect(overviewCss).toMatch(
    /\.sh-overview\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/,
  );
  expect(overviewCss).toMatch(
    /\.sh-overview__relations\s*\{[^}]*min-height:\s*0/,
  );
  expect(overviewCss).toMatch(
    /\.sh-overview__relations-list\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/,
  );
});

it("contains overlong relationship thumbnail labels inside their cards", () => {
  const relationRule = overviewCss.match(/\.sh-overview__relation\s*\{([^}]*)\}/)?.[1] ?? "";
  const labelRule = overviewCss.match(/\.sh-overview__relation-name\s*\{([^}]*)\}/)?.[1] ?? "";

  expect(relationRule).toContain("max-width: 100%");
  expect(relationRule).toContain("overflow-wrap: anywhere");
  expect(labelRule).toContain("min-width: 0");
  expect(labelRule).toContain("overflow-wrap: anywhere");
});

it("renders the tag distribution in a fixed chart panel with a text equivalent", async () => {
  await renderOverview();

  expect(screen.getByRole("img", { name: "Skill count by tag chart" })).toBeVisible();
  expect(screen.getByRole("list", { name: "Skill count by tag" })).toBeVisible();
});

it("assigns an explicit palette color to every tag slice", () => {
  expect(tagRuntime).toContain("palette.chartColors[index % palette.chartColors.length]");
});

it("keeps a single page-level h1 for the overview heading outline", async () => {
  // T3-C「每路由唯一 h1」：顶栏标题已降级为非 heading，route-level h1 由
  // 页面自持（任务 10 h1 sweep 把概览页头升回 level 1）。
  await renderOverview();

  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
});

it("promotes a single primary metric and turns the rest into compact stats", async () => {
  await renderOverview();

  const hero = screen.getByRole("link", { name: "12 Total skills" });
  expect(hero).toHaveAttribute("href", "/library");
  expect(within(hero).getByText("12", { exact: true })).toBeVisible();

  // 等关系投影落地，冲突指标的链接才出现（占位阶段不提供钻取）。
  await screen.findByRole("link", { name: "Open conflict workspace (2 unconfirmed conflicts)" });

  const statsList = screen.getByRole("list", { name: "Key stats" });
  const compactHrefs = [
    ["3 Agents (3 configured · 5 discovered)", "/agents"],
    ["2 Manage projects", "/projects"],
    [
      "18 Skill deployment relations (15 to agents · 3 to projects)",
      "/library?deployment=deployed",
    ],
    ["2 Unconfirmed relationship conflicts", "/relationships/decisions"],
  ] as const;
  for (const [name, href] of compactHrefs) {
    const stat = within(statsList).getByRole("link", { name });
    expect(stat).toHaveAttribute("href", href);
  }
  expect(screen.getAllByRole("link", { name: "12 Total skills" })).toHaveLength(1);
});

it("fuses the relationship thumbnail network below the charts without replacing them", async () => {
  await renderOverview();

  // 既有内容一格不少：柱状图、标签饼图、待办摘要、指标带全部保留。
  expect(
    await screen.findByRole("img", { name: "Deployment relation count by agent" }),
  ).toBeVisible();
  expect(screen.getByRole("list", { name: "Skill count by tag" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "4 pending items" })).toBeVisible();
  expect(screen.getByRole("link", { name: "12 Total skills" })).toBeVisible();

  // 关系缩略网络作为组织/关系区域进入页面，三个入口带冻结口径计数。
  const relations = screen.getByRole("region", { name: "Skill relationships" });
  expect(
    within(relations).getByRole("link", {
      name: "Open relationship graph (2 skills with displayable relations)",
    }),
  ).toBeVisible();
  expect(
    within(relations).getByRole("link", { name: "Open conflict workspace (2 unconfirmed conflicts)" }),
  ).toBeVisible();
  expect(
    within(relations).getByRole("link", {
      name: "Open relationship governance (7 relation edges)",
    }),
  ).toBeVisible();
});

it("deep-links the three relationship entries into their subpages", async () => {
  await renderOverview();

  expect(
    await screen.findByRole("link", {
      name: "Open relationship graph (2 skills with displayable relations)",
    }),
  ).toHaveAttribute("href", "/relationships");
  expect(
    screen.getByRole("link", { name: "Open conflict workspace (2 unconfirmed conflicts)" }),
  ).toHaveAttribute("href", "/relationships/decisions");
  expect(
    screen.getByRole("link", { name: "Open relationship governance (7 relation edges)" }),
  ).toHaveAttribute("href", "/relationships/governance");

  fireEvent.click(screen.getByRole("link", { name: "Open relationship graph (2 skills with displayable relations)" }));

  expect(screen.getByTestId("location")).toHaveTextContent("/relationships");
});

it("counts overview conflicts from the workspace projection instead of recomputing", async () => {
  await renderOverview();

  // 指标带与缩略入口都消费任务 2 投影的 cases（2 条待确认）；
  // handled 历史（1 条）不出现在任何计数里。
  expect(
    await screen.findByRole("link", { name: "2 Unconfirmed relationship conflicts" }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open conflict workspace (2 unconfirmed conflicts)" }),
  ).toBeVisible();
  expect(screen.queryByRole("link", { name: "3 Unconfirmed relationship conflicts" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Open conflict workspace (3 unconfirmed conflicts)" }),
  ).not.toBeInTheDocument();
});

it("renders the empty relationship state without swallowing charts or todo", async () => {
  await renderOverview(overviewSnapshot, emptyRelationshipsFacade);

  // 空态：三个 0 计数入口照常渲染，并给出中性说明。
  expect(
    await screen.findByRole("link", {
      name: "Open relationship graph (0 skills with displayable relations)",
    }),
  ).toBeVisible();
  expect(screen.getByText("No relationship facts to display yet.")).toBeVisible();

  // 空关系状态不吞没既有概览内容。
  expect(
    screen.getByRole("img", { name: "Deployment relation count by agent" }),
  ).toBeVisible();
  expect(screen.getByRole("list", { name: "Skill count by tag" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "4 pending items" })).toBeVisible();
  expect(screen.getByRole("link", { name: "12 Total skills" })).toBeVisible();
});

it("withholds relationship counts behind placeholders while the summaries load", async () => {
  await renderOverview(overviewSnapshot, pendingRelationshipsFacade);

  // 加载中不显示假 0：指标带冲突项与三个入口都用占位符。
  expect(await screen.findByRole("region", { name: "Skill relationships" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(screen.getAllByText("–")).toHaveLength(4);
  expect(screen.queryByRole("link", { name: /unconfirmed conflicts/i })).not.toBeInTheDocument();

  // 同步内容不受关系查询影响。
  expect(
    screen.getByRole("img", { name: "Deployment relation count by agent" }),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "4 pending items" })).toBeVisible();
});

it("explains unavailable relationship summaries without hiding the overview", async () => {
  await renderOverview(overviewSnapshot, failingRelationshipsFacade);

  expect(
    await screen.findByText("Relationship overview is temporarily unavailable."),
  ).toBeVisible();
  expect(screen.queryByRole("link", { name: /unconfirmed conflicts/i })).not.toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "Deployment relation count by agent" }),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "4 pending items" })).toBeVisible();
});

it("renders proportional agent deployments with a visible text equivalent and drills into its deployment workspace", async () => {
  await renderOverview();

  expect(await screen.findByRole("img", { name: "Deployment relation count by agent" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "View Codex's 12 deployment relations" }),
  ).toHaveTextContent("Codex 12");
  expect(
    screen.getByRole("button", { name: "View Claude Code's 3 deployment relations" }),
  ).toHaveTextContent("Claude Code 3");
  expect(screen.getByRole("list", { name: "Deployment relation count details" })).toHaveTextContent(
    "Codex 12Claude Code 3",
  );

  fireEvent.click(screen.getByRole("button", { name: "View Codex's 12 deployment relations" }));

  expect(screen.getByTestId("location")).toHaveTextContent(
    "/agents/openai.codex-cli?view=deployments",
  );
});

it("switches to project relationships and drills into the truthful project destination", async () => {
  await renderOverview();

  fireEvent.click(screen.getByRole("radio", { name: "Projects" }));

  expect(await screen.findByRole("img", { name: "Deployment relation count by project" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "View Aurora's 3 deployment relations" }),
  ).toHaveTextContent("Aurora 3");
  fireEvent.click(screen.getByRole("button", { name: "View Aurora's 3 deployment relations" }));

  expect(screen.getByTestId("location")).toHaveTextContent(
    "/projects/project-aurora?view=deployments",
  );
});

it("keeps deployment details in the fixed main panel while the rail stays reserved for tags and pending work", async () => {
  await renderOverview({
    ...overviewSnapshot,
    deployment_categories: [
      ...overviewSnapshot.deployment_categories.filter(({ dimension }) => dimension === "agent"),
      ...manyProjectCategories,
    ],
    project_count: 12,
  });

  fireEvent.click(screen.getByRole("radio", { name: "Projects" }));

  const detailRegion = screen.getByRole("region", { name: "Deployment relation count details" });
  expect(detailRegion.parentElement).toHaveClass("sh-overview__panel");
  expect(within(detailRegion).getAllByRole("button", { name: /View Project/ })).toHaveLength(12);
  expect(
    within(detailRegion).getByRole("region", { name: "Scrollable deployment relation details" }),
  ).toHaveAttribute("tabindex", "0");
  expect(screen.getByText("Showing the top 10 of 12 projects")).toBeVisible();
  expect(document.querySelector(".sh-overview__panel .sh-overview__chart-list")).not.toBeNull();
});

it("shows the pending summary without exposing the recent-operation log", async () => {
  await renderOverview();

  expect(screen.getByRole("link", { name: "12 Total skills" })).toBeVisible();
  // 等关系投影落地后再锁定指标带上的冲突项。
  await screen.findByRole("link", { name: "Open conflict workspace (2 unconfirmed conflicts)" });
  const statsList = screen.getByRole("list", { name: "Key stats" });
  expect(within(statsList).getByRole("link", { name: "3 Agents (3 configured · 5 discovered)" })).toBeVisible();
  expect(within(statsList).getByRole("link", { name: "2 Manage projects" })).toBeVisible();
  expect(
    within(statsList).getByRole("link", {
      name: "18 Skill deployment relations (15 to agents · 3 to projects)",
    }),
  ).toBeVisible();
  expect(
    within(statsList).getByRole("link", { name: "2 Unconfirmed relationship conflicts" }),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "4 pending items" })).toBeVisible();
  expect(screen.getByText("2 security findings")).toBeVisible();
  expect(screen.getByText("1 recovery action")).toBeVisible();
  expect(screen.getByText("1 trial due")).toBeVisible();
  expect(screen.queryByText("Should not display")).not.toBeInTheDocument();
});

it("explains when the selected deployment dimension has no relationships", async () => {
  await renderOverview({
    ...overviewSnapshot,
    deployment_categories: [],
    pending: { by_kind: {}, total: 0 },
  });

  expect(screen.getByRole("status")).toHaveTextContent("No deployment relationships by agent yet");
  expect(screen.queryByRole("img", { name: "Deployment relation count by agent" })).not.toBeInTheDocument();
  expect(screen.getByText("No pending items")).toBeVisible();
});

it("keeps empty and zero-count states legible in the redesigned overview", async () => {
  await renderOverview({
    ...overviewSnapshot,
    agent_count: 0,
    deployment_categories: [],
    discovered_agent_count: 0,
    pending: { by_kind: {}, total: 0 },
  });

  const statsList = screen.getByRole("list", { name: "Key stats" });
  expect(
    within(statsList).getByRole("link", { name: "0 Agents (0 configured · 0 discovered)" }),
  ).toBeVisible();
  expect(
    within(statsList).getByRole("link", {
      name: "0 Skill deployment relations (0 to agents · 0 to projects)",
    }),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "12 Total skills" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("No deployment relationships by agent yet");
  expect(screen.getByRole("heading", { name: "No pending items" })).toBeVisible();
  expect(screen.getByText("All clear")).toBeVisible();
});

it("keeps the desktop overview grid at smaller window widths instead of switching to one column", () => {
  const compactOverviewRule = baseCss.match(/@media \(max-width: 72rem\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

  expect(compactOverviewRule).not.toContain(".sh-overview__metrics");
  expect(compactOverviewRule).not.toContain(".sh-overview__content-grid");
  expect(baseCss).toMatch(/\.sh-overview__content-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) clamp\(/);
});
