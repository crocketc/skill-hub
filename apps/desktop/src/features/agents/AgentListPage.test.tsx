import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { AgentFacade, AgentView } from "./api";
import { AgentListPage } from "./AgentListPage";

const agents: AgentView[] = [
  {
    brand: "OpenAI",
    client: "codex-cli",
    discoveredPaths: ["C:/Users/demo/.codex/skills"],
    id: "openai.codex-cli",
    instance: "Codex CLI",
    managedDeploymentCount: 2,
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
    relations: [],
    status: "custom",
  },
];

it("groups agents by brand and refreshes the real discovery facts", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade: AgentFacade = {
    get: async (id) => agents.find((agent) => agent.id === id) ?? agents[0],
    list: vi.fn(async () => agents),
    rescan: vi.fn(async () => undefined),
  };

  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <AgentListPage facade={facade} />
      </I18nextProvider>
    </MemoryRouter>,
  );

  expect(await screen.findByRole("heading", { name: "OpenAI" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Acme" })).toBeVisible();
  expect(screen.getByText("可访问")).toBeVisible();
  expect(screen.getByText("自定义 Agent")).toBeVisible();
  expect(screen.getByText("2 个受管部署")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "重新扫描" }));

  await waitFor(() => expect(facade.rescan).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(facade.list).toHaveBeenCalledTimes(2));
});
