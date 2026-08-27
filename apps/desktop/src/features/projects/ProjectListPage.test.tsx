import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { projectFixture, type ProjectFacade } from "./api";
import { ProjectListPage } from "./ProjectListPage";

it("filters one project through multiple tags without creating a folder tree", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const facade: ProjectFacade = { get: async () => project, list: async () => [project] };
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
      <ProjectListPage facade={{ get: async () => project, list: async () => [project] }} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "Demo Project" }));
  expect(await screen.findByRole("dialog")).toBeVisible();
  expect(screen.getByText("C:/Projects/demo")).toBeVisible();
});
