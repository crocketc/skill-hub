import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { projectFixture } from "./api";
import { BestEffortAssembly } from "./BestEffortAssembly";
import { ProjectDetailPage } from "./ProjectDetailPage";

it("keeps satisfied, skipped, conflict and failed assembly entries visible", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <BestEffortAssembly items={projectFixture().assembly} />
    </I18nextProvider>,
  );

  expect(screen.getByText("满足")).toBeVisible();
  expect(screen.getByText("已跳过")).toBeVisible();
  expect(screen.getByText("冲突")).toBeVisible();
  expect(screen.getByText("失败")).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
});

it("shows shared configuration as read-only project facts", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  const project = projectFixture();
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectDetailPage facade={{ get: async () => project, list: async () => [project], register: async () => project, updateAgentIds: async () => project, listAgentCandidates: async () => [] }} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("C:/Projects/demo")).toBeVisible();
  expect(screen.getByText("Best-effort assembly")).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("updates the Agent associations without changing the project shared configuration", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = { ...projectFixture(), agentIds: ["codex-cli"] };
  const updateAgentIds = vi.fn(async (_projectId: string, agentIds: string[]) => ({ ...project, agentIds }));
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectDetailPage facade={{
        get: async () => project,
        list: async () => [project],
        register: async () => project,
        updateAgentIds,
        listAgentCandidates: async () => [
          { id: "codex-cli", label: "OpenAI · Codex CLI", available: true },
          { id: "claude-code", label: "Anthropic · Claude Code", available: true },
        ],
      }} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("checkbox", { name: "Anthropic · Claude Code" }));
  await user.click(screen.getByRole("button", { name: "保存关联" }));

  expect(updateAgentIds).toHaveBeenCalledWith("demo-project", ["codex-cli", "claude-code"]);
  expect(screen.getByText("已保存 Agent 关联。")).toBeVisible();
});
