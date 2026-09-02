import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, vi } from "vitest";
import type { BootstrapSnapshot } from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { OverviewPage } from "./OverviewPage";

const overviewSnapshot: BootstrapSnapshot = {
  initialization_state: "initialized",
  library_path: "C:\\Users\\Test\\SkillHub",
  onboarding_skipped: false,
  agent_count: 3,
  deployed_count: 18,
  deployment_categories: [
    { count: 12, dimension: "agent", key: "openai.codex-cli", label_code: "Codex" },
    { count: 3, dimension: "agent", key: "anthropic.claude-code", label_code: "Claude Code" },
    { count: 3, dimension: "project", key: "project-aurora", label_code: "Aurora" },
  ],
  last_scan_at: null,
  pending: { by_kind: { recovery: 1, security_finding: 2, trial_due: 1 }, total: 4 },
  project_count: 2,
  recent_operations: [
    {
      created_at: "2026-08-24T08:00:00Z",
      error_code: null,
      kind: "Should not display",
      operation_id: "operation-1",
      phase: "committed",
      state: "completed",
    },
  ],
  recovery_state: "clean",
  skill_count: 12,
};

const manyProjectCategories = Array.from({ length: 12 }, (_, index) => ({
  count: 12 - index,
  dimension: "project" as const,
  key: `project-${index + 1}`,
  label_code: `Project ${index + 1}`,
}));

function LocationDisplay() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function OverviewRoute({ snapshot }: { snapshot: BootstrapSnapshot }) {
  return <Outlet context={snapshot} />;
}

function mockBrowserPreferences() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? false : false,
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

async function renderOverview(snapshot = overviewSnapshot) {
  const i18n = await createSkillHubI18n(["en-US"]);
  mockBrowserPreferences();

  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<OverviewRoute snapshot={snapshot} />}>
              <Route index element={<OverviewPage />} />
              <Route path="agents/:agentKey" element={<LocationDisplay />} />
              <Route path="projects/:projectKey" element={<LocationDisplay />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </I18nextProvider>,
  );
}

it("renders proportional agent deployments with a visible text equivalent and drills into its deployment workspace", async () => {
  await renderOverview();

  expect(await screen.findByRole("img", { name: "Deployment count by agent" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "View Codex's 12 deployments" }),
  ).toHaveTextContent("Codex 12");
  expect(
    screen.getByRole("button", { name: "View Claude Code's 3 deployments" }),
  ).toHaveTextContent("Claude Code 3");
  expect(screen.getByRole("list", { name: "Deployment count details" })).toHaveTextContent(
    "Codex 12Claude Code 3",
  );

  fireEvent.click(screen.getByRole("button", { name: "View Codex's 12 deployments" }));

  expect(screen.getByTestId("location")).toHaveTextContent(
    "/agents/openai.codex-cli?view=deployments",
  );
});

it("switches to project relationships and drills into the truthful project destination", async () => {
  await renderOverview();

  fireEvent.click(screen.getByRole("radio", { name: "Projects" }));

  expect(await screen.findByRole("img", { name: "Deployment count by project" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "View Aurora's 3 deployments" }),
  ).toHaveTextContent("Aurora 3");
  fireEvent.click(screen.getByRole("button", { name: "View Aurora's 3 deployments" }));

  expect(screen.getByTestId("location")).toHaveTextContent(
    "/projects/project-aurora?view=deployments",
  );
});

it("moves every deployment detail into the right rail while the project chart reports its top ten", async () => {
  await renderOverview({
    ...overviewSnapshot,
    deployment_categories: [
      ...overviewSnapshot.deployment_categories.filter(({ dimension }) => dimension === "agent"),
      ...manyProjectCategories,
    ],
    project_count: 12,
  });

  fireEvent.click(screen.getByRole("radio", { name: "Projects" }));

  const detailRegion = screen.getByRole("region", { name: "Deployment count details" });
  expect(detailRegion.parentElement).toHaveClass("sh-overview__rail");
  expect(within(detailRegion).getAllByRole("button", { name: /View Project/ })).toHaveLength(12);
  expect(
    within(detailRegion).getByRole("region", { name: "Scrollable deployment details" }),
  ).toHaveAttribute("tabindex", "0");
  expect(screen.getByText("Showing the top 10 of 12 projects")).toBeVisible();
  expect(document.querySelector(".sh-overview__panel .sh-overview__chart-list")).toBeNull();
});

it("shows the pending summary without exposing the recent-operation log", async () => {
  await renderOverview();

  expect(screen.getByText("12 skills")).toBeVisible();
  expect(screen.getByText("3 agents")).toBeVisible();
  expect(screen.getByText("2 projects")).toBeVisible();
  expect(screen.getByText("18 deployments")).toBeVisible();
  expect(screen.getByRole("heading", { name: "4 pending items" })).toBeVisible();
  expect(screen.getByText("2 security findings")).toBeVisible();
  expect(screen.getByText("1 recovery action")).toBeVisible();
  expect(screen.getByText("1 trial due")).toBeVisible();
  expect(screen.queryByText("Should not display")).not.toBeInTheDocument();
});

it("explains when the selected deployment dimension has no relationships", async () => {
  await renderOverview({
    ...overviewSnapshot,
    deployment_categories: [],
    pending: { by_kind: {}, total: 0 },
  });

  expect(screen.getByRole("status")).toHaveTextContent("No deployment relationships by agent yet");
  expect(screen.queryByRole("img", { name: "Deployment count by agent" })).not.toBeInTheDocument();
  expect(screen.getByText("No pending items")).toBeVisible();
});
