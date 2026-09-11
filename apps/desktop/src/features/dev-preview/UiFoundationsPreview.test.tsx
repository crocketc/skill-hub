import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { themeNames } from "../../styles/theme";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { iconNames } from "../../ui/Icon";
import { UiFoundationsPreview } from "./UiFoundationsPreview";

async function renderBoard() {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <UiFoundationsPreview />
      </ThemeProvider>
    </I18nextProvider>,
  );
}

describe("UiFoundationsPreview", () => {
  it("offers a switch for every registered theme and applies it", async () => {
    await renderBoard();

    for (const theme of themeNames) {
      expect(screen.getByRole("button", { name: theme })).toBeVisible();
    }

    fireEvent.click(screen.getByRole("button", { name: "sakura" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "sakura");
  });

  it("shows every registered icon with a visible text name", async () => {
    await renderBoard();

    expect(iconNames.length).toBeGreaterThanOrEqual(18);
    for (const name of iconNames) {
      expect(screen.getByText(name)).toBeVisible();
    }
  });

  it("exposes the base form controls", async () => {
    await renderBoard();

    expect(screen.getByRole("textbox", { name: "文本输入" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "下拉选择" })).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "复选框与文字共享点击区" }),
    ).toBeVisible();
    expect(screen.getByRole("radio", { name: "标准密度" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "紧凑密度" })).toBeVisible();
    expect(screen.getByRole("switch", { name: "立即生效的开关" })).toBeVisible();
    expect(screen.getByRole("button", { name: "主操作" })).toBeVisible();
    expect(screen.getByRole("button", { name: "删除技能" })).toBeVisible();
  });

  it("shows status badges with text instead of color alone", async () => {
    await renderBoard();

    for (const label of ["成功", "警告", "失败", "信息", "中性"]) {
      expect(screen.getByText(label)).toBeVisible();
    }
  });
});
