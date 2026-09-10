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

test("renders a structured operation timeline with phases and localized times", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/operations-records");

  const timeline = page.getByRole("list", { name: "Operations timeline" });
  await expect(timeline).toBeVisible();
  const entries = timeline.getByRole("listitem");
  await expect(entries).toHaveCount(3);

  await expect(entries.nth(0).getByText("Committed")).toBeVisible();
  await expect(entries.nth(1).getByText("Needs recovery")).toBeVisible();
  await expect(entries.nth(1).getByText(/Error code: deployment\.target_conflict/)).toBeVisible();
  await expect(entries.nth(2).getByText("Rolled back")).toBeVisible();

  // Raw ISO timestamps only live in the machine-readable dateTime attribute.
  const firstTime = entries.nth(0).locator("time");
  await expect(firstTime).toHaveAttribute("dateTime", "2026-09-08T08:01:00Z");
  await expect(page.getByText("2026-09-08T08:01:00Z")).toHaveCount(0);
  const formatted = await firstTime.textContent();
  expect(formatted).not.toContain("2026-09-08T08:01:00Z");
  expect(formatted!.trim().length).toBeGreaterThan(0);
});

test("shows session background operations with progress", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/operations-records");

  await expect(page.getByText("Import 3 skills from fixtures")).toBeVisible();
  await expect(page.getByText(/1\/3/)).toBeVisible();
});

test("links a persisted record to its operation detail page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/operations-records");

  // 详情路由属于生产边界：预览只断言链接契约，详情呈现走专属预览路由。
  const link = page.getByRole("link", { name: "import" });
  await expect(link).toHaveAttribute("href", "/operations/op-import-1");
  const failureLink = page.getByRole("link", { name: "deployment" });
  await expect(failureLink).toHaveAttribute("href", "/operations/op-deploy-9");

  await page.goto("/__preview/operation-progress");
  await expect(page.getByRole("heading", { name: "Operation status" })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "100");
});

test("keeps honest empty and failure states for the records list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto("/__preview/operations-records?empty=1");
  await expect(page.getByText(/No operation records yet/)).toBeVisible();

  await page.goto("/__preview/operations-records?error=1");
  await expect(page.getByText(/Failed to read operation records/)).toBeVisible();
});

test.describe("operations width matrix", () => {
  for (const width of WIDTHS) {
    test(`keeps the operations timeline free of root overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/operations-records");
      await expect(page.getByRole("list", { name: "Operations timeline" })).toBeVisible();
      await expectNoRootHorizontalOverflow(page);
    });
  }
});

test.describe("operations 9-theme matrix at 1280x900", () => {
  for (const theme of THEMES) {
    test(`renders timeline states and focus without overflow in ${theme}`, async ({ page }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem("skillhub.appearance", value);
      }, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/__preview/operations-records");

      await expectNoRootHorizontalOverflow(page);
      const entries = page.getByRole("list", { name: "Operations timeline" }).getByRole("listitem");
      await expect(entries.nth(0).getByText("Committed")).toBeVisible();
      await expect(entries.nth(1).getByText("Needs recovery")).toBeVisible();

      const link = page.getByRole("link", { name: "import" });
      await link.focus();
      const focused = await page.evaluate(() => document.activeElement?.tagName ?? "");
      expect(focused).toBe("A");
    });
  }
});
