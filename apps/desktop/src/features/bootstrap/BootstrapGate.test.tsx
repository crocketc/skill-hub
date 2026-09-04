import { act, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { OverviewPage } from "../overview/OverviewPage";
import { BootstrapGate } from "./BootstrapGate";
import type { BootstrapView } from "./api";
import type { ScanResult } from "../../api/bindings";

const emptyScanResult: ScanResult = {
  generation: { generation: 1, observed_at: 1 },
  roots: [],
  discovered: [],
  visited_paths: [],
  reparsed_count: 0,
  unchanged_count: 0,
  errors: [],
};

const cachedSnapshot = {
  agent_count: 3,
  deployed_count: 9,
  deployment_categories: [],
  initialization_state: "initialized" as const,
  last_scan_at: null,
  library_path: "C:\\Users\\Test\\SkillHub",
  onboarding_skipped: false,
  pending: { by_kind: {}, total: 0 },
  project_count: 5,
  recent_operations: [],
  recovery_state: "clean" as const,
  skill_count: 42,
};

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

async function renderBootstrapGate(view: BootstrapView) {
  mockBrowserPreferences();
  const i18n = await createSkillHubI18n(["zh-CN"]);

  await act(async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route
                element={
                  <BootstrapGate
                    runtime={{
                      getBootstrapView: async () => view,
                      runInitializationScan: async () => ({ kind: "completed", result: emptyScanResult }),
                    }}
                  />
                }
                path="/"
              >
                <Route index element={<OverviewPage />} />
              </Route>
              <Route element={<h1>初始化向导</h1>} path="/initialize" />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </I18nextProvider>,
    );
  });
}

it("routes a fresh local profile to initialization", async () => {
  await renderBootstrapGate({
    snapshot: {
      ...cachedSnapshot,
      initialization_state: "not_initialized" as const,
    },
    verification: { kind: "unavailable" },
  });

  expect(await screen.findByRole("heading", { name: "初始化向导" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "概览" })).not.toBeInTheDocument();
});

it("shows cached home data while filesystem verification continues", async () => {
  await renderBootstrapGate({
    snapshot: cachedSnapshot,
    verification: { kind: "unavailable" },
  });

  expect(await screen.findAllByText("42")).toHaveLength(1);
  expect(screen.queryByText("正在核对本地变化")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("progressbar", { name: "阻塞启动" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "概览" })).toBeVisible();
  expect(screen.getByRole("link", { name: "设置" })).toBeVisible();
});

it("shows background verification only when the injected view says it is active", async () => {
  await renderBootstrapGate({
    snapshot: cachedSnapshot,
    verification: { kind: "verifying" },
  });

  expect(await screen.findByText("正在核对本地变化")).toBeVisible();
});

it("blocks only for a truthful recovery state", async () => {
  await renderBootstrapGate({
    snapshot: { ...cachedSnapshot, recovery_state: "needs_recovery" as const },
    verification: { kind: "unavailable" },
  });

  expect(await screen.findByText("需要恢复后才能继续")).toBeVisible();
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.queryByRole("progressbar", { name: "阻塞启动" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "概览" })).not.toBeInTheDocument();
});

it("names an in-progress recovery without pretending it is complete", async () => {
  await renderBootstrapGate({
    snapshot: { ...cachedSnapshot, recovery_state: "in_progress" as const },
    verification: { kind: "unavailable" },
  });

  expect(await screen.findByText("正在恢复本地数据")).toBeVisible();
  expect(screen.getByRole("progressbar", { name: "阻塞启动" })).toBeVisible();
});
