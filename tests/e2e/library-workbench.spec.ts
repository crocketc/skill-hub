import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

test("skill library workbench keeps filters and supported sort controls clear", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/skill-library");
  await page.getByRole("button", { name: "Table view" }).click();

  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(page.getByRole("button", { name: "All skills" })).toBeVisible();
  await expect(page.locator(".sh-skill-table-workspace")).toBeVisible();

  const toolbarGeometry = await page.evaluate(() => {
    const searchBand = document.querySelector<HTMLElement>(".sh-skill-library__band--search");
    const searchPrimary = document.querySelector<HTMLElement>(".sh-skill-filters__primary");
    const actions = document.querySelector<HTMLElement>(".sh-skill-library__toolbar-actions");
    if (!searchBand || !searchPrimary || !actions) return null;
    const band = searchBand.getBoundingClientRect();
    const search = searchPrimary.getBoundingClientRect();
    const action = actions.getBoundingClientRect();
    return {
      bandHeight: band.height,
      clustersShareRow: Math.abs((search.top + search.bottom) / 2 - (action.top + action.bottom) / 2) <= 4,
      actionsFitInsideBand: action.right <= band.right + 1,
    };
  });
  expect(toolbarGeometry).not.toBeNull();
  expect(toolbarGeometry?.clustersShareRow).toBe(true);
  expect(toolbarGeometry?.actionsFitInsideBand).toBe(true);
  expect(toolbarGeometry?.bandHeight).toBeLessThanOrEqual(64);

  const screenshotPath = path.resolve(process.cwd(), "test-results/skill-library-workbench-1440x900.png");
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath });

  const nameHeader = page.locator('th[data-column="name"]');
  await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(nameHeader.locator(".sh-skill-table__sort-indicator")).toHaveText("↑");
  await page.getByRole("button", { name: "Sort by name / alias" }).click();
  await expect(nameHeader).toHaveAttribute("aria-sort", "descending");
  await expect(nameHeader.locator(".sh-skill-table__sort-indicator")).toHaveText("↓");

  const search = page.getByRole("searchbox", { name: "Search skills" });
  await search.fill("PDF");
  await expect(page.getByRole("button", { name: "Remove filter: Search skills: PDF" })).toBeVisible();
  await page.getByRole("button", { name: "Remove filter: Search skills: PDF" }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();

  const noHorizontalPageOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noHorizontalPageOverflow).toBe(true);

  await page.setViewportSize({ width: 900, height: 900 });
  const narrowGeometry = await page.evaluate(() => {
    const searchBand = document.querySelector<HTMLElement>(".sh-skill-library__band--search");
    const searchPrimary = document.querySelector<HTMLElement>(".sh-skill-filters__primary");
    const actions = document.querySelector<HTMLElement>(".sh-skill-library__toolbar-actions");
    if (!searchBand || !searchPrimary || !actions) return null;
    const band = searchBand.getBoundingClientRect();
    const search = searchPrimary.getBoundingClientRect();
    const action = actions.getBoundingClientRect();
    const sameRow = Math.abs((search.top + search.bottom) / 2 - (action.top + action.bottom) / 2) <= 4;
    return {
      actionsFitInsideBand: action.right <= band.right + 1,
      clustersAlignOrWrapCleanly: sameRow || action.top >= search.bottom - 1 || search.top >= action.bottom - 1,
      noHorizontalPageOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
  expect(narrowGeometry).not.toBeNull();
  expect(narrowGeometry?.actionsFitInsideBand).toBe(true);
  expect(narrowGeometry?.clustersAlignOrWrapCleanly).toBe(true);
  expect(narrowGeometry?.noHorizontalPageOverflow).toBe(true);
  const narrowScreenshotPath = path.resolve(process.cwd(), "test-results/skill-library-workbench-900x900.png");
  await page.screenshot({ path: narrowScreenshotPath });
});

test("900x600 narrow library keeps search, table paging, and collapsed filters reachable", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/__preview/skill-library");

  const search = page.getByRole("searchbox", { name: "Search skills" });
  await expect(search).toBeVisible();
  await expect(search).toHaveAttribute("placeholder", "Enter a Skill name or alias");
  await expect(page.locator(".sh-skill-filters__advanced")).toHaveCount(0);

  await page.getByRole("button", { name: "Table view" }).click();
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();

  const bodyGeometry = await page.locator(".sh-skill-table__region").evaluate((region) => {
    const bounds = region.getBoundingClientRect();
    const rows = [...region.querySelectorAll<HTMLElement>("tbody tr")];
    const completeRows = rows.filter((row) => {
      const rowBounds = row.getBoundingClientRect();
      return rowBounds.height > 0 && rowBounds.top >= bounds.top - 1 && rowBounds.bottom <= bounds.bottom + 1;
    });
    return { height: bounds.height, completeRows: completeRows.length };
  });
  expect(bodyGeometry.height).toBeGreaterThanOrEqual(160);
  expect(bodyGeometry.completeRows).toBeGreaterThanOrEqual(2);

  const screenshotPath = path.resolve(process.cwd(), "test-results/skill-library-workbench-900x600.png");
  await page.screenshot({ path: screenshotPath });

  const nextPage = page.getByRole("button", { name: "Next page" });
  await expect(nextPage).toBeEnabled();
  await nextPage.click();
  await expect(page.getByText("26–50 of 80")).toBeVisible();

  await page.getByRole("button", { name: /Filters/ }).click();
  const filters = page.locator(".sh-skill-filters__advanced");
  await expect(filters).toBeVisible();
  await expect(filters.getByRole("button", { name: "Basic check" })).toBeVisible();
  await expect(filters.getByRole("button", { name: "AI check" })).toBeVisible();
  await expect(filters.getByRole("button", { name: "Lifecycle" })).toBeVisible();
  await expect(filters.getByLabel("Added to targets")).toBeVisible();
  await expect(filters.getByLabel("Version")).toBeVisible();
  await expect(filters.getByRole("button", { name: "Tags" })).toBeVisible();
});
