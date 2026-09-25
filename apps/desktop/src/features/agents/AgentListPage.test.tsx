import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { DirectoryPicker } from "../../platform/directoryPicker";
import { notifyDeploymentFactsChanged } from "../../platform/deploymentEvents";
import { createOperationTracker } from "../../platform/operationTracker";
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

it("refreshes the card counts when a deployment commit broadcasts changed facts", async () => {
  // DEV-22：部署提交成功后 Agent 页此前收不到任何通知，卡片计数停在旧值。
  // 现在监听部署事实广播并重读列表。
  const facade = facadeWith();
  renderListPage(facade);
  expect(await screen.findByText("2 个 Skill · 5 条部署关系")).toBeVisible();
  expect(facade.list).toHaveBeenCalledTimes(1);

  notifyDeploymentFactsChanged();

  await waitFor(() => expect(facade.list).toHaveBeenCalledTimes(2));
});

it("merges directory-only clients into their brand card instead of standalone cards", async () => {
  // 验收反馈（2026-09-25）：仅发现相关目录（directory_only）的客户端
  // 不应单独出卡；同品牌已有目录卡时并入并合并类型徽标，整品牌都无目录
  // 时也只出一张卡。
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
  expect(screen.getAllByTestId("agent-card")).toHaveLength(2);
  // Trae 卡并入 trae.work 后仍如实展示可用；Lore 整品牌无目录，合并为
  // 一张卡并保留诚实的「仅发现相关目录」状态。
  expect(screen.getAllByText("仅发现相关目录")).toHaveLength(1);
  expect(screen.getByText("可访问")).toBeVisible();
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
  expect(within(head).getAllByText("可访问")).toHaveLength(1);
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
  expect(screen.getByText("可访问")).toBeVisible();
  expect(screen.getByText("自定义 Agent")).toBeVisible();
  expect(screen.getByText("2 个 Skill · 5 条部署关系")).toBeVisible();

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

  expect(await screen.findByText("2 个 Skill · 5 条部署关系")).toBeVisible();
  expect(screen.queryByText(/5 个受管部署/)).not.toBeInTheDocument();
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

it("edits a custom agent through its list entry with prefilled values", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();

  renderListPage(facade);
  await screen.findAllByTestId("agent-card");

  const customItem = screen.getAllByTestId("agent-card")[0];
  if (!customItem) throw new Error("custom agent item missing");
  await user.click(within(customItem).getByRole("button", { name: "编辑" }));

  expect(await screen.findByDisplayValue("Reviewer")).toBeVisible();
  expect(await screen.findByDisplayValue("https://acme.example/docs")).toBeVisible();
  expect((await screen.findAllByText("编辑自定义 Agent")).length).toBeGreaterThan(0);

  await user.clear(screen.getByLabelText("显示名称"));
  await user.type(screen.getByLabelText("显示名称"), "Reviewer 2");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(facade.updateCustomAgent).toHaveBeenCalledWith("custom-reviewer", {
    brand: "Acme",
    displayName: "Reviewer 2",
    directoryPath: "D:/Agents/reviewer",
    referenceUrl: "https://acme.example/docs",
  }));
});

it("removes a custom agent only after explicit confirmation", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();

  renderListPage(facade);
  await screen.findAllByTestId("agent-card");

  const customItem = screen.getAllByTestId("agent-card")[0];
  if (!customItem) throw new Error("custom agent item missing");
  await user.click(within(customItem).getByRole("button", { name: "删除" }));

  expect(await screen.findByText("删除自定义 Agent")).toBeVisible();
  expect(facade.removeCustomAgent).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "确认删除" }));

  await waitFor(() => expect(facade.removeCustomAgent).toHaveBeenCalledWith("custom-reviewer"));
  await waitFor(() => expect(facade.list).toHaveBeenCalledTimes(2));
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

it("returns drawer focus to the card edit trigger after editing", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();

  renderListPage(facade);
  await screen.findAllByTestId("agent-card");

  const customItem = screen.getAllByTestId("agent-card")[0];
  if (!customItem) throw new Error("custom agent item missing");
  await user.click(within(customItem).getByRole("button", { name: "编辑" }));
  expect(await screen.findByRole("dialog")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "关闭" }));

  await waitFor(() => expect(within(customItem).getByRole("button", { name: "编辑" })).toHaveFocus());
});

// DEV-88（2026-09-25 验收反馈）：品牌卡上 shared_reference 的 .agents\skills
// 路径行渲染为「支持共享目录」chip（可点击定位共享目录卡），具体路径只在
// 共享目录卡展示一次；非共享路径不受影响。
it("replaces shared-reference path rows with a shared-directory chip", async () => {
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
    },
  ];

  await renderListPage(facadeWith(), agents);

  const cards = await screen.findAllByTestId("agent-card");
  const piCard = cards.find((card) => card.textContent?.includes("Pi")) as HTMLElement;
  // 共享目录卡：唯一仍展示 .agents\skills 具体路径的卡片。
  const sharedCard = cards.find((card) => /\.agents.{0,3}skills/i.test(card.textContent ?? "")) as HTMLElement;

  // 品牌卡：共享路径行替换为 chip，chip 指向共享目录卡。
  const chip = within(piCard).getByRole("link", { name: "支持共享目录" });
  expect(chip).toHaveAttribute("href", "/agents/agent-skills.shared-directory");
  expect(within(piCard).queryByText(/\.agents.{0,3}skills/i)).not.toBeInTheDocument();
  // 非共享路径照常展示。
  expect(within(piCard).getByText(/\.pi.{0,3}agent.{0,3}skills/i)).toBeInTheDocument();

  // 共享目录卡本体仍展示具体路径（全站唯一），不再叠加 chip。
  expect(within(sharedCard).getByText(/\.agents.{0,3}skills/i)).toBeInTheDocument();
  expect(within(sharedCard).queryByRole("link", { name: "支持共享目录" })).not.toBeInTheDocument();
});
