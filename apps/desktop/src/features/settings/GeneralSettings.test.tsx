import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { settingsFixture, type SettingsFacade } from "./api";
import { GeneralSettings } from "./GeneralSettings";

function renderGeneral(facade: SettingsFacade, i18n: Awaited<ReturnType<typeof createSkillHubI18n>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <GeneralSettings facade={facade} settings={settingsFixture()} />
      </ThemeProvider>
    </I18nextProvider>,
  );
}

it("associates the language help text with the language control", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  renderGeneral({ execute: async () => undefined }, i18n);

  const language = screen.getByRole("combobox", { name: "语言" });
  expect(language).toHaveAccessibleDescription("切换后立即更新界面，并保存到本机偏好。");
});

it("reverts the language and announces the failure when saving is rejected", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  renderGeneral(
    { execute: async () => Promise.reject(new Error("native failure")) },
    i18n,
  );

  await user.selectOptions(screen.getByRole("combobox", { name: "语言" }), "en-US");

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "语言未能保存，已恢复为原来的设置。",
  );
  expect(screen.getByRole("combobox", { name: "语言" })).toHaveValue("zh-CN");
});

it("keeps announcing the theme failure through the shared control grid", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  renderGeneral(
    { execute: async () => Promise.reject(new Error("native failure")) },
    i18n,
  );

  await user.click(screen.getByRole("button", { name: "樱花" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "主题未能保存，已恢复为原来的设置。",
  );
  expect(document.documentElement).toHaveAttribute("data-theme", "moss-neutral");
});
