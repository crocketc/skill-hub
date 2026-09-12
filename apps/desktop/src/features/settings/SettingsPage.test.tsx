import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { AiNetworkSettings } from "./AiNetworkSettings";
import { ApplicationUpdate } from "./ApplicationUpdate";
import { NetworkStoragePlaceholder } from "./NetworkStoragePlaceholder";
import { availableUpdate, networkSettings, settingsFixture, type SettingsFacade } from "./api";
import settingsCss from "./settings.css?raw";
import { SettingsPage } from "./SettingsPage";

// P2-01：设置页与概览、发现共用同一档页头↔正文的留白节奏（--page-gap），
// 不允许页面级另写一档间距。
it("drives the settings page section gap from the shared page-gap token", () => {
  const pageStart = settingsCss.indexOf(".sh-settings-page {");
  const pageBlock = settingsCss.slice(pageStart, settingsCss.indexOf("}", pageStart) + 1);
  expect(pageBlock).toMatch(/gap:\s*var\(--page-gap\)/);
});

// M-03：设置页在所有支持宽度下保持"左侧分区导航 + 右侧内容滚动"；
// 容器查询只允许调整尺寸与间距，不允许把导航换到内容上方。
it("keeps the section navigation in a left column with dual scrolling at every width", () => {
  const layoutStart = settingsCss.indexOf(".sh-settings-layout {");
  const layoutBlock = settingsCss.slice(layoutStart, settingsCss.indexOf("}", layoutStart) + 1);
  const columns = layoutBlock.match(/grid-template-columns:\s*([^;]+);/);
  expect(columns, "layout declares two side-by-side columns").not.toBeNull();
  // 按顶层空格切分轨道（minmax() 内部的空格不算分隔）。
  const tracks = columns![1].trim().split(/\s+(?![^(]*\))/);
  expect(tracks.length, "nav column plus content column").toBe(2);

  const navStart = settingsCss.indexOf(".sh-settings-nav {");
  const navBlock = settingsCss.slice(navStart, settingsCss.indexOf("}", navStart) + 1);
  expect(navBlock).toMatch(/flex-direction:\s*column/);
  expect(navBlock).toMatch(/overflow-y:\s*auto/);

  const panelsStart = settingsCss.indexOf(".sh-settings-panels {");
  const panelsBlock = settingsCss.slice(panelsStart, settingsCss.indexOf("}", panelsStart) + 1);
  expect(panelsBlock, "content column owns scrolling at every width").toMatch(
    /overflow-y:\s*auto/,
  );
});

it("announces the section navigation as a vertical tablist", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <SettingsPage
            facade={{ execute: async () => undefined }}
            initialSettings={settingsFixture()}
          />
        </ThemeProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );

  expect(screen.getByRole("tablist", { name: "设置分区" })).toHaveAttribute(
    "aria-orientation",
    "vertical",
  );
});

it("offers an explicit way to rerun initialization", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <SettingsPage
          facade={{ execute: async () => undefined }}
          initialSettings={settingsFixture()}
        />
        </ThemeProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );

  expect(screen.getByRole("link", { name: "重新发现 Agent 与 Skill" })).toHaveAttribute(
    "href",
    "/initialize",
  );
});

it("lets users choose and immediately apply a named theme", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const commands: unknown[] = [];
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <SettingsPage
          facade={{ execute: async (command) => { commands.push(command); } }}
          initialSettings={settingsFixture()}
        />
        </ThemeProvider>
      </I18nextProvider>
    </MemoryRouter>,
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
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <SettingsPage
          facade={{ execute: async (command) => { commands.push(command); } }}
          initialSettings={settingsFixture()}
        />
        </ThemeProvider>
      </I18nextProvider>
    </MemoryRouter>,
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
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <SettingsPage facade={{ execute: async (command) => { commands.push(command); } }} initialSettings={settingsFixture()} />
        </ThemeProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );

  await user.selectOptions(screen.getByLabelText("信息密度"), "comfortable");
  await user.click(screen.getByRole("tab", { name: "自动化" }));
  // 自动化开关立即生效：以 Switch 语义暴露。
  expect(screen.getByRole("switch", { name: "批量检查" })).not.toBeChecked();
  await user.click(screen.getByRole("switch", { name: "批量检查" }));

  expect(commands).toContainEqual({ type: "set_density", payload: { density: "comfortable" } });
  expect(commands).toContainEqual({ type: "set_automation", payload: { automation: { perSkill: true, batch: true, global: false } } });
});

it("turns off online helpers while leaving local management enabled", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const commands: unknown[] = [];
  const facade: SettingsFacade = { execute: async (command) => { commands.push(command); } };
  render(<I18nextProvider i18n={i18n}><AiNetworkSettings facade={facade} settings={networkSettings()} /></I18nextProvider>);

  // 网络总开关立即生效：以 Switch 语义暴露。
  expect(screen.getByRole("switch", { name: "关闭所有网络功能" })).not.toBeChecked();
  await user.click(screen.getByRole("switch", { name: "关闭所有网络功能" }));
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

it("keeps rendering the loading state while the snapshot is being fetched", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <SettingsPage
            facade={{
              execute: async () => undefined,
              get: () => new Promise(() => undefined),
            }}
          />
        </ThemeProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );

  expect(screen.getByText("正在加载设置")).toBeVisible();
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});

it("exposes six sections behind a keyboard-usable section navigation", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <SettingsPage
          facade={{ execute: async () => undefined }}
          initialSettings={settingsFixture()}
        />
        </ThemeProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );

  // AR-027：分区按盘点顺序出现在分区导航中，默认选中“通用”。
  const order = ["通用", "数据保护", "网络与 AI", "自动化", "技能库维护", "应用更新"];
  const tabs = within(screen.getByRole("tablist", { name: "设置分区" })).getAllByRole("tab");
  expect(tabs).toHaveLength(6);
  expect(tabs.map((tab) => tab.textContent)).toEqual(order);
  expect(tabs[0]).toHaveAttribute("aria-selected", "true");

  // 默认显示“通用”分区；其他分区隐藏但保持挂载，切换回来不丢状态。
  expect(screen.getByRole("tabpanel", { name: "通用" })).toBeVisible();
  expect(screen.getByLabelText("信息密度")).toBeVisible();
  expect(screen.getByLabelText("批量检查")).toBeInTheDocument();
  expect(screen.getByLabelText("批量检查")).not.toBeVisible();

  await user.click(screen.getByRole("tab", { name: "自动化" }));
  expect(screen.getByLabelText("批量检查")).toBeVisible();
  expect(screen.getByLabelText("信息密度")).not.toBeVisible();

  // 方向键切换到下一个分区并移动焦点（自动激活的标签页模式）。
  screen.getByRole("tab", { name: "自动化" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "技能库维护" })).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "技能库维护" }));
  expect(screen.getByRole("tabpanel", { name: "技能库维护" })).toBeVisible();
});
