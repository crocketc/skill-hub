import { I18nextProvider } from "react-i18next";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../i18n";
import baseCss from "../styles/base.css?raw";
import { Sidebar } from "./Sidebar";

async function renderSidebar(entry = "/library/skill-pdf") {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[entry]}>
        <Sidebar />
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
    await renderSidebar();

    const toggle = screen.getByRole("button", { name: "Collapse navigation" });
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("complementary", { name: "Main navigation" })).toHaveClass(
      "is-collapsed",
    );
    // 折叠后每个目的地仍只朗读一次：链接的可访问名称保持完整，
    // 图标为纯装饰（不注册 img 角色、不重复朗读）。
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

  it("places the compact toggle between the brand row and the first nav item", () => {
    expect(baseCss).toMatch(/\.sh-sidebar__toggle\s*\{[\s\S]*top:\s*calc\(100% \+ var\(--space-2\)\)/);
    expect(baseCss).toMatch(/\.sh-sidebar__toggle\s*\{[\s\S]*width:\s*2\.5rem[\s\S]*height:\s*2\.5rem/);
    expect(baseCss).toMatch(/\.sh-sidebar__toggle\s*\{[\s\S]*right:\s*-1\.5rem/);
  });
});
