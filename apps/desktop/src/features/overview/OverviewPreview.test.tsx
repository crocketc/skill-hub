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
    screen.getByRole("link", { name: "Open relationship governance (9 relation edges)" }),
  ).toBeVisible();
  expect(screen.queryByText("–")).not.toBeInTheDocument();
});

it("fills the remaining shell height without a viewport-derived outer scroll range", () => {
  expect(overviewCss).toMatch(/\.sh-overview__hero\s*\{[\s\S]*min-height:\s*5rem/);
  expect(overviewCss).toMatch(/\.sh-overview__stat\s*\{[\s\S]*min-height:\s*5rem/);
  expect(overviewCss).not.toContain("100dvh - 22rem");
  expect(overviewCss).toMatch(/\.sh-overview__content-grid\s*\{[\s\S]*min-height:\s*0/);
});

it("allocates available height instead of falling back to a viewport-derived scroll range", () => {
  // DEV-25（契约迁移）：短窗口不再退回"自然高度 + 页面根滚动"——那条
  // `@media (max-height: 70rem)` 兜底用视口高度反推布局，正是验收发现的
  // 页面级滚动条来源。现在高度由弹性轨道分配，主区保底 + 卡片内部滚动。
  expect(overviewCss).not.toMatch(/@media \(max-height/);
  expect(overviewCss).not.toMatch(/\.sh-page-frame--fill \{[\s\S]*?height:\s*auto/);
  expect(overviewCss).toMatch(/\.sh-overview > \.sh-overview__content-grid\s*\{[\s\S]*?flex: 1 1 auto/);
  expect(overviewCss).toMatch(/\.sh-overview > \.sh-overview__content-grid\s*\{[\s\S]*?min-height:\s*14rem/);
  // 明细列表与待办区在自己的行/卡片内滚动，不把高度推给页面。
  expect(overviewCss).toMatch(/\.sh-overview \.sh-overview__details-scroll\s*\{[\s\S]*?max-height:\s*100%/);
  expect(overviewCss).toMatch(/@container workspace \(min-width: 60rem\) \{[\s\S]*?\.sh-overview \.sh-overview__pending \{[\s\S]*?overflow-y:\s*auto/);
});
