import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { OverviewPage } from "./OverviewPage";
import { OverviewPreviewShell, overviewPreviewRelationshipsFacade } from "./OverviewPreview";
import overviewCss from "./overview.css?raw";

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
  // 任务 10：预览桩注入确定性关系事实（任务 9 §7.4 桩需求），e2e 几何与
  // 深链断言在真实渲染路径（router QueryClientProvider + facade）下运行。
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/__preview/overview"]}>
            <Routes>
              <Route element={<OverviewPreviewShell />} path="__preview/overview">
                <Route
                  index
                  element={<OverviewPage relationshipsFacade={overviewPreviewRelationshipsFacade} />}
                />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>,
  );

  expect(
    await screen.findByRole("img", { name: "Deployment relation count by agent" }),
  ).toBeVisible();
  expect(screen.getByRole("list", { name: "Skill count by tag" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "4 pending items" })).toBeVisible();
  // 冻结指标（api.test.ts 锁定）：已配置/已发现合并为一条指标。
  expect(
    screen.getByRole("link", { name: "3 Agents (3 configured targets · 5 discovered)" }),
  ).toBeVisible();
  // 确定性关系事实落地后：冲突指标给出真实计数与钻取（不再是占位符）。
  expect(
    await screen.findByRole("link", { name: "2 Unconfirmed relationship conflicts" }),
  ).toBeVisible();
  // 三个关系缩略入口按确定性计数渲染为深链。
  expect(
    await screen.findByRole("link", { name: "Open relationship graph (4 skills with displayable relations)" }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open conflict workspace (2 unconfirmed conflicts)" }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open needs-governance relations (5 to handle)" }),
  ).toBeVisible();
  expect(screen.queryByText("–")).not.toBeInTheDocument();
});

it("fills the remaining shell height without a viewport-derived outer scroll range", () => {
  expect(overviewCss).toMatch(/\.sh-overview__hero\s*\{[\s\S]*min-height:\s*5rem/);
  expect(overviewCss).toMatch(/\.sh-overview__stat\s*\{[\s\S]*min-height:\s*5rem/);
  expect(overviewCss).not.toContain("100dvh - 22rem");
  expect(overviewCss).toMatch(/\.sh-overview__content-grid\s*\{[\s\S]*min-height:\s*0/);
});

it("keeps overview data modules in the page flow instead of creating nested scroll regions", () => {
  // DEV-66：最大化布局由 Tauri 原生窗口状态驱动，不能把“窗口高度较小”
  // 错当成最大化；普通窗口保留自然文档流。
  expect(overviewCss).toMatch(/:root\.sh-is-window-maximized \.sh-overview/);
  expect(overviewCss).not.toMatch(/@media \(max-height:\s*56rem\)/);
  expect(overviewCss).not.toMatch(/\.sh-page-frame--fill \{[\s\S]*?height:\s*auto/);
  expect(overviewCss).not.toMatch(/\.sh-overview\s*\{[^}]*overflow-y:\s*(auto|scroll)/);
  expect(overviewCss).not.toMatch(/\.sh-overview\s*\{[^}]*max-height:\s*10rem/);
  expect(overviewCss).toMatch(/\.sh-overview__tag-bar-list\s*\{[\s\S]*?overflow-y:\s*auto/);
});

it("uses four equal compact metric tracks when the maximized hero occupies its own row", () => {
  expect(overviewCss).toMatch(
    /:root\.sh-is-window-maximized \.sh-overview > \.sh-overview__metrics\s*\{[\s\S]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/,
  );
});
