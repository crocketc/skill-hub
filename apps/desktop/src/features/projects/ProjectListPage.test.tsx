import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { DirectoryPicker } from "../../platform/directoryPicker";
import { projectFixture, type ProjectFacade } from "./api";
import { ProjectListPage } from "./ProjectListPage";

it("filters one project through multiple tags without creating a folder tree", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const facade: ProjectFacade = { get: async () => project, list: async () => [project], register: async () => project };
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={facade} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("checkbox", { name: "客户项目" }));
  await user.click(screen.getByRole("checkbox", { name: "Rust" }));

  expect(screen.getByText("Demo Project")).toBeVisible();
  expect(screen.queryByRole("tree")).not.toBeInTheDocument();
});

it("opens a flat project summary drawer from its row", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["en-US"]);
  const project = projectFixture();
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={{ get: async () => project, list: async () => [project], register: async () => project }} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "Demo Project" }));
  expect(await screen.findByRole("dialog")).toBeVisible();
  expect(screen.getByText("C:/Projects/demo")).toBeVisible();
});

it("registers a user-selected local directory without creating a shared config", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const register = vi.fn(async () => project);
  const directoryPicker: DirectoryPicker = { pickDirectory: vi.fn(async () => "C:/Projects/Aurora") };
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage directoryPicker={directoryPicker} facade={{ get: async () => project, list: async () => [], register }} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "注册项目" }));
  await user.click(screen.getByRole("button", { name: "选择项目目录" }));

  expect(screen.getByText("C:/Projects/Aurora")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "项目名称" })).toHaveValue("Aurora");
  await user.click(screen.getByRole("button", { name: "确认注册" }));

  expect(register).toHaveBeenCalledWith(expect.objectContaining({
    id: expect.stringMatching(/.+/),
    name: "Aurora",
    path: "C:/Projects/Aurora",
    tags: [],
  }));
});

it("leaves project registration unchanged when directory selection is cancelled", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const register = vi.fn(async () => project);
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage directoryPicker={{ pickDirectory: vi.fn(async () => null) }} facade={{ get: async () => project, list: async () => [], register }} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "注册项目" }));
  await user.click(screen.getByRole("button", { name: "选择项目目录" }));

  expect(register).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "确认注册" })).toBeDisabled();
});
