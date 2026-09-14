import { expect, test } from "./fixtures";

/**
 * TC-GR-10 的浏览器自动化层：以 300 个 Skill 作为基准，缓存技能库首页在
 * GR-10 预算内可交互，全量集合可分页到达，筛选在 300 规模下仍然可用。
 * T3-B 起默认为增强卡片视图，分页/筛选/预算断言以卡片语义等价保持；
 * 表格模式保留为专业模式。真实数据库迁移、磁盘读取与原生滚动的性能仍需桌面人工取证。
 */

const SUMMARY = "library-summary-total";
const SCALED_ROUTE = "/__preview/skill-library?total=300&size=100";

test("300-skill catalog reaches the cached home within the GR-10 budget", async ({ page }) => {
  // 遗留风险去噪（2026-09-14）：预算的度量对象是"缓存后的首页可达性"，
  // 但多 worker 并行冷启动时首次加载会承担模块转换/导入冷成本，DCL 偶发
  // 抖过预算。先做一次预热导航再计时，预算阈值保持 2000ms 不变。
  await page.goto(SCALED_ROUTE);
  await expect(page.getByTestId(SUMMARY)).toContainText("300");

  await page.goto(SCALED_ROUTE);
  await expect(page.getByTestId(SUMMARY)).toContainText("300");
  await expect(page.getByTestId("skill-card-skill-pdf")).toBeVisible();

  const timing = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry ? entry.domContentLoadedEventEnd - entry.startTime : Number.POSITIVE_INFINITY;
  });
  expect(timing).toBeLessThan(2000);
});

test("300-skill catalog keeps 100 cards per page and reaches the second page", async ({ page }) => {
  await page.goto(SCALED_ROUTE);
  await expect(page.getByTestId("skill-card-skill-100")).toBeVisible();
  await expect(page.getByTestId("skill-card-skill-101")).not.toBeVisible();

  await page.goto("/__preview/skill-library?total=300&size=100&page=2");
  await expect(page.getByTestId(SUMMARY)).toContainText("300");
  await expect(page.getByTestId("skill-card-skill-101")).toBeVisible();
  await expect(page.getByTestId("skill-card-skill-pdf")).not.toBeVisible();
});

test("300-skill table mode keeps pagination as the professional fallback", async ({ page }) => {
  await page.goto(SCALED_ROUTE);
  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.getByRole("row", { name: /Local Skill 100/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Local Skill 101/ })).not.toBeVisible();

  await page.goto("/__preview/skill-library?total=300&size=100&page=2");
  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.getByRole("row", { name: /Local Skill 101/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /PDF Reader/ })).not.toBeVisible();
});

test("filtering stays interactive at 300 skills", async ({ page }) => {
  await page.goto(SCALED_ROUTE);
  await page.getByRole("searchbox", { name: "Search skills" }).fill("PDF Reader");
  await expect(page.getByTestId(SUMMARY)).toHaveText("1 skills match the current filters");
  await expect(page.getByTestId("skill-card-skill-pdf")).toBeVisible();
  await expect(page.getByTestId("skill-card-skill-100")).not.toBeVisible();
});
