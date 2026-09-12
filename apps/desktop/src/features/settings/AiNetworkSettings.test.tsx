import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { type SettingsFacade, unavailableSettingsFacade } from "./api";
import { AiNetworkSettings } from "./AiNetworkSettings";

function facadeWith(commands: SettingsFacade["execute"]): SettingsFacade {
  return {
    ...unavailableSettingsFacade,
    execute: commands,
  };
}

function renderCard(settings: Parameters<typeof AiNetworkSettings>[0]["settings"], facade: SettingsFacade, i18n: Awaited<ReturnType<typeof createSkillHubI18n>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <AiNetworkSettings facade={facade} settings={settings} />
      </ThemeProvider>
    </I18nextProvider>,
  );
}

// M-05：设置-网络与AI 的"数据范围"不得泄漏内部枚举值（explicit_selection），
// 必须给出用户语言映射和一句发送范围解释。
it("maps the explicit-selection data scope to user language plus one send-scope sentence", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  renderCard(
    { networkEnabled: true, llmProvider: "", dataScope: "explicit_selection" },
    facadeWith(async () => undefined),
    i18n,
  );

  expect(screen.getByText("仅限你明确开启的功能")).toBeVisible();
  const scopeRow = screen.getByText("数据范围").closest("div") ?? screen.getByText("数据范围").parentElement!;
  expect(scopeRow.textContent).not.toContain("explicit_selection");
  expect(screen.getByText(/只发送该功能所需的最少内容/)).toBeVisible();
});

it("never renders a raw scope value even when the backend reports an unknown scope", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  renderCard(
    { networkEnabled: true, llmProvider: "", dataScope: "future_scope_value" },
    facadeWith(async () => undefined),
    i18n,
  );

  const scopeTerm = screen.getByText("数据范围");
  expect(scopeTerm.closest("div")?.textContent ?? scopeTerm.parentElement?.textContent).not.toContain("future_scope_value");
  expect(screen.getByText(/只发送该功能所需的最少内容/)).toBeVisible();
});

it("shows an honest placeholder instead of an empty badge when no provider is set", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  renderCard(
    { networkEnabled: true, llmProvider: "", dataScope: "explicit_selection" },
    facadeWith(async () => undefined),
    i18n,
  );

  expect(screen.getByText("未配置")).toBeVisible();
});

it("keeps toggling the network switch through the facade", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const execute = vi.fn(async () => undefined);
  renderCard(
    { networkEnabled: true, llmProvider: "local-model", dataScope: "explicit_selection" },
    facadeWith(execute),
    i18n,
  );

  await user.click(screen.getByRole("switch", { name: "关闭所有网络功能" }));

  expect(execute).toHaveBeenCalledWith({ type: "set_network_enabled", payload: { enabled: false } });
});
