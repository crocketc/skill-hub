import { expect, test } from "./fixtures";

test("cached preview reaches the primary navigation within two seconds", async ({ page }) => {
  await page.goto("/__preview/skill-library");
  const timing = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry ? entry.domContentLoadedEventEnd - entry.startTime : Number.POSITIVE_INFINITY;
  });
  await expect(page.getByRole("link", { name: "Skill library" })).toBeVisible();
  expect(timing).toBeLessThan(2000);
});
