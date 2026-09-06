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

it("persists view density and automation choices", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const commands: unknown[] = [];
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <SettingsPage facade={{ execute: async (command) => { commands.push(command); } }} initialSettings={settingsFixture()} />
      </ThemeProvider>
    </I18nextProvider>,
  );

  await user.selectOptions(screen.getByLabelText("信息密度"), "comfortable");
  await user.click(screen.getByLabelText("批量检查"));

  expect(commands).toContainEqual({ type: "set_density", payload: { density: "comfortable" } });
  expect(commands).toContainEqual({ type: "set_automation", payload: { automation: { perSkill: true, batch: true, global: false } } });
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

it("renders setting sections in the inventory order with density inside general", async () => {
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

  // AR-027：分区标题按盘点顺序出现，密度控件并入“通用”分区。
  const order = ["通用", "数据保护", "网络与 AI", "自动化", "技能库维护", "应用更新"];
  const headings = order.map((name) => {
    const heading = screen.getByRole("heading", { level: 3, name });
    return heading;
  });
  for (let i = 1; i < headings.length; i++) {
    expect(headings[i - 1].compareDocumentPosition(headings[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  // 密度选择在“通用”之后、“数据保护”之前。
  const general = headings[0];
  const density = screen.getByLabelText("信息密度");
  const dataProtection = headings[1];
  expect(general.compareDocumentPosition(density) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(density.compareDocumentPosition(dataProtection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
