import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { stubMatchMediaReducedMotion } from "../../ui/testMatchMedia";
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


describe("always-reduce-motion preference", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders the switch off by default with its help text associated", async () => {
    stubMatchMediaReducedMotion(false);
    const i18n = await createSkillHubI18n(["zh-CN"]);
    renderGeneral({ execute: async () => undefined }, i18n);

    const toggle = screen.getByRole("switch", { name: "始终减少动效" });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(
      "开启后界面过渡与提示动效改为即时出现、即时消失；系统已开启减少动效时无需重复设置。",
    );
  });

  it("persists the user choice on and back off through the shared store", async () => {
    stubMatchMediaReducedMotion(false);
    const user = userEvent.setup();
    const i18n = await createSkillHubI18n(["zh-CN"]);
    renderGeneral({ execute: async () => undefined }, i18n);

    const toggle = screen.getByRole("switch", { name: "始终减少动效" });
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("skillhub.reduced-motion")).toBe("true");

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem("skillhub.reduced-motion")).toBeNull();
  });

  it("restores the persisted choice after remount", async () => {
    stubMatchMediaReducedMotion(false);
    const user = userEvent.setup();
    const i18n = await createSkillHubI18n(["zh-CN"]);
    const first = renderGeneral({ execute: async () => undefined }, i18n);
    await user.click(screen.getByRole("switch", { name: "始终减少动效" }));
    first.unmount();

    renderGeneral({ execute: async () => undefined }, i18n);
    expect(screen.getByRole("switch", { name: "始终减少动效" })).toBeChecked();
  });

  it("keeps the switch reflecting the user choice while the system preference is on", async () => {
    const media = stubMatchMediaReducedMotion(true);
    const user = userEvent.setup();
    const i18n = await createSkillHubI18n(["zh-CN"]);
    renderGeneral({ execute: async () => undefined }, i18n);

    // 系统已开启减少动效：开关仍只表达用户自己的选择（有效状态取或）。
    const toggle = screen.getByRole("switch", { name: "始终减少动效" });
    expect(toggle).not.toBeChecked();

    media.setMatches(false);
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("skillhub.reduced-motion")).toBe("true");

    // 系统偏好实时变化不影响已保存的用户选择。
    media.setMatches(true);
    expect(toggle).toBeChecked();
  });
});
