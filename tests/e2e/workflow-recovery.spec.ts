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

async function expectNoRootHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("defaults to the operation records tab wired to its panel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/recovery");

  const records = page.getByRole("tab", { name: "Operation records" });
  await expect(records).toHaveAttribute("aria-selected", "true");
  await expect(records).toHaveAttribute("aria-controls", "recovery-panel-records");

  const panel = page.getByRole("tabpanel");
  await expect(panel).toHaveAttribute("id", "recovery-panel-records");
  await expect(panel).toHaveAttribute("aria-labelledby", "recovery-tab-records");
  await expect(panel).toBeVisible();
});

test("moves selection and focus with the arrow keys and updates the panel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/recovery");

  // #11（2026-10-08）页签改名：「备份恢复」→「未完成操作」（en "Unfinished operations"）；
  // 锚点随界面文案重锚，断言意图（页签导航行为）不变。
  const records = page.getByRole("tab", { name: "Operation records" });
  const unfinished = page.getByRole("tab", { name: "Unfinished operations" });
  await records.click();
  await records.focus();

  await page.keyboard.press("ArrowRight");
  await expect(unfinished).toHaveAttribute("aria-selected", "true");
  await expect(records).toHaveAttribute("aria-selected", "false");
  const focusedId = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(focusedId).toBe("recovery-tab-unfinished");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("id", "recovery-panel-unfinished");

  // Unselected tabs are skipped by Tab (roving tabindex); the panel follows.
  await page.keyboard.press("Tab");
  const afterTab = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(afterTab).toBe("recovery-panel-unfinished");

  // Arrows act while focus is on a tab; wrap backwards to the first tab.
  await unfinished.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(records).toHaveAttribute("aria-selected", "true");
  const backId = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(backId).toBe("recovery-tab-records");
});

test("keeps the supported undo action inside the unfinished-operations tab", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/recovery");

  await page.getByRole("tab", { name: "Unfinished operations" }).click();
  await expect(page.getByText("deployment.target_conflict")).toBeVisible();
  await page.getByRole("button", { name: "Undo unfinished changes" }).click();
  await expect(page.getByText("unfinished changes have been undone")).toBeVisible();
});

test("dispatches the complete action advertised by the backend preview", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/recovery?complete=1");

  await page.getByRole("tab", { name: "Unfinished operations" }).click();
  await expect(page.getByRole("button", { name: "Continue operation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo unfinished changes" })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue operation" }).click();
  await expect(page.getByText("the operation is complete")).toBeVisible();
});

test("does not invent an action for a candidate without supported recovery", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/recovery?noActions=1");

  await page.getByRole("tab", { name: "Unfinished operations" }).click();
  await expect(page.getByText("No safe automatic recovery is available for this operation.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue operation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo unfinished changes" })).toHaveCount(0);
});

test("restores replaced content only after confirmation and preserves the page state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/recovery?replaced=1");

  await page.getByRole("tab", { name: "Replaced content" }).click();
  await expect(page.getByText("preview-original-skill")).toBeVisible();
  await page.getByRole("button", { name: "Restore this content" }).click();

  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("The current content will be saved as another recoverable item.");
  await confirmation.getByRole("button", { name: "Confirm restore" }).click();

  await expect(page.getByText("No replaced content can be restored right now.")).toBeVisible();
});

test("keeps candidates visible and retries a single failed operation detail", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/recovery?detailError=1");

  await page.getByRole("tab", { name: "Unfinished operations" }).click();
  await expect(page.getByRole("radio", { name: "Dispatch skill: Preview skill" })).toBeVisible();
  await expect(page.getByText("native bridge unavailable in preview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo unfinished changes" })).toBeDisabled();

  await page.getByRole("button", { name: "Retry loading details" }).click();

  await expect(page.getByRole("radio", { name: "Dispatch skill: Preview skill" })).toBeVisible();
  await expect(page.getByText("The operation did not complete", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo unfinished changes" })).toBeEnabled();
});

test("surfaces a records read failure without faking an empty history", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/recovery?error=1");
  await expect(page.getByText(/Failed to read operation records/)).toBeVisible();
});

test.describe("recovery width matrix", () => {
  for (const width of WIDTHS) {
    test(`keeps the recovery tabs reachable without overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/recovery");

      const backup = page.getByRole("tab", { name: "Unfinished operations" });
      await expect(backup).toBeVisible();
      await backup.click();
      await expect(page.getByRole("button", { name: "Undo unfinished changes" })).toBeVisible();
      await expectNoRootHorizontalOverflow(page);
    });
  }
});

test.describe("recovery 9-theme matrix at 1280x900", () => {
  for (const theme of THEMES) {
    test(`renders tabs, selection, and states without overflow in ${theme}`, async ({ page }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem("skillhub.appearance", value);
      }, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/__preview/recovery");

      await expectNoRootHorizontalOverflow(page);
      const records = page.getByRole("tab", { name: "Operation records" });
      await expect(records).toHaveAttribute("aria-selected", "true");
      await page.getByRole("tab", { name: "Unfinished operations" }).click();
      await expect(page.getByRole("button", { name: "Undo unfinished changes" })).toBeVisible();
      await expect(page.getByText("Needs recovery")).toBeVisible();
    });
  }
});
