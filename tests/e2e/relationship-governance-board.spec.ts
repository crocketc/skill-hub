import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

test.use({ locale: "zh-CN" });

test("governance board stays compact, switches views with selection, and opens the existing impact preview", async ({
  page,
}) => {
  const screenshots = path.resolve(process.cwd(), "test-results/ui/relationship-governance");
  mkdirSync(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/relationship-governance");

  await expect(page.getByRole("note")).toContainText("预览数据");
  const board = page.getByTestId("governance-board");
  await expect(board).toBeVisible();
  await expect(page.getByTestId("governance-board-column-manageable-count")).toHaveText("1");
  await expect(page.getByTestId("governance-board-column-verification-count")).toHaveText("2");
  await expect(page.getByTestId("governance-board-column-blocked-count")).toHaveText("1");
  await expect(page.getByTestId("governance-board-column-settled-count")).toHaveText("2");
  await expect(page.getByTestId("governance-row")).toHaveCount(6);

  const canvas = page.getByTestId("governance-row-list");
  const wideCanvas = await canvas.boundingBox();
  expect(wideCanvas?.height).toBeGreaterThan(250);
  await page.screenshot({
    path: path.join(screenshots, "relationship-governance-board-1440x900.png"),
    fullPage: false,
  });

  const selection = page.getByTestId("governance-select-preview:centralize-pdf");
  await selection.check();
  await page.setViewportSize({ width: 900, height: 600 });
  const viewToggle = page.getByTestId("governance-view-toggle");
  await expect(viewToggle).toHaveAttribute("aria-label", "切换到表格视图");
  await viewToggle.click();
  await expect(page).toHaveURL(/view=table/);
  await expect(page.getByTestId("governance-header-relation")).toBeVisible();
  await expect(page.getByTestId("governance-select-preview:centralize-pdf")).toBeChecked();
  const tableCanvas = page.getByTestId("governance-row-list");
  expect(await tableCanvas.evaluate((node) => node.scrollHeight)).toBeGreaterThan(
    await tableCanvas.evaluate((node) => node.clientHeight),
  );
  await tableCanvas.hover();
  await page.mouse.wheel(0, 620);
  await expect.poll(() => tableCanvas.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(viewToggle).toHaveAttribute("aria-label", "切换到看板视图");
  await viewToggle.click();
  await expect(page.getByTestId("governance-board-column-manageable")).toBeVisible();
  await expect(page.getByTestId("governance-select-preview:centralize-pdf")).toBeChecked();
  await viewToggle.click();
  await expect(page.getByTestId("governance-header-relation")).toBeVisible();
  await expect.poll(() => page.getByTestId("governance-row-list").evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await viewToggle.click();

  const narrowCanvas = await canvas.boundingBox();
  await expect(page.getByTestId("governance-board-column-manageable")).toBeVisible();
  await page.screenshot({
    path: path.join(screenshots, "relationship-governance-board-900x600.png"),
    fullPage: false,
  });
  expect(narrowCanvas?.height).toBeGreaterThan(180);

  await page.getByTestId("governance-action-preview:centralize-pdf").click();
  await expect(page.getByRole("dialog", { name: "纳入集中库管理预览" })).toBeVisible();
  await expect(page.getByTestId("governance-centralize-explain")).toContainText("保留当前位置");
  await expect(page.getByTestId("removal-impact-facts")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认执行" })).toBeVisible();
});

test("retained source-copy deep links keep one settled row and use its real status", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/relationship-governance?scope=source_copy&status=retained");

  const board = page.getByTestId("governance-board");
  await expect(board).toBeVisible();
  const columnOrder = await board.locator(":scope > section").evaluateAll((columns) =>
    columns.map((column) => column.getAttribute("data-testid")),
  );
  expect(columnOrder).toEqual([
    "governance-board-column-settled",
    "governance-board-column-manageable",
    "governance-board-column-verification",
    "governance-board-column-blocked",
  ]);
  await expect(page.getByTestId("governance-board-column-settled-count")).toHaveText("1");
  await expect(page.getByTestId("governance-row")).toHaveCount(1);
  await expect(page.getByTestId("governance-row")).toContainText("已保留");
  await expect(page.getByTestId("governance-row")).not.toContainText("已由集中库管理");
});

test("board columns sort by filtered count and keep their own scroll position", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 680 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/__preview/relationship-governance");

  const board = page.getByTestId("governance-board");
  await expect(board).toBeVisible();
  const columnOrder = async () => board.locator(":scope > section").evaluateAll((columns) =>
    columns.map((column) => column.getAttribute("data-testid")),
  );
  await expect.poll(columnOrder).toEqual([
    "governance-board-column-verification",
    "governance-board-column-settled",
    "governance-board-column-manageable",
    "governance-board-column-blocked",
  ]);

  const bodies = page.locator("[data-testid^='governance-board-column-body-']");
  await expect(bodies).toHaveCount(4);
  const verification = page.getByTestId("governance-board-column-body-needsValidation");
  const manageable = page.getByTestId("governance-board-column-body-manageable");
  const verificationHeading = page.getByTestId("governance-board-column-verification").locator("h2");
  await expect(verification).toHaveAttribute("tabindex", "0");
  await expect(verification).toHaveAttribute("role", "region");
  await expect(verification).toHaveAttribute("aria-label", "待核验列，2 条关系");
  await expect.poll(() => verification.evaluate((node) => getComputedStyle(node).scrollbarWidth)).toBe("none");
  await expect(page.getByTestId("governance-board-scroll-top-needsValidation")).toBeDisabled();
  const headingTop = (await verificationHeading.boundingBox())?.y;

  // Add enough content height to make the two populated columns independently scrollable
  // without changing the rows or their status projection.
  await page.addStyleTag({ content: ".sh-governance__board-column-body { flex: 0 0 180px !important; } .sh-governance__board-card { min-height: 240px; }" });
  const verificationContentHeight = await verification.evaluate((node) => node.scrollHeight);
  const manageableContentHeight = await manageable.evaluate((node) => node.scrollHeight);
  expect(verificationContentHeight).toBeGreaterThan(manageableContentHeight);
  await verification.hover();
  await page.mouse.wheel(0, 520);
  await expect.poll(() => verification.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.mouse.wheel(0, 620);
  const verificationMetrics = await verification.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    scrollTop: node.scrollTop,
  }));
  expect(verificationMetrics.scrollTop).toBeGreaterThan(0);
  expect(verificationMetrics.scrollTop).toBeGreaterThanOrEqual(
    verificationMetrics.scrollHeight - verificationMetrics.clientHeight - 1,
  );
  await expect(manageable).toHaveJSProperty("scrollTop", 0);
  await expect(page.getByTestId("governance-row-list")).toHaveJSProperty("scrollTop", 0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  expect((await verificationHeading.boundingBox())?.y).toBe(headingTop);

  const backToTop = page.getByRole("button", { name: "返回“待核验”列顶部" });
  await expect(backToTop).toBeEnabled();
  await backToTop.click();
  await expect.poll(() => verification.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(backToTop).toBeDisabled();

  await verification.hover();
  await page.mouse.wheel(0, 240);
  await expect.poll(() => verification.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.getByTestId("governance-select-all").check();
  await expect(page.getByTestId("governance-open-batch")).toBeVisible();
  await expect.poll(() => verification.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.getByTestId("governance-filter-trigger").click();
  await page.getByTestId("governance-scope-source_copy").click();
  await expect(page).toHaveURL(/scope=source_copy/);
  await expect.poll(() => verification.evaluate((node) => node.scrollTop)).toBe(0);

  await page.goto("/__preview/relationship-governance?scope=source_copy&status=retained");
  await expect(page.getByTestId("governance-board-column-settled-count")).toHaveText("1");
  await expect.poll(columnOrder).toEqual([
    "governance-board-column-settled",
    "governance-board-column-manageable",
    "governance-board-column-verification",
    "governance-board-column-blocked",
  ]);
});

test("secondary filters overlay the board and a single icon switches board and table", async ({ page }) => {
  const screenshots = path.resolve(process.cwd(), "test-results/ui/relationship-governance");
  mkdirSync(screenshots, { recursive: true });
  await page.setViewportSize({ width: 800, height: 560 });
  await page.goto("/__preview/relationship-governance");

  const board = page.getByTestId("governance-board");
  await expect(board).toBeVisible();
  const topBefore = (await board.boundingBox())?.y;
  const filterTrigger = page.getByTestId("governance-filter-trigger");
  await filterTrigger.click();
  const filterPopover = page.getByTestId("governance-filter-popover");
  await expect(filterPopover).toBeVisible();
  const popoverBounds = await filterPopover.boundingBox();
  expect(popoverBounds?.x).toBeGreaterThanOrEqual(0);
  expect((popoverBounds?.x ?? 0) + (popoverBounds?.width ?? 0)).toBeLessThanOrEqual(800);
  expect((await board.boundingBox())?.y).toBe(topBefore);
  await expect(page.getByTestId("governance-scope-explanations")).toContainText("导入来源");
  await expect(page.getByTestId("governance-scope-explanations")).toContainText("派发关系");
  const popoverContrast = () => filterPopover.evaluate((element) => {
    const channels = (color: string) => color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (color: string) => channels(color).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const style = getComputedStyle(element);
    const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "moss-neutral"));
  expect(await popoverContrast()).toBeGreaterThanOrEqual(4.5);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "grok-night"));
  expect(await popoverContrast()).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({
    path: path.join(screenshots, "relationship-governance-filters-800x560-dark.png"),
    fullPage: false,
  });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "moss-neutral"));
  await page.screenshot({
    path: path.join(screenshots, "relationship-governance-filters-800x560.png"),
    fullPage: false,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("governance-filter-popover")).toBeHidden();
  await expect(filterTrigger).toBeFocused();
  await filterTrigger.click();
  await page.mouse.click(780, 320);
  await expect(page.getByTestId("governance-filter-popover")).toBeHidden();
  await expect(filterTrigger).toBeFocused();
  await filterTrigger.click();
  await page.getByTestId("governance-bucket-all").click();
  await expect(page.getByTestId("governance-filter-popover")).toBeHidden();
  await filterTrigger.click();
  await page.getByTestId("governance-scope-source_copy").click();
  await expect(page).toHaveURL(/scope=source_copy/);
  await page.getByRole("searchbox", { name: "搜索 Skill、目标或路径" }).fill("PDF");
  await page.getByRole("button", { name: "搜索" }).click();
  await expect(page).toHaveURL(/scope=source_copy.*text=PDF|text=PDF.*scope=source_copy/);

  const switchView = page.getByTestId("governance-view-toggle");
  await expect(switchView).toHaveAttribute("aria-label", "切换到表格视图");
  await switchView.click();
  await expect(page).toHaveURL(/view=table/);
  await expect(page.getByTestId("governance-header-relation")).toBeVisible();
  await expect(switchView).toHaveAttribute("aria-label", "切换到看板视图");
  await switchView.click();
  await expect(page).not.toHaveURL(/view=table/);
  await expect(page.getByTestId("governance-board")).toBeVisible();

  const viewport = page.locator("body");
  await expect.poll(() => viewport.evaluate((node) => node.scrollWidth <= window.innerWidth)).toBe(true);
});
