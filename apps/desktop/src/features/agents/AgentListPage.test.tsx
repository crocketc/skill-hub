import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { DirectoryPicker } from "../../platform/directoryPicker";
import { notifyDeploymentFactsChanged } from "../../platform/deploymentEvents";
import { createOperationTracker } from "../../platform/operationTracker";
import { buildAgentDirectoryCardModels, type AgentCardModel } from "./agentCardModel";
import { type AgentFacade, type AgentView } from "./api";
import { AgentListPage } from "./AgentListPage";

const pickingPicker: DirectoryPicker = {
  pickDirectory: vi.fn(async () => "D:/Agents/auditor"),
};

const agents: AgentView[] = [
  {
    brand: "OpenAI",
    client: "codex-cli",
    discoveredPaths: ["C:/Users/demo/.codex/skills"],
    id: "openai.codex-cli",
    instance: "Codex CLI",
    managedDeploymentCount: 2,
    managedDeploymentRelationCount: 5,
    officialReference: null,
    relations: [],
    status: "accessible",
  },
  {
    brand: "Acme",
    client: "custom",
    discoveredPaths: ["D:/Agents/reviewer"],
    id: "custom-reviewer",
    instance: "Reviewer",
    managedDeploymentCount: 0,
    managedDeploymentRelationCount: 0,
    officialReference: "https://acme.example/docs",
    relations: [],
    status: "custom",
  },
];

function facadeWith(overrides: Partial<AgentFacade> = {}): AgentFacade {
  return {
    get: async (id) => agents.find((agent) => agent.id === id) ?? agents[0],
    list: vi.fn(async () => agents),
    rescan: vi.fn(async () => undefined),
    createCustomAgent: vi.fn(async () => undefined),
    updateCustomAgent: vi.fn(async () => undefined),
    removeCustomAgent: vi.fn(async () => undefined),
    getRelationshipOverview: vi.fn(async () => {
      throw new Error("not used by the list page");
    }),
    getRelationshipRemovalImpact: vi.fn(async () => {
      throw new Error("not used by the list page");
    }),
    ...overrides,
  };
}

async function renderListPage(facade: AgentFacade, localeAgents?: AgentView[]) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <AgentListPage
          facade={localeAgents ? { ...facade, list: async () => localeAgents } : facade}
          picker={pickingPicker}
        />
      </I18nextProvider>
    </MemoryRouter>,
  );
}

it("refreshes directory card facts when a deployment commit broadcasts changed facts", async () => {
  // 卡片不展示 Skill/部署数量，但部署事实变化仍需触发卡片重新读取。
  const facade = facadeWith();
  renderListPage(facade);
  expect(await screen.findAllByTestId("agent-card")).toHaveLength(2);
  expect(screen.queryByText("2 个 Skill · 5 条部署关系")).not.toBeInTheDocument();
  expect(facade.list).toHaveBeenCalledTimes(1);

  notifyDeploymentFactsChanged();

  await waitFor(() => expect(facade.list).toHaveBeenCalledTimes(2));
});

it("merges directory-only clients into their brand card instead of standalone cards", async () => {
  // 无安装根目录的品牌不会出卡；已识别但技能目录待创建的类型不能和
  // 已验证物理目录合并，避免把不同候选身份误判成同一目录。
  const traeAgents: AgentView[] = [
    {
      brand: "Trae",
      client: "trae.code",
      discoveredPaths: ["C:/Users/demo/.trae-cn/skills"],
      id: "trae.code",
      instance: "TraeCode",
      managedDeploymentCount: 1,
      managedDeploymentRelationCount: 2,
      officialReference: null,
      relations: [],
      status: "accessible",
    },
    {
      brand: "Trae",
      client: "trae.work",
      discoveredPaths: [],
      id: "trae.work",
      instance: "TraeWork",
      managedDeploymentCount: 0,
      managedDeploymentRelationCount: 0,
      officialReference: null,
      relations: [],
      status: "directory_only",
    },
    {
      brand: "Lore",
      client: "lore.cli",
      discoveredPaths: [],
      id: "lore.cli",
      instance: "Lore CLI",
      managedDeploymentCount: 0,
      managedDeploymentRelationCount: 0,
      officialReference: null,
      relations: [],
      status: "directory_only",
    },
    {
      brand: "Lore",
      client: "lore.ide",
      discoveredPaths: [],
      id: "lore.ide",
      instance: "Lore IDE",
      managedDeploymentCount: 0,
      managedDeploymentRelationCount: 0,
      officialReference: null,
      relations: [],
      status: "directory_only",
    },
  ];

  await renderListPage(facadeWith(), traeAgents);

  expect((await screen.findAllByText("Trae")).length).toBeGreaterThan(0);
  expect(screen.getAllByText("Lore").length).toBeGreaterThan(0);
  expect(screen.getAllByTestId("agent-card")).toHaveLength(4);
  expect(screen.queryByText("仅发现相关目录")).not.toBeInTheDocument();
  expect(screen.queryByText("可访问")).not.toBeInTheDocument();
});

it("tiles every agent card in a single page-level grid", async () => {
  // 2026-09-25 验收反馈：按品牌分组渲染时每组的网格只剩一两张卡，
  // 页面仍是纵向堆叠。卡片自带品牌+类型标识，品牌分组标题冗余——
  // 整页一个网格平铺才真正减少滚动。
  await renderListPage(facadeWith());

  await screen.findAllByTestId("agent-card");
  expect(document.querySelectorAll(".sh-agents-page__cards")).toHaveLength(1);
  expect(document.querySelectorAll(".sh-agents-page__brand")).toHaveLength(0);
  const cards = screen.getAllByTestId("agent-card");
  expect(cards).toHaveLength(2);
  // 品牌键字母序与旧分组排序一致：Acme 卡在 OpenAI 卡之前。
  expect(cards[0].textContent).toContain("Acme");
  expect(cards[1].textContent).toContain("OpenAI");
  // 品牌标识随卡展示，不依赖分组标题。
  expect(document.querySelector(".sh-agent-card .sh-brand-tag--openai")).not.toBeNull();
});

it("renders built-in directories as separate read-only cards with guidance", async () => {
  // 2026-09-25 验收裁决：内置技能目录独立成卡。DEV-87（2026-09-25 反馈）：
  // 三标签融二——类型徽标保留，可访问状态徽标独占头部右侧；「内置」升级为
  // 差异色「内置 · 只读」徽标（政策入文案），提示段压缩为行动指引。
  const builtinAgents: AgentView[] = [
    {
      brand: "OpenAI",
      client: "codex-cli",
      discoveredPaths: ["C:/Users/demo/.codex/skills"],
      id: "openai.codex-cli",
      instance: "Codex CLI",
      managedDeploymentCount: 1,
      managedDeploymentRelationCount: 2,
      officialReference: null,
      relations: [],
      status: "accessible",
    },
    {
      brand: "OpenAI",
      client: "codex-cli",
      discoveredPaths: ["C:/Users/demo/.codex/skills/.system"],
      id: "openai.codex-cli.builtin",
      instance: "Codex CLI",
      managedDeploymentCount: 0,
      managedDeploymentRelationCount: 0,
      officialReference: null,
      relations: [],
      status: "accessible",
      builtin: true,
    },
  ];

  await renderListPage(facadeWith(), builtinAgents);

  expect((await screen.findAllByTestId("agent-card"))).toHaveLength(2);

  const card = screen.getAllByTestId("agent-card")[1];
  const badge = within(card).getByText("内置 · 只读");
  expect(badge).toBeVisible();
  // 差异色徽标挂在头部左侧（与品牌/类型同组），样式类锁定。
  expect(badge.closest(".sh-agent-card__head-main")).not.toBeNull();
  expect(badge.className).toContain("sh-agent-card__builtin");
  // 可访问状态徽标仍是头部直接子元素（右上角，与其他卡片一致）。
  const head = badge.closest(".sh-agent-card__head") as HTMLElement;
  expect(within(head).queryByText("可访问")).not.toBeInTheDocument();
  // 提示段压缩为行动指引，不再复述只读政策。
  expect(within(card).getByText(/手动管理/)).toBeVisible();
  expect(within(card).queryByText(/由平台自带管理/)).not.toBeInTheDocument();
});

it("refreshes discovery facts and keeps every agent visible", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();

  renderListPage(facade);

  expect((await screen.findAllByTestId("agent-card")).length).toBeGreaterThan(0);
  expect(screen.getAllByText("Acme").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: "OpenAI · 终端" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Acme · Agent" })).toBeVisible();
  expect(screen.queryByText("2 个 Skill · 5 条部署关系")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "重新扫描" }));

  await waitFor(() => expect(facade.rescan).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(facade.list).toHaveBeenCalledTimes(2));
});

it("records agent rescans in the unified operation tracker", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();
  const tracker = createOperationTracker();

  return render(
    <MemoryRouter>
      <I18nextProvider i18n={await createSkillHubI18n(["zh-CN"])}>
        <AgentListPage facade={facade} picker={pickingPicker} tracker={tracker} />
      </I18nextProvider>
    </MemoryRouter>,
  );

  await screen.findAllByTestId("agent-card");
  await user.click(screen.getByRole("button", { name: "重新扫描" }));

  await waitFor(() => expect(tracker.getSnapshot()[0]?.status).toBe("success"));
  expect(tracker.getSnapshot()[0]).toMatchObject({ kind: "agent_rescan", total: 1 });
});

it("keeps brand identity on each tiled card", async () => {
  renderListPage(facadeWith());

  await screen.findAllByTestId("agent-card");
  const openaiTag = document.querySelector(".sh-agent-card .sh-brand-tag--openai");
  expect(openaiTag).not.toBeNull();
  expect(screen.getAllByText("Acme").length).toBeGreaterThan(0);
});

it("aggregates duplicate deployment relations by unique skill per agent", async () => {
  const duplicated: AgentView[] = [
    { ...agents[0], managedDeploymentCount: 2, managedDeploymentRelationCount: 5 },
  ];
  const facade = facadeWith();

  renderListPage(facade, duplicated);

  expect(await screen.findAllByTestId("agent-card")).toHaveLength(1);
  expect(screen.queryByText("2 个 Skill · 5 条部署关系")).not.toBeInTheDocument();
});

it("merges same-brand agents on one directory and presents their platform types once", async () => {
  const sameDirectory: AgentView[] = [
    {
      ...agents[0],
      client: "codex-cli",
      id: "openai.codex-cli",
      instance: "Codex CLI",
    },
    {
      ...agents[0],
      client: "codex-desktop",
      id: "openai.codex-desktop",
      instance: "Codex Desktop",
    },
  ];

  const { container } = await renderListPage(facadeWith(), sameDirectory);

  expect(await screen.findByText("桌面端/终端")).toBeVisible();
  expect(container.querySelectorAll(".sh-agent-card")).toHaveLength(1);
  expect(screen.queryByText("codex-cli")).not.toBeInTheDocument();
  expect(screen.queryByText("codex-desktop")).not.toBeInTheDocument();
});

it("uses canonical directory cards for the native list while keeping the member detail route", async () => {
  const model: AgentCardModel = {
    ...buildAgentDirectoryCardModels({ directories: [{
      role: "agent_native",
      identity: { kind: "verified_physical", value: "physical-codex" },
      path: "C:/Users/demo/.codex/skills",
      status: "existing",
      exists: true,
      readable: true,
      writable: true,
      available: true,
      members: [
        {
          logical_target_id: "openai.codex-cli",
          brand: "OpenAI",
          client_id: "codex-cli",
          kind: "cli",
          availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
          capabilities: { deployment: { copy: true, symlink: true, junction: false }, modes: ["managed_copy", "symbolic_link"], preferred_mode: "symbolic_link" },
          deployment_status: "not_deployed",
          managed_deployment_relation_count: 0,
          managed_deployment_count: 0,
        },
        {
          logical_target_id: "openai.codex-desktop",
          brand: "OpenAI",
          client_id: "codex-desktop",
          kind: "desktop",
          availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
          capabilities: { deployment: { copy: true, symlink: false, junction: true }, modes: ["managed_copy", "directory_junction"], preferred_mode: "managed_copy" },
          deployment_status: "not_deployed",
          managed_deployment_relation_count: 0,
          managed_deployment_count: 0,
        },
      ],
    }] })[0]!,
  };
  const facade = facadeWith({
    listCardModels: vi.fn(async () => [model]),
    list: vi.fn(async () => { throw new Error("legacy list should not be used by canonical list page"); }),
  });

  renderListPage(facade);

  const card = await screen.findByTestId("agent-card");
  expect(within(card).getByRole("link", { name: "OpenAI · 桌面端 · 终端" })).toHaveAttribute(
    "href",
    "/agents/openai.codex-cli",
  );
  expect(within(card).getByLabelText("支持复制派发")).toBeVisible();
  expect(within(card).getByLabelText("不支持符号链接派发")).toBeVisible();
  expect(within(card).getByLabelText("不支持目录联接派发")).toBeVisible();
  expect(facade.listCardModels).toHaveBeenCalledOnce();
  expect(facade.list).not.toHaveBeenCalled();
});

it("offers an explicit custom agent creation entry with the filled values", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();

  renderListPage(facade);
  await screen.findAllByTestId("agent-card");

  await user.click(screen.getByRole("button", { name: "新增自定义 Agent" }));
  expect(await screen.findByText("自定义 Agent 只记录你选择的全局 Skill 目录，并标记为未验证自定义目标。")).toBeVisible();

  await user.type(screen.getByLabelText("显示名称"), "Auditor");
  await user.type(screen.getByLabelText("品牌"), "Beta");
  await user.type(screen.getByLabelText("官方参考链接"), "https://beta.example/docs");
  await user.click(screen.getByRole("button", { name: "选择目录" }));
  await screen.findByText("D:/Agents/auditor");

  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(facade.createCustomAgent).toHaveBeenCalledWith({
    brand: "Beta",
    displayName: "Auditor",
    directoryPath: "D:/Agents/auditor",
    referenceUrl: "https://beta.example/docs",
  }));
  await waitFor(() => expect(facade.list).toHaveBeenCalledTimes(2));
});

it("keeps custom agent editing inside the detail entry", async () => {
  const facade = facadeWith();

  renderListPage(facade);
  await screen.findAllByTestId("agent-card");

  const customItem = screen.getAllByTestId("agent-card")[0];
  if (!customItem) throw new Error("custom agent item missing");
  expect(within(customItem).getByRole("link", { name: "Acme · Agent" })).toHaveAttribute("href", "/agents/custom-reviewer");
  expect(within(customItem).queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
});

it("does not place custom agent removal on the card", async () => {
  const facade = facadeWith();

  renderListPage(facade);
  await screen.findAllByTestId("agent-card");

  const customItem = screen.getAllByTestId("agent-card")[0];
  if (!customItem) throw new Error("custom agent item missing");
  expect(within(customItem).queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
  expect(facade.removeCustomAgent).not.toHaveBeenCalled();
});

it("does not offer custom agent actions for discovered agents", async () => {
  const discoveredOnly: AgentView[] = [agents[0]];
  const facade = facadeWith();

  renderListPage(facade, discoveredOnly);
  await screen.findAllByTestId("agent-card");

  expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
});

it("keeps the rescan entry reachable when the agent facts cannot be read", async () => {
  const user = userEvent.setup();
  const facade = facadeWith({
    list: vi.fn(async () => {
      throw new Error("agent_list failed");
    }),
  });

  renderListPage(facade);

  expect(await screen.findByText("Agent 数据尚未连接到本机服务。")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "重新扫描" }));
  await waitFor(() => expect(facade.rescan).toHaveBeenCalledTimes(1));
});

it("states an explicit empty result instead of a blank page", async () => {
  renderListPage(facadeWith(), []);

  expect(await screen.findByText("尚未发现任何 Agent。可以重新扫描，或新增自定义 Agent。")).toBeVisible();
});

it("returns drawer focus to the trigger that opened it", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();

  renderListPage(facade);
  await screen.findAllByTestId("agent-card");

  await user.click(screen.getByRole("button", { name: "新增自定义 Agent" }));
  expect(await screen.findByRole("dialog")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "关闭" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "新增自定义 Agent" })).toHaveFocus());
});

it("keeps card actions limited to the detail link", async () => {
  const facade = facadeWith();

  renderListPage(facade);
  await screen.findAllByTestId("agent-card");

  const customItem = screen.getAllByTestId("agent-card")[0];
  if (!customItem) throw new Error("custom agent item missing");
  expect(within(customItem).getByRole("link", { name: "Acme · Agent" })).toHaveAttribute("href", "/agents/custom-reviewer");
});

it("shows shared-directory support on the brand card and keeps the shared card independent", async () => {
  const agents: AgentView[] = [
    {
      brand: "Pi",
      client: "pi.coding-agent",
      discoveredPaths: ["C:/Users/demo/.pi/agent/skills", "C:/Users/demo/.agents/skills"],
      id: "pi.coding-agent",
      instance: "Pi coding agent",
      managedDeploymentCount: 0,
      managedDeploymentRelationCount: 0,
      officialReference: null,
      relations: [],
      status: "accessible",
      kinds: ["cli"],
      sharedReferencePaths: ["C:/Users/demo/.agents/skills"],
      supportsSharedDirectory: true,
    },
    {
      brand: "Agent Skills",
      client: "shared-directory",
      discoveredPaths: ["C:/Users/demo/.agents/skills"],
      id: "agent-skills.shared-directory",
      instance: "Agent Skills",
      managedDeploymentCount: 0,
      managedDeploymentRelationCount: 0,
      officialReference: null,
      relations: [],
      status: "accessible",
      kinds: ["shared_directory"],
      sharedAgentBrands: ["Pi"],
    },
  ];

  await renderListPage(facadeWith(), agents);

  const cards = await screen.findAllByTestId("agent-card");
  const piCard = cards.find((card) => card.textContent?.includes("Pi")) as HTMLElement;
  // 共享目录卡：唯一仍展示 .agents\skills 具体路径的卡片。
  const sharedCard = cards.find((card) => /\.agents.{0,3}skills/i.test(card.textContent ?? "")) as HTMLElement;

  // 品牌卡只显示支持事实，不把共享目录作为合卡依据。
  expect(within(piCard).getByText("支持共享目录")).toBeVisible();
  expect(within(piCard).queryByText(/\.agents.{0,3}skills/i)).not.toBeInTheDocument();
  // 非共享路径照常展示。
  expect(within(piCard).getByText(/\.pi.{0,3}agent.{0,3}skills/i)).toBeInTheDocument();

  // 共享目录卡本体仍展示具体路径（全站唯一），不再叠加 chip。
  expect(within(sharedCard).getByText(/\.agents.{0,3}skills/i)).toBeInTheDocument();
  expect(within(sharedCard).queryByText("支持共享目录")).not.toBeInTheDocument();
  expect(within(sharedCard).getByText("Agent共享目录")).toBeVisible();
});
