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
import { appRouter, AppRouter, routePreloaders } from "./router";
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
      if (query.type === "list_skill_repos") {
        return {
          type: "skill_repos" as const,
          payload: [{ repo: { owner: "anthropics", name: "skills", branch: "main", enabled: true }, scan: null }],
        };
      }
      if (query.type === "list_custom_agents") return { type: "custom_agents" as const, payload: [] };
      if (query.type === "list_deployments") return { type: "deployments" as const, payload: [] };
      if (query.type === "list_projects") return { type: "projects" as const, payload: [] };
      // 任务 6 图谱画布：路由级环境没有候选事实，返回空候选让页面渲染发现 CTA 空态。
      if (query.type === "list_skill_relationship_candidates") {
        return { type: "skill_relationship_candidates" as const, payload: [] };
      }
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
      if (query.type === "list_relation_governance") return {
        type: "relation_governance_ledger" as const,
        payload: {
          rows: [],
          counts: { all: 0, eligible_to_centralize: 0, needs_validation: 0, blocked: 0 },
          bucket: "all" as const,
          total: 0,
          relationship_revision: "test-rev",
          last_verified_at: null,
        },
      };
      if (query.type === "list_governance_history") return {
        type: "governance_history_page" as const,
        payload: { items: [], total: 0, page: 1, page_size: 20 },
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

  expect(await screen.findAllByRole("link", { name: "0 Total skills" })).toHaveLength(1);
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

  expect(await screen.findAllByRole("link", { name: "0 Total skills" })).toHaveLength(1);
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
  // 新增01-4 验收修复：详情路由恢复标准顶栏，shell 标题 "Skill library" 应可见
  //（与下方 resolveRouteTitleKey("/__preview/skill-detail/...") 的单元断言一致）。
  // 2026-09-17 起顶栏标题为非 heading 元素（回归修复 §5.4）。
  expect(document.querySelector(".sh-app-shell__title")).toHaveTextContent("Skill library");
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

  // 顶栏标题为非 heading 元素（2026-09-17 回归修复 §5.4）。
  expect(await screen.findByText("PDF Reader")).toBeVisible();
  expect(document.querySelector(".sh-app-shell__title")).toHaveTextContent("Skill library");
});

it("mounts the DEV-only UI foundations preview board with theme switching", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("zh-CN");
  await appRouter.navigate("/__preview/ui-foundations");

  render(<AppRouter />);

  expect(
    await screen.findByRole("heading", { name: "UI foundations" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "grok-night" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "grok-night" }));

  expect(document.documentElement).toHaveAttribute("data-theme", "grok-night");
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
  expect(resolveSubRouteFallback("/discovery/local")).toBe("/discovery");
  expect(resolveSubRouteFallback("/discovery/online")).toBe("/discovery");
  expect(resolveSubRouteFallback("/discovery/repositories")).toBe("/discovery");
  expect(resolveSubRouteFallback("/discovery/lock")).toBe("/discovery");
  expect(resolveSubRouteFallback("/library/combinations")).toBe("/library");
  expect(resolveSubRouteFallback("/agents")).toBeNull();
  expect(resolveSubRouteFallback("/library")).toBeNull();
  expect(resolveSubRouteFallback("/discovery")).toBeNull();
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

  // 顶栏标题为非 heading 元素（2026-09-17 回归修复 §5.4）；侧栏高亮 Agents。
  await waitFor(() =>
    expect(document.querySelector(".sh-app-shell__title")).toHaveTextContent("Agents"),
  );
  expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");

  await act(async () => {
    await appRouter.navigate("/projects/project-aurora?view=deployments");
  });

  await waitFor(() =>
    expect(document.querySelector(".sh-app-shell__title")).toHaveTextContent("Projects"),
  );
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

  // 顶栏标题为非 heading 元素（2026-09-17 回归修复 §5.4）。
  await waitFor(() =>
    expect(document.querySelector(".sh-app-shell__title")).toHaveTextContent("Settings"),
  );
  // 分区化后库路径位于“Library maintenance”分区；切换分区确认真实偏好已加载。
  fireEvent.click(screen.getByRole("tab", { name: "Library maintenance" }));
  expect(await screen.findByText("C:\\Users\\Test\\SkillHub")).toBeVisible();
  expect(screen.queryByText("settings_query is unavailable until the native contract is generated.")).not.toBeInTheDocument();
});

it("routes /discovery/repositories to the standalone repository management page", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("zh-CN");
  await appRouter.navigate("/discovery/repositories");
  render(<AppRouter />);

  expect(await screen.findByRole("heading", { name: "仓库管理" })).toBeVisible();
  // 列表来自 list_skill_repos 查询（含逐仓视图载荷）。
  expect(await screen.findByText("anthropics/skills")).toBeVisible();
  // 发现子路由的壳层顶栏保留返回发现主页的锚点。
  expect(screen.getByRole("button", { name: "返回" })).toBeVisible();
});

// —— 任务 5：技能关系模块壳层（路由/预取/标题/嵌套回退）——

it("renders the three relationships routes with honest placeholders and module titles", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/relationships");
  render(<AppRouter />);

  // 模块标题只由顶栏承载，布局不再渲染重复 h1；用空态内容等待路由就绪。
  // 任务 6 已填充图谱画布：只读候选查询在无候选时渲染发现 CTA 的空态，
  // 不再是任务 5 的占位符；绝不触发扫描。
  expect(
    await screen.findByText("No Skill has displayable relationships yet."),
  ).toBeVisible();
  expect(document.querySelector(".sh-app-shell__title")).toHaveTextContent(
    "Skill relations",
  );
  expect(screen.getByRole("link", { name: "Open discovery" })).toHaveAttribute(
    "href",
    "/discovery?from=relationships",
  );

  await act(async () => {
    await appRouter.navigate("/relationships/decisions");
  });
  // 任务 7 已接入真实冲突处理工作台：路由 mock 不提供工作台投影查询，
  // 页面诚实呈现读取失败，而不是“尚未提供”占位。
  expect(
    await screen.findByText("The conflict workspace cannot be read right now."),
  ).toBeVisible();

  await act(async () => {
    await appRouter.navigate("/relationships/governance");
  });
  // 任务 8：治理插槽已换成真实工作台——普通添加入口与治理清单的诚实空态，
  // 不再渲染"尚未提供"占位。
  expect(await screen.findByTestId("governance-deploy-entry")).toBeVisible();
  expect(
    await screen.findByText(
      "Relationships are in good shape; there is no relationship change to handle.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByText(
      "The relationship governance workbench is not available yet; the governance panel on Skill details remains available.",
    ),
  ).not.toBeInTheDocument();
});

it("renders the governance history route as a sub-page of the governance workbench", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");
  await appRouter.navigate("/relationships/governance/history");
  render(<AppRouter />);

  // 任务 12A：治理历史是治理清单的下级页面——独立路由、可返回清单，
  // 不复用清单页本身（清单页有工作台空态，历史页有独立标题）。
  expect(await screen.findByTestId("governance-history-page")).toBeVisible();
  expect(screen.getByRole("heading", { level: 1, name: "Governance history" })).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Back to governance list" }),
  ).toHaveAttribute("href", "/relationships/governance");
  expect(await screen.findByText("No governance history yet")).toBeVisible();
});

it("preloads the relationships chunk and maps module titles with nested fallbacks", async () => {
  expect(routePreloaders["/relationships"]).toBeTypeOf("function");
  const chunk = (await routePreloaders["/relationships"]()) as Record<string, unknown>;
  expect(chunk.RelationshipsGraphPage).toBeTypeOf("function");
  expect(chunk.RelationshipsDecisionsPage).toBeTypeOf("function");
  expect(chunk.RelationshipsGovernancePage).toBeTypeOf("function");

  expect(resolveRouteTitleKey("/relationships")).toBe("relationships.nav");
  expect(resolveRouteTitleKey("/relationships/decisions")).toBe("relationships.nav");
  expect(resolveRouteTitleKey("/relationships/governance")).toBe("relationships.nav");
  expect(resolveSubRouteFallback("/relationships")).toBeNull();
  expect(resolveSubRouteFallback("/relationships/decisions")).toBe("/relationships");
  expect(resolveSubRouteFallback("/relationships/governance")).toBe("/relationships");
});

it("offers the shell back button on relationships sub-routes returning to the module", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("zh-CN");
  // 先进入模块主页再进入子页：历史优先回退落在 /relationships。
  await appRouter.navigate("/relationships");
  await appRouter.navigate("/relationships/decisions");
  render(<AppRouter />);

  const back = await screen.findByRole("button", { name: "返回" });
  await act(async () => {
    fireEvent.click(back);
  });
  await waitFor(() =>
    expect(appRouter.state.location.pathname).toBe("/relationships"),
  );
});
