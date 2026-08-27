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
    expect(screen.getByRole("link", { name: "Skill library" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("img", { name: "Skill library icon" })).toBeInTheDocument();
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
});
