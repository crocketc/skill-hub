import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { DirectoryPicker } from "../../platform/directoryPicker";
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

it("groups agents by brand and refreshes the real discovery facts", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();

  renderListPage(facade);

  expect(await screen.findByRole("heading", { name: "OpenAI" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Acme" })).toBeVisible();
  expect(screen.getByText("可访问")).toBeVisible();
  expect(screen.getByText("自定义 Agent")).toBeVisible();
  expect(screen.getByText("2 个 Skill · 5 条部署关系")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "重新扫描" }));

  await waitFor(() => expect(facade.rescan).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(facade.list).toHaveBeenCalledTimes(2));
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

it("offers an explicit custom agent creation entry with the filled values", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();

  renderListPage(facade);
  await screen.findByRole("heading", { name: "OpenAI" });

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
  await screen.findByRole("heading", { name: "Acme" });

  const customItem = screen.getByText("Reviewer").closest("li");
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
  await screen.findByRole("heading", { name: "Acme" });

  const customItem = screen.getByText("Reviewer").closest("li");
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
  await screen.findByRole("heading", { name: "OpenAI" });

  expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
});
