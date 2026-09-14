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

  // 分段控件即键盘路径：聚焦“Table view”按钮后按 Enter 切换到表格视图。
  const tableButton = page.getByRole("button", { name: "Table view" });
  await tableButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select PDF Reader" })).toBeChecked();
  await expect(batchBar).toBeVisible();
  await expect(tableButton).toHaveAttribute("aria-pressed", "true");

  // 切回卡片视图，选择与批量栏保持。
  await page.getByRole("button", { name: "Card view" }).click();
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
  await page.getByRole("button", { name: "Table view" }).click();

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

  // 审查 C2（2026-09-14）：把“默认列集 @1280 无溢出”落成显式几何断言——
  // 结果区域自身的内容宽不得超出客户区（+1px 容差），而非只统计滚动容器数。
  const region = page.locator(".sh-skill-table__region");
  const regionOverflow = await region.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(regionOverflow.scrollWidth).toBeLessThanOrEqual(
    regionOverflow.clientWidth + 1,
  );
});

test("hidden table columns stay reachable through a visible horizontal scrollbar at 800", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(LIBRARY_ROUTE);
  await page.getByRole("button", { name: "Table view" }).click();

  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();
  const region = page.locator(".sh-skill-table__region");
  // 滚动条可感知：auto 级宽度 + 主题色滑块（而非被隐藏样式吃掉）。
  await expect(region).toHaveCSS("scrollbar-width", "auto");
  // 800px 下默认列集必然溢出：最后一列经横向滚动进入视口。
  const scrollable = await region.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  );
  expect(scrollable).toBe(true);
  await region.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const securityVisible = await page.evaluate(() => {
    const column = document.querySelector<HTMLElement>("th[data-column='security']");
    const owner = document.querySelector<HTMLElement>(".sh-skill-table__region");
    if (!column || !owner) return false;
    const columnRect = column.getBoundingClientRect();
    const ownerRect = owner.getBoundingClientRect();
    return (
      columnRect.right > ownerRect.left &&
      columnRect.left < ownerRect.right &&
      columnRect.left >= ownerRect.left - 1
    );
  });
  expect(securityVisible).toBe(true);
});

test("all enabled columns stay reachable through a real scrollbar at 1280", async ({ page }) => {
  // M-21 横向滚动取证（真机反馈复现）：全列开启 + 1280px 视口。既有自动化只证了
  // 800px 默认列集；真机在 1280 宽屏全列时 % 宽度不溢出、末列表头被裁剪且无滚动条。
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(LIBRARY_ROUTE);
  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();

  // 开启全部隐藏列。
  await page.getByRole("button", { name: "Columns and density" }).click();
  const toggles = page.locator(".sh-skill-table__reorder-item");
  const toggleCount = await toggles.count();
  for (let index = 0; index < toggleCount; index += 1) {
    const item = toggles.nth(index);
    if ((await item.getAttribute("aria-pressed")) === "false") {
      await item.click();
    }
  }
  await expect(toggles.first()).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Columns and density" }).click();

  await expect(page.locator("th[data-column='requirements']")).toBeAttached();
  const region = page.locator(".sh-skill-table__region");
  await expect(region).toHaveCSS("overflow-x", "auto");
  await expect(region).toHaveCSS("scrollbar-width", "auto");

  // 全列地板宽超过区域宽：必须出现真实可用的横向溢出（而非把列压窄裁剪）。
  const overflow = await region.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  );
  expect(overflow).toBe(true);

  // 滚到最右后末列表头几何完全可见（左右边缘都落在区域内容盒内）。
  await region.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const lastHeaderFullyVisible = await page.evaluate(() => {
    const owner = document.querySelector<HTMLElement>(".sh-skill-table__region");
    const headers = document.querySelectorAll<HTMLElement>(".sh-skill-table thead th[data-column]");
    const last = headers[headers.length - 1];
    if (!owner || !last) return false;
    const headerRect = last.getBoundingClientRect();
    const ownerRect = owner.getBoundingClientRect();
    return (
      headerRect.left >= ownerRect.left - 1 &&
      headerRect.right <= ownerRect.right + 1 &&
      headerRect.width > 0
    );
  });
  expect(lastHeaderFullyVisible).toBe(true);
});

test("real mouse dragging reorders columns without toggling visibility", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(LIBRARY_ROUTE);
  await page.getByRole("button", { name: "Table view" }).click();
  await page.getByRole("button", { name: "Columns and density" }).click();

  const reorderList = page.getByRole("list", { name: "Reorder columns" });
  const source = reorderList.getByRole("button", { name: "Tags" });
  const target = reorderList.getByRole("button", { name: "Purpose" });
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 });
  await page.mouse.up();

  const order = await page.locator(".sh-skill-table__reorder-item").evaluateAll((items) =>
    items.map((item) => item.textContent?.trim()),
  );
  expect(order.indexOf("Tags")).toBeLessThan(order.indexOf("Purpose"));
  await expect(source).toHaveAttribute("aria-pressed", "true");
});

test("real mouse dragging reorders quick drawer modules on the configuration surface", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(LIBRARY_ROUTE);
  await page.getByRole("heading", { name: "PDF Reader" }).click();
  await page.getByRole("button", { name: "Configure quick drawer" }).click();

  const source = page.getByRole("button", { name: "Versions" });
  const target = page.getByRole("button", { name: "Relations" });
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 });
  await page.mouse.up();

  const order = await page.locator(".sh-skill-drawer__module-toggle").evaluateAll((items) =>
    items.map((item) => item.textContent?.trim()),
  );
  expect(order.indexOf("Versions")).toBeLessThan(order.indexOf("Relations"));
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
