import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { AiNetworkSettings } from "./AiNetworkSettings";
import { ApplicationUpdate } from "./ApplicationUpdate";
import { NetworkStoragePlaceholder } from "./NetworkStoragePlaceholder";
import { availableUpdate, networkSettings, settingsFixture, type SettingsFacade } from "./api";
import { SettingsPage } from "./SettingsPage";

it("offers an explicit way to rerun initialization", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <SettingsPage
          facade={{ execute: async () => undefined }}
          initialSettings={settingsFixture()}
        />
      </ThemeProvider>
    </I18nextProvider>,
  );

  expect(screen.getByRole("link", { name: "重新运行初始化向导" })).toHaveAttribute(
    "href",
    "/initialize",
  );
});

it("lets users choose and immediately apply a named theme", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const commands: unknown[] = [];
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <SettingsPage
          facade={{ execute: async (command) => { commands.push(command); } }}
          initialSettings={settingsFixture()}
        />
      </ThemeProvider>
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("button", { name: "樱花" }));

  expect(document.documentElement).toHaveAttribute("data-theme", "sakura");
  expect(commands).toContainEqual({ type: "set_theme", payload: { theme: "sakura" } });
});

it("lets users choose and immediately apply the interface language", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const commands: unknown[] = [];
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <SettingsPage
          facade={{ execute: async (command) => { commands.push(command); } }}
          initialSettings={settingsFixture()}
        />
      </ThemeProvider>
    </I18nextProvider>,
  );

  await user.selectOptions(screen.getByLabelText("语言"), "en-US");

  expect(commands).toContainEqual({ type: "set_language", payload: { language: "en-US" } });
  expect(await screen.findByRole("heading", { name: "Shape SkillHub around your workflow" })).toBeVisible();
});

it("turns off online helpers while leaving local management enabled", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const commands: unknown[] = [];
  const facade: SettingsFacade = { execute: async (command) => { commands.push(command); } };
  render(<I18nextProvider i18n={i18n}><AiNetworkSettings facade={facade} settings={networkSettings()} /></I18nextProvider>);

  await user.click(screen.getByLabelText("关闭所有网络功能"));
  expect(commands).toContainEqual({ type: "set_network_enabled", payload: { enabled: false } });
  expect(screen.getByText("本地扫描、搜索、部署和备份仍可使用")).toBeVisible();
  expect(screen.queryByRole("button", { name: "测试提供商" })).not.toBeInTheDocument();
});

it("network storage page has no connect authorize or test button", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(<I18nextProvider i18n={i18n}><NetworkStoragePlaceholder /></I18nextProvider>);
  expect(screen.getByText("下一大版本规划")).toBeVisible();
  expect(screen.queryByRole("button", { name: /连接|授权|测试/ })).not.toBeInTheDocument();
});

it("opens the release page instead of claiming automatic update on unsigned builds", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const commands: unknown[] = [];
  const facade: SettingsFacade = { execute: async (command) => { commands.push(command); } };
  render(
    <I18nextProvider i18n={i18n}>
      <ApplicationUpdate
        buildTrust="windows_unsigned"
        onOpenRelease={() => void facade.execute({ type: "open_official_release" })}
        policy={{ enabled: true, checkOnStartup: true }}
        state="available"
        update={availableUpdate()}
      />
    </I18nextProvider>,
  );
  await user.click(screen.getByRole("button", { name: "打开 GitHub Release" }));
  expect(commands).toContainEqual({ type: "open_official_release" });
  expect(screen.queryByText("自动安装中")).not.toBeInTheDocument();
});
