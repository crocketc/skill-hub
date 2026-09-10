import { expect, test, type Page } from "./fixtures";

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

const WIDTHS = [800, 1024, 1280, 1440] as const;

/** Root-level horizontal overflow guard shared by every size check. */
async function expectNoRootHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function openPending(page: Page, query = "") {
  await page.goto(`/__preview/pending${query}`);
  await expect(page.getByRole("heading", { name: "Close the loop on pending items" })).toBeVisible();
}

test("exposes risk, impact, and suggested actions per item", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPending(page);

  const finding = page.locator("li").filter({ hasText: "pdf-reader" }).first();
  await expect(finding.getByText("High risk")).toBeVisible();
  await expect(finding.getByText("Affects 3 deployments")).toBeVisible();

  const group = page.getByRole("group", { name: "Suggested actions for pdf-reader" });
  await expect(group.getByRole("button", { name: "Recheck" })).toBeVisible();
  await expect(group.getByRole("button", { name: "Defer" })).toBeVisible();
  await expect(group.getByRole("button", { name: "Ignore" })).toBeVisible();

  const trial = page.locator("li").filter({ hasText: "release-notes" }).first();
  await expect(trial.getByText("Due 2026-09-30")).toBeVisible();
  await expect(trial.getByRole("button", { name: "Make regular" })).toBeVisible();
});

test("keeps the batch bar from covering the last item or its focus at 50+ items", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await openPending(page, "?items=60");

  const bar = page.locator(".sh-pending-batch--anchored");
  await expect(bar).toBeVisible();

  const lastItem = page.locator(".sh-pending-item").last();
  const focusTarget = lastItem.getByRole("button", { name: "Defer" }).first();
  await focusTarget.focus();

  const buttonBox = await focusTarget.boundingBox();
  const barBox = await bar.boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(barBox).not.toBeNull();
  // 批量区钉在滚动区顶部，聚焦的末项按钮滚动到批量区下方，完整可见。
  expect(barBox!.y).toBeLessThan(150);
  expect(buttonBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height - 1);
  expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(900);
  await expectNoRootHorizontalOverflow(page);
});

test("keeps the last item reachable with only 600px of viewport height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await openPending(page, "?items=60");

  const bar = page.locator(".sh-pending-batch--anchored");
  const lastItem = page.locator(".sh-pending-item").last();
  const focusTarget = lastItem.getByRole("button", { name: "Defer" }).first();
  await focusTarget.focus();

  const buttonBox = await focusTarget.boundingBox();
  const barBox = await bar.boundingBox();
  expect(barBox!.y).toBeLessThan(150);
  expect(buttonBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height - 1);
  expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(600);
  await expectNoRootHorizontalOverflow(page);
});

test("reports a failed action inline and keeps the list usable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPending(page, "?actionError=1");

  const firstItem = page.locator(".sh-pending-item").first();
  await firstItem.getByRole("button", { name: "Defer" }).first().click();

  await expect(page.getByRole("alert")).toContainText("The operation failed");
  await expect(page.getByText("pdf-reader")).toBeVisible();
  await expect(page.getByText("release-notes")).toBeVisible();
  // 失败不锁死工作台：仍可选择事项并继续批量操作。
  await page.getByRole("checkbox", { name: "Select release-notes" }).check();
  await expect(page.getByRole("button", { name: "Defer selected for 7 days" })).toBeEnabled();
});

test("batch ignore keeps its confirmation and cancel path", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPending(page);

  await page.getByRole("checkbox", { name: "Select pdf-reader" }).check();
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.getByRole("button", { name: "Ignore selected permanently" }).click();

  const dialog = page.getByRole("alertdialog", { name: "Permanently ignore the selected items?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("pdf-reader")).toBeVisible();
});

test.describe("pending width matrix", () => {
  for (const width of WIDTHS) {
    test(`keeps the pending workbench free of root overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPending(page, "?items=60");
      await expectNoRootHorizontalOverflow(page);
      const select = page.getByRole("combobox", { name: "Item type" });
      await expect(select).toBeVisible();
      await select.selectOption("recovery");
      // 60 条混合事项里 recovery 与 security_finding 同时存在；筛选后只留恢复事项。
      await expect(page.getByText("skill-1", { exact: true })).toHaveCount(0);
      await expect(page.getByText("skill-3", { exact: true })).toBeVisible();
    });
  }
});

test.describe("pending 9-theme matrix at 1280x900", () => {
  for (const theme of THEMES) {
    test(`renders key controls and focus without overflow in ${theme}`, async ({ page }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem("skillhub.appearance", value);
      }, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openPending(page, "?items=20");

      await expectNoRootHorizontalOverflow(page);
      await expect(page.getByRole("group", { name: "Batch disposition" })).toBeVisible();

      // Full-width workbench: the anchored batch bar spans the content area.
      const barBox = await page.locator(".sh-pending-batch--anchored").boundingBox();
      expect(barBox).not.toBeNull();
      expect(barBox!.width).toBeGreaterThan(700);

      // Risk stays icon + text; the text is theme independent.
      await expect(page.getByText("High risk").first()).toBeVisible();

      // Keyboard focus remains visible on an item action.
      await page.locator(".sh-pending-item").first().getByRole("button", { name: "Defer" }).first().focus();
      const focused = await page.evaluate(() => document.activeElement?.tagName ?? "");
      expect(["BUTTON", "SELECT", "INPUT"]).toContain(focused);
    });
  }
});
