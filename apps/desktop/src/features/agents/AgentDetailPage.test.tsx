import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { DirectoryPicker } from "../../platform/directoryPicker";
import { type AgentFacade, type AgentView, agentFixture, customAgentFixture } from "./api";
import { AgentDetailPage } from "./AgentDetailPage";
import { RelationsView } from "./RelationsView";

const pickingPicker: DirectoryPicker = {
  pickDirectory: vi.fn(async () => "D:/Agents/auditor"),
};

function facadeWith(agent: AgentView, overrides: Partial<AgentFacade> = {}): AgentFacade {
  return {
    get: vi.fn(async () => agent),
    list: vi.fn(async () => [agent]),
    rescan: vi.fn(async () => undefined),
    createCustomAgent: vi.fn(async () => undefined),
    updateCustomAgent: vi.fn(async () => undefined),
    removeCustomAgent: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function renderDetailPage(facade: AgentFacade) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <MemoryRouter initialEntries={["/agents/custom-reviewer"]}>
      <I18nextProvider i18n={i18n}>
        <AgentDetailPage agentId="custom-reviewer" facade={facade} picker={pickingPicker} />
      </I18nextProvider>
    </MemoryRouter>,
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

  await user.click(screen.getByRole("button", { name: "删除" }));
  expect(await screen.findByText("删除自定义 Agent")).toBeVisible();
  expect(facade.removeCustomAgent).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "确认删除" }));

  await waitFor(() => expect(facade.removeCustomAgent).toHaveBeenCalledWith("custom-reviewer"));
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
