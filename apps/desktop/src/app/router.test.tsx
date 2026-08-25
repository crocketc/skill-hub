import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterEach, vi } from "vitest";
import { SkillLibraryPreview } from "../features/skills/SkillLibraryPreview";
import { skillHubI18n } from "../i18n";
import { sidebarNavigationEnd } from "./Sidebar";
import { resolveRouteTitleKey } from "./AppShell";
import { appRouter, AppRouter } from "./router";

vi.mock("../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/bindings")>();
  return {
    ...original,
    queryApplication: vi.fn(async () => ({
      type: "bootstrap_snapshot" as const,
      payload: {
        agent_count: 0,
        deployed_count: 0,
        deployment_categories: [],
        last_scan_at: null,
        pending: { by_kind: {}, total: 0 },
        project_count: 0,
        recent_operations: [],
        recovery_state: "clean" as const,
        skill_count: 0,
      },
    })),
  };
});

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
  document.documentElement.removeAttribute("lang");
  vi.unstubAllGlobals();
});

it("wires theme, language, data and motion providers at the production entry without duplicating the overview summary", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/");

  render(<AppRouter />);

  expect(await screen.findAllByText("0 skills")).toHaveLength(1);
  expect(screen.queryByText("Cached skill library")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  expect(document.documentElement).toHaveAttribute("data-theme", "moss-neutral");
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("lang", "en-US");
  });
});

it("uses the unavailable facade on the production Skill library route", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/library");

  render(<AppRouter />);

  expect(
    await screen.findByText(
      "Skill catalog data is not connected yet",
      undefined,
      { timeout: 3_000 },
    ),
  ).toBeVisible();
  expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
});

it("reserves the full-detail URL without changing the shell section", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/library/skill-pdf");

  render(<AppRouter />);

  expect(await screen.findAllByRole("heading", { name: "Skill library" })).toHaveLength(2);
  expect(screen.getByText("Full Skill details are delivered in the next task")).toBeVisible();
});

it("renders deterministic Skill rows when the preview component is mounted directly", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  const previewQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <I18nextProvider i18n={skillHubI18n}>
      <QueryClientProvider client={previewQueryClient}>
        <MemoryRouter initialEntries={["/__preview/skill-library"]}>
          <SkillLibraryPreview />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );

  expect(await screen.findByText("PDF Reader")).toBeVisible();
});

it("uses exact matching for the overview link while nested routes own current-page semantics", () => {
  expect(sidebarNavigationEnd("/")).toBe(true);
  expect(sidebarNavigationEnd("/library")).toBe(false);
  expect(resolveRouteTitleKey("/agents/openai.codex-cli")).toBe("navigation.agents");
  expect(resolveRouteTitleKey("/__preview/skill-library")).toBe("navigation.library");
  expect(resolveRouteTitleKey("/projects/project-aurora")).toBe("navigation.projects");
});

it("keeps shell titles for filtered agent and project deployment destinations", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");

  await appRouter.navigate("/agents/openai.codex-cli?view=deployments");
  render(<AppRouter />);

  expect(await screen.findAllByRole("heading", { name: "Agents" })).toHaveLength(2);
  expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");

  await act(async () => {
    await appRouter.navigate("/projects/project-aurora?view=deployments");
  });

  expect(await screen.findAllByRole("heading", { name: "Projects" })).toHaveLength(2);
  expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");
});
