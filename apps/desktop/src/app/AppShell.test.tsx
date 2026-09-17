import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { BrowserRouter, Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../i18n";
import baseCss from "../styles/base.css?raw";
import type { BootstrapSnapshot, ScanResult } from "../api/bindings";
import type { BootstrapVerificationState } from "../features/bootstrap/api";
import {
  beginBackgroundScan,
  resetBackgroundScan,
} from "../features/bootstrap/backgroundScan";
import { useRelationshipsReturnState } from "../features/relationships/returnState";
import { AppShell } from "./AppShell";

// D5 一体化标题栏：平台能力与 macOS 类标记经 mock 注入，既让默认用例
// 拿到 null chrome（WindowControls 无痕），也能驱动集成断言。
const windowChromeMocks = vi.hoisted(() => ({
  chrome: null as unknown,
  applyPlatformClass: vi.fn(),
}));

vi.mock("../platform/windowChrome", () => ({
  resolveWindowChrome: () => windowChromeMocks.chrome,
  applyWindowChromePlatformClass: windowChromeMocks.applyPlatformClass,
}));

const completedScan: ScanResult = {
  generation: { generation: 1, observed_at: 1 },
  roots: [],
  discovered: [],
  visited_paths: [],
  reparsed_count: 0,
  unchanged_count: 0,
  errors: [],
};

afterEach(() => {
  resetBackgroundScan();
  windowChromeMocks.chrome = null;
  windowChromeMocks.applyPlatformClass.mockClear();
  sessionStorage.clear();
  relationshipsLibraryRows = 0;
});

async function renderShell(initialPath = "/") {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <I18nextProvider i18n={i18n}>
        <AppShell
          refreshSnapshot={async () => undefined}
          snapshot={{} as unknown as BootstrapSnapshot}
          verification={{ kind: "idle" } as unknown as BootstrapVerificationState}
        />
      </I18nextProvider>
    </MemoryRouter>,
  );
}

// —— 任务 5：关系页回退规则（图谱/治理/技能库按来源隔离，跨模块不串状态）——
// 假页面使用与任务 6/7/8 相同的 useRelationshipsReturnState 契约。

function FakeGraphPage() {
  const { initialState, saveState } = useRelationshipsReturnState("graph");
  return (
    <section aria-label="Fake graph">
      <h1>Fake graph</h1>
      <p>center:{initialState?.filters?.center ?? "none"}</p>
      <p>zoom:{initialState?.viewport ? initialState.viewport.zoom : "none"}</p>
      <Link to="/relationships/governance">go-governance</Link>
      <button
        onClick={() =>
          saveState({
            filters: { center: "skill-pdf" },
            viewport: { x: 10, y: 20, zoom: 3 },
          })
        }
      >
        save-graph-state
      </button>
    </section>
  );
}

function FakeGovernancePage() {
  const { initialState, saveState } = useRelationshipsReturnState("governance");
  return (
    <section aria-label="Fake governance">
      <h1>Fake governance</h1>
      <p>bucket:{initialState?.filters?.bucket ?? "none"}</p>
      <p>selected:{initialState?.selectedId ?? "none"}</p>
      <p>scroll:{initialState?.scrollY ?? "none"}</p>
      <Link to="/library">go-library</Link>
      <button
        onClick={() =>
          saveState({
            filters: { bucket: "needs_validation" },
            selectedId: "edge-7",
            scrollY: 420,
          })
        }
      >
        save-governance-state
      </button>
    </section>
  );
}

/** 技能库保持自身既有列表状态：走自己的存储，绝不读 relationships 命名空间。 */
let relationshipsLibraryRows = 0;

function FakeLibraryPage() {
  // 挂载时从“库自己的存储”（模块变量模拟）读取，点击后写回并同步视图。
  const [rows, setRows] = useState(() => relationshipsLibraryRows);
  return (
    <section aria-label="Fake library">
      <h1>Fake library</h1>
      <p>library-rows:{rows}</p>
      <button
        onClick={() => {
          relationshipsLibraryRows = 42;
          setRows(42);
        }}
      >
        save-library-state
      </button>
    </section>
  );
}

async function renderShellWithRelationshipPages(initialPath: string) {
  const i18n = await createSkillHubI18n(["en-US"]);
  window.history.replaceState(null, "", initialPath);
  render(
    <BrowserRouter>
      <I18nextProvider i18n={i18n}>
        <Routes>
          <Route
            element={
              <AppShell
                refreshSnapshot={async () => undefined}
                snapshot={{} as unknown as BootstrapSnapshot}
                verification={{ kind: "idle" } as unknown as BootstrapVerificationState}
              />
            }
          >
            <Route element={<FakeGraphPage />} path="/relationships" />
            <Route element={<FakeGovernancePage />} path="/relationships/governance" />
            <Route element={<FakeLibraryPage />} path="/library" />
          </Route>
        </Routes>
      </I18nextProvider>
    </BrowserRouter>,
  );
}

describe("AppShell", () => {
  it("exposes exactly one main landmark inside the sidebar/workspace shell columns", async () => {
    await renderShell();

    expect(screen.getAllByRole("main")).toHaveLength(1);

    const shell = document.querySelector(".sh-app-shell");
    expect(shell).not.toBeNull();
    expect(shell!.querySelector(".sh-sidebar")).not.toBeNull();
    expect(shell!.querySelector(".sh-app-shell__workspace")).not.toBeNull();
  });

  it("offers a skip link as the first focusable element and targets the main region", async () => {
    const user = userEvent.setup();
    await renderShell();

    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus();

    const skipLink = screen.getByRole("link", { name: "Skip to content" });
    const main = screen.getByRole("main");
    expect(skipLink).toHaveAttribute("href", `#${main.id}`);
    expect(main).toHaveAttribute("tabindex", "-1");
  });

  it("leads the shell with the sidebar toggle right after the skip link in tab order", async () => {
    const user = userEvent.setup();
    await renderShell();

    await user.tab();
    await user.tab();
    const toggle = screen.getByRole("button", { name: "Collapse navigation" });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses the sidebar from the title-bar toggle", async () => {
    const user = userEvent.setup();
    await renderShell();

    await user.click(screen.getByRole("button", { name: "Collapse navigation" }));

    const toggle = screen.getByRole("button", { name: "Expand navigation" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("complementary", { name: "Main navigation" })).toHaveClass("is-collapsed");
    expect(document.querySelector(".sh-app-shell")).toHaveClass("is-sidebar-collapsed");
  });

  it("renders drag regions across the sidebar header and content title bar", async () => {
    await renderShell();

    const sidebarHeader = document.querySelector(".sh-sidebar__header");
    const topbar = document.querySelector(".sh-app-shell__topbar");
    expect(sidebarHeader).toHaveAttribute("data-tauri-drag-region");
    expect(topbar).toHaveAttribute("data-tauri-drag-region");
    expect(document.querySelector(".sh-app-shell__topbar-start")).toHaveAttribute(
      "data-tauri-drag-region",
    );
    expect(document.querySelector(".sh-app-shell__topbar-context")).toHaveAttribute(
      "data-tauri-drag-region",
    );
    expect(document.querySelector(".sh-app-shell__topbar-end")).toHaveAttribute(
      "data-tauri-drag-region",
    );
    // 顶栏标题自 2026-09-17 起不再是 heading（回归修复 §5.4），仍承担拖拽区域。
    const title = topbar!.querySelector(".sh-app-shell__title");
    expect(title).not.toBeNull();
    expect(title).toHaveAttribute("data-tauri-drag-region");
    // 按钮控件不承担拖拽区域。
    const toggle = document.querySelector(".sh-sidebar__toggle");
    expect(toggle).not.toHaveAttribute("data-tauri-drag-region");
  });

  it("keeps the sidebar toggle inside the sidebar header", async () => {
    await renderShell();

    const header = document.querySelector(".sh-sidebar__header");
    const toggle = document.querySelector(".sh-sidebar__toggle");
    expect(toggle).not.toBeNull();
    expect(header!.querySelector(".sh-sidebar__toggle")).toBe(toggle);
    expect(document.querySelector(".sh-app-shell__topbar-start .sh-sidebar__toggle")).toBeNull();
  });

  it("uses the Lucide Panel Left glyph at a compact size", async () => {
    await renderShell();

    const glyph = document
      .querySelector(".sh-sidebar__toggle")!
      .querySelector("svg");

    expect(glyph?.querySelector("rect")).not.toBeNull();
    expect(glyph?.querySelector('path[d="M9 3v18"]')).not.toBeNull();
    expect(glyph).toHaveAttribute("width", "14");
    expect(glyph).toHaveAttribute("height", "14");
  });

  it("shows the library view switch inside the title-bar context zone on /library", async () => {
    await renderShell("/library");

    const context = document.querySelector(".sh-app-shell__topbar-context");
    expect(context).not.toBeNull();
    expect(
      within(context as HTMLElement).getByRole("group", { name: "View mode" }),
    ).toBeVisible();
  });

  it("hides the library view switch outside the library tab", async () => {
    await renderShell("/");

    expect(screen.queryByRole("group", { name: "View mode" })).not.toBeInTheDocument();
  });

  it("places the compact brand in the content title bar only when the sidebar is collapsed", async () => {
    const user = userEvent.setup();
    await renderShell();

    expect(document.querySelector(".sh-app-shell__compact-brand")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Collapse navigation" }));

    const compactBrand = document.querySelector(".sh-app-shell__compact-brand");
    expect(compactBrand).not.toBeNull();
    expect(document.querySelector(".sh-app-shell__topbar-start")!.firstElementChild).toBe(
      compactBrand,
    );
    expect(compactBrand!.querySelector(".sh-brand-logo")).not.toBeNull();
    expect(
      screen.getByRole("complementary", { name: "Main navigation" }).querySelector(
        ".sh-sidebar__brand",
      ),
    ).toBeNull();
  });

  it("applies the window chrome platform class once on mount", async () => {
    await renderShell();

    expect(windowChromeMocks.applyPlatformClass).toHaveBeenCalledTimes(1);
  });

  it("mounts the native window controls after the notification bell", async () => {
    const unlisten = vi.fn();
    windowChromeMocks.chrome = {
      minimize: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      isMaximized: vi.fn(async () => false),
      onMaximizeChange: vi.fn(async () => unlisten),
    };
    await renderShell();

    const end = document.querySelector(".sh-app-shell__topbar-end") as HTMLElement;
    const controls = await waitFor(() => {
      const element = end.querySelector(".sh-window-controls");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    const bell = within(end).getByRole("button", { name: "Notifications" });
    expect(
      bell.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(controls).getByRole("button", { name: "Minimize" })).toBeVisible();
    expect(within(controls).getByRole("button", { name: "Maximize" })).toBeVisible();
    expect(within(controls).getByRole("button", { name: "Close" })).toBeVisible();
  });

  it("reports a handed-off background scan through the shell notification service", async () => {
    await renderShell();

    beginBackgroundScan(Promise.resolve({ kind: "completed", result: completedScan }), []);

    expect(await screen.findByText("Background scan finished")).toBeVisible();
  });

  it("centers the running task summary in the topbar context zone, coexisting with the view switch", async () => {
    await renderShell("/library");

    await act(async () => {
      beginBackgroundScan(new Promise(() => undefined), [], Date.now());
      await Promise.resolve();
    });

    // 摘要挂在 topbar-context（居中列），不在右侧操作簇。
    const context = document.querySelector(".sh-app-shell__topbar-context") as HTMLElement;
    const taskStatus = await waitFor(() => {
      const element = within(context).getByRole("status", {
        name: "Initialization read-only scan",
      });
      expect(element).toBeVisible();
      return element;
    });
    // 库路由：视图切换器与摘要并存，切换器在前（摘要紧随其后居中）。
    const viewSwitch = within(context).getByRole("group", { name: "View mode" });
    expect(viewSwitch.compareDocumentPosition(taskStatus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const end = document.querySelector(".sh-app-shell__topbar-end") as HTMLElement;
    expect(
      within(end).queryByRole("status", { name: "Initialization read-only scan" }),
    ).not.toBeInTheDocument();

    // 摘要区域仍先于通知中心/窗口控制簇（context → end 的 DOM 顺序）。
    const bell = within(end).getByRole("button", { name: "Notifications" });
    expect(context.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 布局契约：context 区居中承载摘要（设计口径“顶栏居中 360px 摘要”）。
    expect(baseCss).toMatch(
      /\.sh-app-shell__topbar-context\s*\{[^}]*justify-content:\s*center/,
    );

    // 摘要浮层可交互：点击触发器打开小浮层（不被 drag-region 吞掉）。
    await userEvent.setup().click(
      within(context).getByRole("button", { name: "Initialization read-only scan" }),
    );
    expect(await screen.findByRole("dialog", { name: "Background tasks" })).toBeVisible();
  });

  it("mounts the centered task summary in the context zone on non-library tabs", async () => {
    await renderShell("/");

    await act(async () => {
      beginBackgroundScan(new Promise(() => undefined), [], Date.now());
      await Promise.resolve();
    });

    const context = document.querySelector(".sh-app-shell__topbar-context") as HTMLElement;
    expect(
      await within(context).findByRole("status", { name: "Initialization read-only scan" }),
    ).toBeVisible();
    expect(within(context).queryByRole("group", { name: "View mode" })).not.toBeInTheDocument();
    const end = document.querySelector(".sh-app-shell__topbar-end") as HTMLElement;
    expect(
      within(end).queryByRole("status", { name: "Initialization read-only scan" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the notification center reachable on skill detail routes", async () => {
    await renderShell("/library/obsidian-git");

    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(bell).toBeVisible();
    // 顶栏标题保持可见（自 2026-09-17 起为非 heading 元素）。
    expect(document.querySelector(".sh-app-shell__title")).toHaveTextContent(
      "Skill library",
    );

    const user = userEvent.setup();
    await user.click(bell);
    expect(await screen.findByRole("dialog", { name: "Notifications" })).toBeVisible();
  });

  it("keeps the shell topbar visible on the combination manager route without the view switch", async () => {
    await renderShell("/library/combinations");

    expect(document.querySelector(".sh-app-shell__title")).toHaveTextContent(
      "Skill library",
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "View mode" })).not.toBeInTheDocument();
  });

  it("keeps the topbar title out of the heading outline (route-level h1 belongs to pages)", async () => {
    await renderShell();

    const topbar = document.querySelector(".sh-app-shell__topbar") as HTMLElement;
    const title = document.querySelector(".sh-app-shell__title");
    expect(title).not.toBeNull();
    expect(topbar.contains(title!)).toBe(true);
    expect(title).toHaveAttribute("data-tauri-drag-region");
    // 回归修复（基线 E2E §5.4）：顶栏标题不再是 heading，避免与页面级 h1 重复。
    expect(within(topbar).queryAllByRole("heading")).toHaveLength(0);
  });

  it("titles the relationships module in the topbar and keeps the tab free of a back button", async () => {
    await renderShell("/relationships");

    expect(document.querySelector(".sh-app-shell__title")).toHaveTextContent(
      "Skill relations",
    );
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("offers back to the relationships module from its sub-routes", async () => {
    const user = userEvent.setup();
    // jsdom 无真实历史条目：回退路径应落到父导航页（/relationships）。
    await renderShell("/relationships/governance");

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument(),
    );
    expect(document.querySelector(".sh-app-shell__title")).toHaveTextContent(
      "Skill relations",
    );
  });

  it("restores relationship return state per source and never bleeds across modules", async () => {
    const user = userEvent.setup();
    await renderShellWithRelationshipPages("/relationships?skillId=pdf-reader");

    // 图谱：保存中心/筛选/视口。
    await user.click(screen.getByRole("button", { name: "save-graph-state" }));

    // → 治理：保存筛选/选中行/滚动。
    await user.click(screen.getByRole("link", { name: "go-governance" }));
    await user.click(screen.getByRole("button", { name: "save-governance-state" }));

    // → 技能库：库保持自身列表状态（自己的存储，不经 relationships 命名空间）。
    await user.click(screen.getByRole("link", { name: "go-library" }));
    await user.click(screen.getByRole("button", { name: "save-library-state" }));
    expect(screen.getByText("library-rows:42")).toBeVisible();

    // 浏览器后退（popstate）→ 回到治理条目：恢复筛选/选中行/滚动；图谱状态不串入。
    window.history.back();
    expect(await screen.findByText("bucket:needs_validation")).toBeVisible();
    expect(screen.getByText("selected:edge-7")).toBeVisible();
    expect(screen.getByText("scroll:420")).toBeVisible();
    expect(screen.queryByText(/zoom:/)).not.toBeInTheDocument();

    // 顶栏返回（历史优先）→ 图谱条目：恢复中心/筛选/视口；治理状态不串入。
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("center:skill-pdf")).toBeVisible();
    expect(screen.getByText("zoom:3")).toBeVisible();
    expect(screen.queryByText(/selected:/)).not.toBeInTheDocument();

    // 技能库列表状态不受关系页往返影响（经侧栏真实入口回到技能库）。
    await user.click(screen.getByRole("link", { name: "Skill library" }));
    expect(await screen.findByText("library-rows:42")).toBeVisible();

    // 会话存储按 scope+历史条目命名空间隔离，仅两把关系页键。
    const keys = Object.keys(sessionStorage).filter((key) =>
      key.startsWith("skillhub:relationships:return-state:"),
    );
    expect(keys).toHaveLength(2);
    expect(keys.some((key) => key.includes(":graph:"))).toBe(true);
    expect(keys.some((key) => key.includes(":governance:"))).toBe(true);
  });
});
