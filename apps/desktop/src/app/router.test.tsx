import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, vi } from "vitest";
import { skillHubI18n } from "../i18n";
import { nativeSkillLibraryFacade } from "../features/skills/nativeApi";
import {
  nativeOperationFacade,
  nativeRecentOperations,
} from "../features/operations/nativeApi";
import { sidebarNavigationEnd } from "./Sidebar";
import { resolveRouteTitleKey, resolveSubRouteFallback } from "./AppShell";
import { queryClient } from "./queryClient";
import { appRouter, AppRouter } from "./router";
import { installDomAbortPrimitives } from "../test-setup";
import { desktopBootstrapRuntime } from "../features/bootstrap/api";

vi.mock("../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/bindings")>();
  return {
    ...original,
    queryApplication: vi.fn(async (query: { type: string }) => {
      if (query.type === "get_discovery_snapshot") {
        return { type: "discovery_snapshot" as const, payload: { generation: "g", observed_at: "now", instances: [], logical_targets: [], physical_targets: [] } };
      }
      if (query.type === "list_custom_agents") return { type: "custom_agents" as const, payload: [] };
      if (query.type === "list_deployments") return { type: "deployments" as const, payload: [] };
      if (query.type === "list_projects") return { type: "projects" as const, payload: [] };
      if (query.type === "list_pending_items") return { type: "pending_items" as const, payload: [] };
      if (query.type === "get_desktop_preferences") return {
        type: "desktop_preferences" as const,
        payload: {
          network_enabled: true,
          llm_provider: "",
          data_scope: "explicit_selection",
          language: "system",
          theme: "moss-neutral",
          density: "standard",
          automation_per_skill: false,
          automation_batch: false,
          automation_global: false,
          backup_location: "",
          backup_retention_days: 30,
        },
      };
      if (query.type === "get_application_update_policy") return {
        type: "application_update_policy" as const,
        payload: { enabled: true, check_on_startup: true },
      };
      return { type: "bootstrap_snapshot" as const, payload: {
        initialization_state: "initialized" as const,
        library_path: "C:\\Users\\Test\\SkillHub",
        onboarding_skipped: false,
        agent_count: 0,
        discovered_agent_count: 0,
        deployed_count: 0,
        deployment_categories: [],
        tag_categories: [],
        last_scan_at: null,
        pending: { by_kind: {}, total: 0 },
        project_count: 0,
        recent_operations: [],
        recovery_state: "clean" as const,
        skill_count: 0,
      } };
    }),
  };
});

/** 记录生产入口 MotionConfig 的配置，锁定“减少动效跟随系统”的契约。 */
const motionConfigProps: Array<{ reducedMotion?: unknown }> = [];
vi.mock("motion/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("motion/react")>();
  type MotionConfigProps = React.ComponentProps<(typeof original)["MotionConfig"]>;
  return {
    ...original,
    MotionConfig: (props: MotionConfigProps) => {
      motionConfigProps.push({ reducedMotion: props.reducedMotion });
      return createElement(original.MotionConfig, props, props.children);
    },
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

it("keeps AbortController and AbortSignal in the same DOM realm", () => {
  installDomAbortPrimitives();

  const controller = new AbortController();
  expect(globalThis.AbortSignal).toBe(window.AbortSignal);
  expect(globalThis.AbortController).toBe(window.AbortController);
  expect(controller.signal).toBeInstanceOf(window.AbortSignal);
});

it("accepts a DOM AbortSignal in the native Request constructor", () => {
  installDomAbortPrimitives();

  const controller = new AbortController();
  expect(controller.signal.constructor).toBe(
    new Request("http://localhost/").signal.constructor,
  );
  expect(() =>
    new Request("http://localhost/", {
      signal: controller.signal,
    }),
  ).not.toThrow();
});

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

it("follows the system reduced-motion preference at the production entry (TC-GR-09-M02)", async () => {
  // v0.2.0 契约是“跟随系统减少动效”（US-057），不提供应用内开关。
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/");

  render(<AppRouter />);

  expect(await screen.findAllByText("0 skills")).toHaveLength(1);
  expect(motionConfigProps.some((props) => props.reducedMotion === "user")).toBe(true);
});

it("surfaces an unavailable state when the native Skill library result is not connected", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/library");
  const listSkills = vi.spyOn(nativeSkillLibraryFacade, "listSkills");

  render(<AppRouter />);

  expect(
    await screen.findByText("Skill catalog data is not connected yet"),
  ).toBeVisible();
  expect(listSkills).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
});

it("surfaces an unavailable state when the native Skill detail result is not connected", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/library/skill-pdf");

  render(<AppRouter />);

  expect(await screen.findByText("Skill detail data is not connected yet")).toBeVisible();
  expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
});

it("does not expose first-run initialization branches when the bootstrap snapshot is unavailable", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  const getBootstrapView = vi
    .spyOn(desktopBootstrapRuntime, "getBootstrapView")
    .mockRejectedValue(new Error("bootstrap unavailable"));
  try {
    await appRouter.navigate("/initialize");

    render(<AppRouter />);

    expect(await screen.findByText("Bootstrap status is unavailable. Initialization and rediscovery are temporarily unavailable.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create a new library" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use an existing library" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore from a backup" })).not.toBeInTheDocument();
  } finally {
    getBootstrapView.mockRestore();
  }
});

it("isolates deterministic Skill detail preview data from production", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/__preview/skill-detail/skill-pdf");

  render(<AppRouter />);
  expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Skill library" })).not.toBeInTheDocument();
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

it("keeps the Skill library shell title on the library route", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/__preview/skill-library");

  render(<AppRouter />);

  expect(await screen.findByRole("heading", { name: "Skill library" })).toBeVisible();
});

it("isolates development preview data from the production Skill library route", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/__preview/skill-library");

  render(<AppRouter />);

  expect(await screen.findByText("PDF Reader")).toBeVisible();
  expect(screen.getByRole("link", { name: "Skill library" })).toHaveAttribute(
    "aria-current",
    "page",
  );

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
  expect(resolveRouteTitleKey("/recovery")).toBe("navigation.operations");
});

it("offers a topbar back target for sub-routes and none for main tabs", () => {
  expect(resolveSubRouteFallback("/agents/openai.codex-cli")).toBe("/agents");
  expect(resolveSubRouteFallback("/projects/project-aurora")).toBe("/projects");
  expect(resolveSubRouteFallback("/library/skill-pdf/deploy")).toBe("/library");
  expect(resolveSubRouteFallback("/deploy")).toBe("/library");
  expect(resolveSubRouteFallback("/library/skill-pdf/security")).toBe("/library");
  expect(resolveSubRouteFallback("/operations/op-1")).toBe("/operations");
  expect(resolveSubRouteFallback("/settings/data-protection")).toBe("/settings");
  expect(resolveSubRouteFallback("/agents")).toBeNull();
  expect(resolveSubRouteFallback("/library")).toBeNull();
  expect(resolveSubRouteFallback("/settings")).toBeNull();
  expect(resolveSubRouteFallback("/")).toBeNull();
  expect(resolveSubRouteFallback("/initialize")).toBeNull();
});

it("renders a topbar back button on sub-routes that returns to the parent tab", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("zh-CN");

  await appRouter.navigate("/settings");
  await appRouter.navigate("/settings/data-protection");
  render(<AppRouter />);

  const back = await screen.findByRole("button", { name: "返回" });
  await act(async () => {
    fireEvent.click(back);
  });

  await waitFor(() => expect(appRouter.state.location.pathname).toBe("/settings"));
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

it("uses native empty results for Agents, projects and pending work in production", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/agents");
  render(<AppRouter />);

  expect(await screen.findByRole("heading", { name: "Agents" })).toBeVisible();
  expect(screen.queryByText("Agent data is not connected to the native service yet.")).not.toBeInTheDocument();
  expect(screen.queryByText("Demo Project")).not.toBeInTheDocument();

  await act(async () => {
    await appRouter.navigate("/projects");
  });
  expect(await screen.findByText("No projects match the current filters.")).toBeVisible();
  expect(screen.queryByText("Demo Project")).not.toBeInTheDocument();

  await act(async () => {
    await appRouter.navigate("/pending");
  });
  expect(await screen.findByText("No pending items")).toBeVisible();
});

it("renders real operation records at /operations and keeps the single operation detail route", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("zh-CN");
  await appRouter.navigate("/operations");
  const listRecentOperations = vi
    .spyOn(nativeRecentOperations, "listRecentOperations")
    .mockResolvedValue([
      {
        operation_id: "op-42",
        kind: "import",
        state: "committed",
        phase: "committed",
        error_code: null,
        created_at: "2026-09-07T10:00:00Z",
      },
    ]);
  const getOperation = vi
    .spyOn(nativeOperationFacade, "get")
    .mockReturnValue(new Promise(() => {}));

  render(<AppRouter />);

  expect(await screen.findByRole("heading", { name: "操作记录" })).toBeVisible();
  expect(await screen.findByRole("link", { name: "import" })).toHaveAttribute(
    "href",
    "/operations/op-42",
  );
  expect(getOperation).not.toHaveBeenCalled();

  await act(async () => {
    await appRouter.navigate("/operations/op-1");
  });
  expect(await screen.findByText("正在加载操作")).toBeVisible();
  expect(getOperation).toHaveBeenCalledWith("op-1");

  listRecentOperations.mockRestore();
  getOperation.mockRestore();
});

it("loads the production settings route from native preferences", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/settings");
  render(<AppRouter />);

  expect(await screen.findByRole("heading", { name: "Settings" })).toBeVisible();
  expect(await screen.findByText("C:\\Users\\Test\\SkillHub")).toBeVisible();
  expect(screen.queryByText("settings_query is unavailable until the native contract is generated.")).not.toBeInTheDocument();
});
