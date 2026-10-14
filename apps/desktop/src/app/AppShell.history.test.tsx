import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../i18n";
import type { BootstrapSnapshot } from "../api/bindings";
import type { BootstrapVerificationState } from "../features/bootstrap/api";
import { AppShell, resolveShellHistoryControls, resolveSubRouteFallback } from "./AppShell";

async function renderShellAt(
  initialEntries: string[],
  initialIndex: number,
): Promise<void> {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <MemoryRouter initialEntries={initialEntries} initialIndex={initialIndex}>
      <I18nextProvider i18n={i18n}>
        <AppShell
          refreshSnapshot={async () => undefined}
          snapshot={{} as unknown as BootstrapSnapshot}
          verification={{ kind: "idle" } as unknown as BootstrapVerificationState}
        />
        <Routes>
          <Route path="/" element={<p>overview body</p>} />
          <Route path="/agents" element={<p>agents body</p>} />
          <Route path="/agents/codex-cli" element={<p>agent detail body</p>} />
          <Route path="/library" element={<LibraryProbe />} />
          <Route path="/__preview/skill-library" element={<LibraryProbe label="preview library body" />} />
          <Route path="/library/:skillId" element={<p>skill detail body</p>} />
          <Route path="/library/:skillId/deploy" element={<p>deploy body</p>} />
        </Routes>
      </I18nextProvider>
    </MemoryRouter>,
  );
}

function LibraryProbe({ label = "library body" }: { label?: string }) {
  const location = useLocation();
  return <p>{label} {location.search}</p>;
}

function seedCurrentHistoryEntry(idx: number | null): void {
  window.history.replaceState(
    idx === null ? null : { usr: null, key: "seed", idx },
    "",
  );
}

describe("resolveShellHistoryControls", () => {
  it("hides back on main tab routes while keeping forward reachable", () => {
    const controls = resolveShellHistoryControls({ idx: 0, length: 4 }, null);
    expect(controls.showBack).toBe(false);
    expect(controls.canGoForward).toBe(true);
  });

  it("shows back on sub-routes and forward stays reachable at older entries", () => {
    const controls = resolveShellHistoryControls({ idx: 3, length: 5 }, "/library");
    expect(controls.showBack).toBe(true);
    expect(controls.canGoForward).toBe(true);
  });

  it("disables forward at the newest history entry and without history data", () => {
    const newest = resolveShellHistoryControls({ idx: 2, length: 3 }, "/agents");
    expect(newest.showBack).toBe(true);
    expect(newest.canGoForward).toBe(false);

    const unknown = resolveShellHistoryControls({ idx: null, length: 1 }, "/agents");
    expect(unknown.canGoForward).toBe(false);
  });
});

describe("resolveSubRouteFallback", () => {
  it("returns from a directly opened Skill detail to the filtered library focused on that Skill", () => {
    expect(resolveSubRouteFallback("/library/skill-pdf", "?q=pdf&sort=name")).toBe(
      "/library?q=pdf&sort=name&skill=skill-pdf",
    );
  });

  it("keeps preview details within the preview library and focuses the current Skill", () => {
    expect(resolveSubRouteFallback("/__preview/skill-detail/skill-pdf", "?q=pdf&detailPrototype=old")).toBe(
      "/__preview/skill-library?q=pdf&skill=skill-pdf",
    );
  });

  it("does not reinterpret malformed, empty, or non-detail library routes as Skills", () => {
    expect(resolveSubRouteFallback("/library/%E0%A4%A")).toBeNull();
    expect(resolveSubRouteFallback("/library/%20")).toBeNull();
    expect(resolveSubRouteFallback("/library/combinations")).toBe("/library");
    expect(resolveSubRouteFallback("/library/skill-pdf/deploy")).toBe("/library");
    expect(resolveSubRouteFallback("/library/skill-pdf/security")).toBe("/library");
  });
});

describe("AppShell history buttons", () => {
  afterEach(() => {
    seedCurrentHistoryEntry(null);
  });

  it("keeps back hidden and forward disabled on the overview route", async () => {
    await renderShellAt(["/"], 0);

    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it("shows an enabled back button on sub-routes and falls back to the parent tab", async () => {
    // jsdom 的 MemoryRouter 不写 window.history.state：idx 为 null 时
    // 返回按钮仍经父路由 fallback 生效（对应"直接打开子路由"场景）。
    await renderShellAt(["/agents", "/agents/codex-cli"], 1);

    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toBeEnabled();
    const user = userEvent.setup();
    await user.click(back);
    expect(await screen.findByText("agents body")).toBeVisible();
  });

  it("shows titlebar back on direct Skill detail routes and focuses that Skill in the library fallback", async () => {
    await renderShellAt(["/library/skill-pdf?q=pdf"], 0);

    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toBeEnabled();
    await userEvent.setup().click(back);
    expect(await screen.findByText("library body ?q=pdf&skill=skill-pdf")).toBeVisible();
  });

  it("keeps a directly opened preview detail within the preview library", async () => {
    await renderShellAt(["/__preview/skill-detail/skill-pdf?q=pdf"], 0);

    await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("preview library body ?q=pdf&skill=skill-pdf")).toBeVisible();
  });

  it("prefers real history over the parent fallback when history position data exists", async () => {
    await renderShellAt(["/", "/agents/codex-cli"], 1);
    // 模拟 BrowserRouter 已写入的位置标记（react-router 用 idx 记录历史深度）。
    seedCurrentHistoryEntry(1);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("overview body")).toBeVisible();
  });

  it("enables forward after going back and navigates to the newer entry", async () => {
    // 先推入一条历史把窗口历史拉长，再让当前条目处于较旧位置。
    window.history.pushState(
      { usr: null, key: "seed-old", idx: window.history.length - 1 },
      "",
    );
    seedCurrentHistoryEntry(window.history.length - 2);

    await renderShellAt(["/library", "/library/skill-pdf/deploy"], 0);

    const forward = screen.getByRole("button", { name: "Forward" });
    expect(forward).toBeEnabled();
    const user = userEvent.setup();
    await user.click(forward);
    expect(await screen.findByText("deploy body")).toBeVisible();
  });
});
