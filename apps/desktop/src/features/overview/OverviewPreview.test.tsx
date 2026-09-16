import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { OverviewPage } from "./OverviewPage";
import { OverviewPreviewShell } from "./OverviewPreview";
import overviewCss from "./overview.css?raw";

function mockBrowserPreferences() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});

it("mounts the deterministic overview preview with deployment, tag, and pending fixture data", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  mockBrowserPreferences();

  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/__preview/overview"]}>
          <Routes>
            <Route element={<OverviewPreviewShell />} path="__preview/overview">
              <Route index element={<OverviewPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </I18nextProvider>,
  );

  expect(
    await screen.findByRole("img", { name: "Deployment relation count by agent" }),
  ).toBeVisible();
  expect(screen.getByRole("list", { name: "Skill count by tag" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "4 pending items" })).toBeVisible();
  expect(screen.getByRole("link", { name: "3 configured agents" })).toBeVisible();
  expect(screen.getByRole("link", { name: "5 discovered agents" })).toBeVisible();
});

it("fills the remaining shell height without a viewport-derived outer scroll range", () => {
  expect(overviewCss).toMatch(/\.sh-overview__hero\s*\{[\s\S]*min-height:\s*5rem/);
  expect(overviewCss).toMatch(/\.sh-overview__stat\s*\{[\s\S]*min-height:\s*5rem/);
  expect(overviewCss).not.toContain("100dvh - 22rem");
  expect(overviewCss).toMatch(/\.sh-overview__content-grid\s*\{[\s\S]*min-height:\s*0/);
});

it("falls back to intrinsic overview height before cards can overlap in a short window", () => {
  expect(overviewCss).toMatch(/@media \(max-height: 70rem\) \{[\s\S]*?\.sh-page-frame--fill \{[\s\S]*?height:\s*auto/);
  expect(overviewCss).toMatch(/@media \(max-height: 70rem\) \{[\s\S]*?\.sh-overview \.sh-overview__content-grid \{[\s\S]*?height:\s*auto/);
  expect(overviewCss).toMatch(/@media \(max-height: 70rem\) \{[\s\S]*?\.sh-overview \.sh-overview__panel \{[\s\S]*?grid-template-rows:\s*auto auto auto/);
});
