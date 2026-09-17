import { I18nextProvider } from "react-i18next";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../i18n";
import baseCss from "../styles/base.css?raw";
import { Sidebar } from "./Sidebar";

// 预取接线：Sidebar 悬停/聚焦应通过 preloadRoute 触发对应路由 chunk 预加载。
const preloadRouteMock = vi.hoisted(() => vi.fn());
vi.mock("./router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./router")>()),
  preloadRoute: preloadRouteMock,
}));

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

  it("keeps the sidebar toggle outside the sidebar scroll container", async () => {
    await renderSidebar();

    const navigation = screen.getByRole("complementary", { name: "Main navigation" });
    expect(navigation.querySelector(".sh-sidebar__scroll")).toBeInTheDocument();
    expect(baseCss).toMatch(/\.sh-sidebar\s*\{[^}]*overflow:\s*hidden/);
    expect(baseCss).toMatch(
      /\.sh-sidebar__scroll\s*\{[\s\S]*overflow-y:\s*auto[\s\S]*overflow-x:\s*hidden/,
    );
  });

  it("keeps the brand centered independently from the sidebar toggle", () => {
    const toggleRule = baseCss.match(/\n\.sh-sidebar__toggle\s*\{[^}]*\}/)?.[0] ?? "";
    expect(toggleRule).not.toBe("");
    expect(toggleRule).toMatch(/position:\s*absolute/);
    expect(toggleRule).toMatch(/inset-inline-start:\s*calc\(-1 \* var\(--space-2\)\)/);
    expect(toggleRule).toMatch(/border:\s*0/);
    expect(toggleRule).toMatch(/background:\s*transparent/);
    const brandRule = baseCss.match(/\.sh-sidebar__brand\s*\{[^}]*\}/)?.[0] ?? "";
    expect(brandRule).toMatch(/width:\s*100%/);
    expect(brandRule).toMatch(/justify-content:\s*center/);
    expect(baseCss).toMatch(/\.sh-sidebar__header[^\{]*\{[\s\S]*position:\s*relative/);
  });

  it("renders the toggle in the sidebar header and omits the brand when collapsed", async () => {
    await renderSidebar();

    const header = screen
      .getByRole("complementary", { name: "Main navigation" })
      .querySelector(".sh-sidebar__header");
    expect(header).not.toBeNull();
    expect(header!.querySelector(".sh-sidebar__toggle")).not.toBeNull();
    expect(header!.querySelector(".sh-sidebar__brand")).not.toBeNull();

    await renderSidebar("/library/skill-pdf", true);
    const collapsedHeader = screen
      .getAllByRole("complementary", { name: "Main navigation" })[1]
      .querySelector(".sh-sidebar__header");
    expect(collapsedHeader!.querySelector(".sh-sidebar__toggle")).not.toBeNull();
    expect(collapsedHeader!.querySelector(".sh-sidebar__brand")).toBeNull();
  });

  it("places Skill relations between Skill library and Discover", async () => {
    await renderSidebar();

    const library = screen.getByRole("link", { name: "Skill library" });
    const relations = screen.getByRole("link", { name: "Skill relations" });
    const discover = screen.getByRole("link", { name: "Discover" });
    expect(
      library.compareDocumentPosition(relations) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      relations.compareDocumentPosition(discover) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("marks Skill relations current on the module tab and its sub-routes", async () => {
    await renderSidebar("/relationships");
    expect(screen.getByRole("link", { name: "Skill relations" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await renderSidebar("/relationships/governance");
    const second = screen.getAllByRole("complementary", { name: "Main navigation" })[1];
    const relationsLink = Array.from(second.querySelectorAll("a")).find(
      (link) => link.textContent === "Skill relations",
    );
    expect(relationsLink).not.toBeUndefined();
    expect(relationsLink).toHaveAttribute("aria-current", "page");
  });

  it("preloads the relationships route chunk on hover and focus", async () => {
    const user = userEvent.setup();
    await renderSidebar("/library");

    const relations = screen.getByRole("link", { name: "Skill relations" });
    await user.hover(relations);
    expect(preloadRouteMock).toHaveBeenCalledWith("/relationships");

    preloadRouteMock.mockClear();
    relations.focus();
    expect(preloadRouteMock).toHaveBeenCalledWith("/relationships");
  });
});
