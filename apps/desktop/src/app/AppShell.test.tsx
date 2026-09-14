import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../i18n";
import type { BootstrapSnapshot, ScanResult } from "../api/bindings";
import type { BootstrapVerificationState } from "../features/bootstrap/api";
import {
  beginBackgroundScan,
  resetBackgroundScan,
} from "../features/bootstrap/backgroundScan";
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
    const heading = within(topbar as HTMLElement).getByRole("heading", { level: 1 });
    expect(heading).toHaveAttribute("data-tauri-drag-region");
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

  it("keeps the notification center reachable on skill detail routes", async () => {
    await renderShell("/library/obsidian-git");

    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(bell).toBeVisible();
    expect(screen.getByRole("heading", { name: "Skill library" })).toBeVisible();

    const user = userEvent.setup();
    await user.click(bell);
    expect(await screen.findByRole("dialog", { name: "Notifications" })).toBeVisible();
  });

  it("keeps the shell topbar visible on the combination manager route without the view switch", async () => {
    await renderShell("/library/combinations");

    expect(screen.getByRole("heading", { name: "Skill library" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Back" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "View mode" })).not.toBeInTheDocument();
  });
});
