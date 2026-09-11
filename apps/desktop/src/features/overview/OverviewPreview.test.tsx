import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { OverviewPage } from "./OverviewPage";
import { OverviewPreviewShell } from "./OverviewPreview";

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
    await screen.findByRole("img", { name: "Deployment count by agent" }),
  ).toBeVisible();
  expect(screen.getByRole("list", { name: "Skill count by tag" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "4 pending items" })).toBeVisible();
  expect(screen.getByRole("link", { name: "3 configured agents" })).toBeVisible();
  expect(screen.getByRole("link", { name: "5 discovered agents" })).toBeVisible();
});
