import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { settingsFixture, type SettingsFacade } from "./api";
import { ViewSettings } from "./ViewSettings";

function renderView(facade: SettingsFacade, i18n: Awaited<ReturnType<typeof createSkillHubI18n>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <ThemeProvider>
          <ViewSettings facade={facade} settings={settingsFixture()} />
        </ThemeProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

it("associates the current density with the density control as its description", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  renderView({ execute: async () => undefined }, i18n);

  const density = screen.getByRole("combobox", { name: "信息密度" });
  expect(density).toHaveAccessibleDescription("信息密度：紧凑");
});

it("follows the chosen density in the live description and reverts on failure", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  renderView(
    { execute: async () => Promise.reject(new Error("native failure")) },
    i18n,
  );

  await user.selectOptions(screen.getByRole("combobox", { name: "信息密度" }), "comfortable");

  expect(await screen.findByRole("alert")).toHaveTextContent("无法保存信息密度设置。");
  expect(screen.getByRole("combobox", { name: "信息密度" })).toHaveValue("compact");
  expect(screen.getByRole("combobox", { name: "信息密度" })).toHaveAccessibleDescription(
    "信息密度：紧凑",
  );
});

it("points list and drawer view entries to the pages that manage them", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  renderView({ execute: async () => undefined }, i18n);

  expect(screen.getByRole("link", { name: "打开技能库" })).toHaveAttribute("href", "/library");
  expect(screen.getByRole("link", { name: "打开项目" })).toHaveAttribute("href", "/projects");
  expect(screen.getByRole("link", { name: "前往技能库" })).toHaveAttribute("href", "/library");
});
