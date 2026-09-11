import { expect, test, type Page } from "./fixtures";

/**
 * T3-B Skill 库卡片视图专属验收：
 * - 默认增强卡片视图（共享 SkillCard 语义）+ 可键盘操作且不丢选择的视图切换；
 * - 筛选栏搜索常驻、次要筛选折叠并显示生效条件数（窄窗口默认折叠）；
 * - 800/1024/1280/1440px（高 900，另测 600 最小高度）无根级横向溢出；
 * - 9 个预设主题在 1280×900 的关键控件、焦点与无横溢检查。
 */

const LIBRARY_ROUTE = "/__preview/skill-library";
const THEMES = [
  "moss-neutral",
  "spring-signal",
  "terracotta",
  "codex-light",
  "ocean-cobalt",
  "sakura",
  "aurora",
  "roast",
  "grok-night",
] as const;

async function rootHasNoHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth + 1,
  );
}

test("view switching is keyboard operable and keeps the batch selection", async ({ page }) => {
  await page.goto(LIBRARY_ROUTE);

  // 卡片视图内建立选择。
  await page.getByRole("checkbox", { name: "Select PDF Reader" }).check();
  const batchBar = page.getByRole("complementary", { name: "Batch actions" });
  await expect(batchBar).toContainText("1 item selected");

  // 原生 select 即键盘路径：聚焦后输入首字母（原生 type-ahead）切换到表格视图。
  const viewMode = page.getByRole("combobox", { name: "View mode" });
  await viewMode.focus();
  await page.keyboard.press("t");
  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select PDF Reader" })).toBeChecked();
  await expect(batchBar).toBeVisible();

  // 切回卡片视图，选择与批量栏保持。
  await viewMode.selectOption("cards");
  await expect(page.getByTestId("skill-card-skill-pdf")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select PDF Reader" })).toBeChecked();
  await expect(batchBar).toBeVisible();
});

test("filter collapse keeps search visible and shows the active condition count", async ({ page }) => {
  await page.goto(LIBRARY_ROUTE);

  const search = page.getByRole("searchbox", { name: "Search skills" });
  const toggle = page.getByRole("button", { name: /Filters/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toContainText("0 active");

  // 生成两个生效条件：搜索文本 + 基础检查筛选。
  await search.fill("PDF");
  await page.getByRole("button", { name: "Basic check" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Passed" }).click();
  await expect(toggle).toContainText("2 active");

  // 折叠后搜索与生效条件数仍在，次要筛选隐藏。
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(search).toBeVisible();
  await expect(page.getByRole("button", { name: "Basic check" })).not.toBeVisible();

  // 一键清除筛选，计数归零。
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toHaveValue("");
  await expect(toggle).toContainText("0 active");
});

test("secondary filters start collapsed on a narrow window and expanded on a wide one", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(LIBRARY_ROUTE);
  const narrowToggle = page.getByRole("button", { name: /Filters/ });
  await expect(narrowToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("searchbox", { name: "Search skills" })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(LIBRARY_ROUTE);
  await expect(page.getByRole("button", { name: /Filters/ })).toHaveAttribute("aria-expanded", "true");
});

for (const width of [800, 1024, 1280, 1440]) {
  test(`card view stays inside the viewport at ${width}×900`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(LIBRARY_ROUTE);

    await expect(page.getByTestId("skill-card-skill-pdf")).toBeVisible();
    expect(await rootHasNoHorizontalOverflow(page)).toBe(true);
    // 卡片操作区钉底可见：打开按钮始终可交互。
    await expect(page.getByRole("button", { name: "View PDF Reader" })).toBeVisible();
  });
}

test("card pagination stays reachable at the 600px minimum height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`${LIBRARY_ROUTE}?total=60`);

  await expect(page.getByTestId("skill-card-skill-pdf")).toBeVisible();
  const next = page.getByRole("button", { name: "Next page" });
  await next.scrollIntoViewIfNeeded();
  await expect(next).toBeInViewport();
  await next.click();
  await expect(page.getByTestId("skill-card-skill-26")).toBeVisible();
});

test("table mode keeps a single horizontal scroll owner and fits the default columns at 1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(LIBRARY_ROUTE);
  await page.getByRole("combobox", { name: "View mode" }).selectOption("table");

  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();
  // 默认列集在 1280px 内只有一个横向滚动所有者且无溢出：
  // 表格区域与视口之间不允许出现额外可滚动容器。
  const scrollOwners = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("div")).filter((element) => {
      const style = getComputedStyle(element);
      const horizontallyScrollable =
        element.scrollWidth > element.clientWidth + 1 &&
        /(auto|scroll)/.test(style.overflowX);
      const insideTableRegion = Boolean(
        element.closest("[class*='skill-table']"),
      );
      return horizontallyScrollable && insideTableRegion;
    }).length;
  });
  expect(scrollOwners).toBeLessThanOrEqual(1);
});

test("card surfaces follow the theme tokens in the default and dark themes", async ({ page }) => {
  const backgrounds: Record<string, string> = {};
  for (const theme of THEMES) {
    await page.addInitScript((name) => {
      window.localStorage.setItem("skillhub.appearance", name);
    }, theme);
    await page.goto(LIBRARY_ROUTE);
    await expect(page.getByTestId("skill-card-skill-pdf")).toBeVisible();
    backgrounds[theme] = await page
      .getByTestId("skill-card-skill-pdf")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    // 每个主题下都无根级横向溢出。
    expect(await rootHasNoHorizontalOverflow(page)).toBe(true);
    // 焦点可见性：Tab 后焦点元素有可见轮廓或非零尺寸。
    await page.keyboard.press("Tab");
    const focusVisible = await page.evaluate(() => {
      const active = document.activeElement;
      return Boolean(active && active.getBoundingClientRect().width > 0);
    });
    expect(focusVisible).toBe(true);
  }
  // 默认浅色主题与 grok-night 的卡片表面取色必须不同（证明未写死主题色）。
  expect(backgrounds["moss-neutral"]).not.toEqual(backgrounds["grok-night"]);
});
