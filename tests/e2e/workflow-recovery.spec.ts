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

  const records = page.getByRole("tab", { name: "Operation records" });
  const backup = page.getByRole("tab", { name: "Backup & restore" });
  await records.click();
  await records.focus();

  await page.keyboard.press("ArrowRight");
  await expect(backup).toHaveAttribute("aria-selected", "true");
  await expect(records).toHaveAttribute("aria-selected", "false");
  const focusedId = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(focusedId).toBe("recovery-tab-backup");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("id", "recovery-panel-backup");

  // Unselected tabs are skipped by Tab (roving tabindex); the panel follows.
  await page.keyboard.press("Tab");
  const afterTab = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(afterTab).toBe("recovery-panel-backup");

  // Arrows act while focus is on a tab; wrap backwards to the first tab.
  await backup.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(records).toHaveAttribute("aria-selected", "true");
  const backId = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(backId).toBe("recovery-tab-records");
});

test("keeps the recovery confirmation inside the backup & restore tab", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/recovery");

  await page.getByRole("tab", { name: "Backup & restore" }).click();
  await expect(page.getByText("deployment.target_conflict")).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge recovery" }).click();
  await expect(page.getByText("Rolled back")).toBeVisible();
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

      const backup = page.getByRole("tab", { name: "Backup & restore" });
      await expect(backup).toBeVisible();
      await backup.click();
      await expect(page.getByRole("button", { name: "Acknowledge recovery" })).toBeVisible();
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
      await page.getByRole("tab", { name: "Backup & restore" }).click();
      await expect(page.getByRole("button", { name: "Acknowledge recovery" })).toBeVisible();
      await expect(page.getByText("Needs recovery")).toBeVisible();
    });
  }
});
