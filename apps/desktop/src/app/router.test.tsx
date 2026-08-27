import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { skillHubI18n } from "../i18n";
import { unavailableSkillLibraryFacade } from "../features/skills/api";
import { sidebarNavigationEnd } from "./Sidebar";
import { resolveRouteTitleKey } from "./AppShell";
import { queryClient } from "./queryClient";
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
  queryClient.clear();
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
  const listSkills = vi.spyOn(unavailableSkillLibraryFacade, "listSkills");

  render(<AppRouter />);

  expect(
    await screen.findByText("Skill catalog data is not connected yet"),
  ).toBeVisible();
  expect(listSkills).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
});

it("uses the unavailable facade on the production Skill detail route", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/library/skill-pdf");

  render(<AppRouter />);

  expect(await screen.findByText("Skill detail data is not connected yet")).toBeVisible();
  expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
});

it("isolates deterministic Skill detail preview data from production", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/__preview/skill-detail/skill-pdf");

  render(<AppRouter />);
  expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
  expect(
    await screen.findByRole("heading", { name: "Markdown workspace" }),
  ).toBeVisible();
  expect(
    await screen.findByRole("heading", { name: "Extract PDF tables safely" }),
  ).toBeVisible();

  await act(async () => {
    await appRouter.navigate("/library/skill-pdf");
  });
  expect(await screen.findByText("Skill detail data is not connected yet")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "PDF Reader" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Markdown workspace" }),
  ).not.toBeInTheDocument();
});

it("isolates development preview data from the production Skill library route", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/__preview/skill-library");

  render(<AppRouter />);

  expect(await screen.findByText("PDF Reader")).toBeVisible();

  await act(async () => {
    await appRouter.navigate("/library");
  });

  expect(
    await screen.findByText("Skill catalog data is not connected yet"),
  ).toBeVisible();
  expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
});

it("uses exact matching for the overview link while nested routes own current-page semantics", () => {
  expect(sidebarNavigationEnd("/")).toBe(true);
  expect(sidebarNavigationEnd("/library")).toBe(false);
  expect(resolveRouteTitleKey("/agents/openai.codex-cli")).toBe("navigation.agents");
  expect(resolveRouteTitleKey("/__preview/skill-library")).toBe("navigation.library");
  expect(resolveRouteTitleKey("/__preview/skill-detail/skill-pdf")).toBe("navigation.library");
  expect(resolveRouteTitleKey("/projects/project-aurora")).toBe("navigation.projects");
});

it("keeps shell titles for filtered agent and project deployment destinations", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");

  await appRouter.navigate("/agents/openai.codex-cli?view=deployments");
  render(<AppRouter />);

  expect(await screen.findAllByRole("heading", { name: "Agents" })).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");

  await act(async () => {
    await appRouter.navigate("/projects/project-aurora?view=deployments");
  });

  expect(await screen.findAllByRole("heading", { name: "Projects" })).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");
});

it("does not show fixture Agents or projects through production routes", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/agents");
  render(<AppRouter />);

  expect(await screen.findByText("Agent data is not connected to the native service yet.")).toBeVisible();
  expect(screen.queryByText("Demo Project")).not.toBeInTheDocument();

  await act(async () => {
    await appRouter.navigate("/projects");
  });
  expect(await screen.findByText("Project data is not connected to the native service yet.")).toBeVisible();
  expect(screen.queryByText("Demo Project")).not.toBeInTheDocument();
});

it("keeps the production settings route behind the native settings contract", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/settings");
  render(<AppRouter />);

  expect(await screen.findByText("settings_query is unavailable until the native contract is generated.")).toBeVisible();
});
