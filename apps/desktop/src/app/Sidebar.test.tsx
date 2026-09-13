import { I18nextProvider } from "react-i18next";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../i18n";
import baseCss from "../styles/base.css?raw";
import { Sidebar } from "./Sidebar";

async function renderSidebar(entry = "/library/skill-pdf", collapsed = false) {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[entry]}>
        <Sidebar collapsed={collapsed} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe("Sidebar", () => {
  it("exposes every primary and utility destination", async () => {
    await renderSidebar();

    expect(screen.getByRole("link", { name: "Overview" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Skill library" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Discover" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Agents" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Projects" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Pending" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Operations and recovery" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Recovery" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeVisible();
  });

  it("collapses to icon navigation while retaining accessible labels", async () => {
    // D5：折叠状态改由壳层标题栏按钮驱动（见 AppShell.test），侧栏只
    // 接收 collapsed 状态。折叠后每个目的地仍只朗读一次：链接的可访问
    // 名称保持完整，图标为纯装饰（不注册 img 角色、不重复朗读）。
    await renderSidebar("/library/skill-pdf", true);

    expect(screen.getByRole("complementary", { name: "Main navigation" })).toHaveClass(
      "is-collapsed",
    );
    const libraryLink = screen.getByRole("link", { name: "Skill library" });
    expect(libraryLink).toHaveAttribute("aria-current", "page");
    expect(
      libraryLink.querySelector("svg[aria-hidden='true']"),
    ).not.toBeNull();
    expect(screen.queryByRole("img", { name: "Skill library icon" })).not.toBeInTheDocument();
  });

  it("keeps the floating toggle outside the sidebar scroll container", async () => {
    await renderSidebar();

    const navigation = screen.getByRole("complementary", { name: "Main navigation" });
    expect(navigation.querySelector(".sh-sidebar__scroll")).toBeInTheDocument();
    expect(baseCss).toMatch(/\.sh-sidebar\s*\{[^}]*overflow:\s*visible/);
    expect(baseCss).toMatch(
      /\.sh-sidebar__scroll\s*\{[\s\S]*overflow-y:\s*auto[\s\S]*overflow-x:\s*hidden/,
    );
  });

  it("keeps the brand centered while the collapse control moved to the title bar", () => {
    // D5 契约迁移：折叠控件选择器迁到标题栏（.sh-app-shell__sidebar-toggle），
    // 28px 方形安静控件的视觉值不变；常规流内布局（不再是侧栏内的绝对定位）。
    const toggleRule = baseCss.match(/\.sh-app-shell__sidebar-toggle\s*\{[^}]*\}/)?.[0] ?? "";
    expect(toggleRule).not.toBe("");
    expect(toggleRule).toMatch(/width:\s*1\.75rem/);
    expect(toggleRule).toMatch(/height:\s*1\.75rem/);
    // 方形小圆角：禁止旧圆形 999px。
    expect(toggleRule).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(toggleRule).not.toMatch(/999px/);
    expect(toggleRule).not.toMatch(/position:\s*absolute/);
    const brandRule = baseCss.match(/\.sh-sidebar__brand\s*\{[^}]*\}/)?.[0] ?? "";
    expect(brandRule).toMatch(/width:\s*100%/);
    expect(brandRule).toMatch(/justify-content:\s*center/);
    // hover/active 位移效果一并移除（标题栏内无 transform 重置需求）。
    expect(baseCss).not.toMatch(
      /\.sh-app-shell__sidebar-toggle:hover[^{]*\{[^}]*translate/,
    );
    expect(baseCss).not.toMatch(
      /\.sh-app-shell__sidebar-toggle:active[^{]*\{[^}]*translate/,
    );
  });

  it("keeps the header brand-only now that the toggle leads the shell title bar", async () => {
    await renderSidebar();

    // D5：侧栏头部只保留品牌；折叠按钮由 AppShell 渲染在标题栏首位
    // （DOM 位置契约锁定于 AppShell.test.tsx）。
    const header = screen
      .getByRole("complementary", { name: "Main navigation" })
      .querySelector(".sh-sidebar__header");
    expect(header).not.toBeNull();
    expect(header!.firstElementChild).toBe(
      header!.querySelector(".sh-sidebar__brand"),
    );
    expect(screen.queryByRole("button", { name: "Collapse navigation" })).not.toBeInTheDocument();
    expect(header!.querySelector(".sh-sidebar__brand")).not.toBeNull();
  });
});
