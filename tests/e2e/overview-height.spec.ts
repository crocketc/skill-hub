import { expect, test } from "./fixtures";

/**
 * DEV-66：概览页在代表性窗口高度下不依赖页面或模块内部滚动。
 *
 * jsdom 没有布局引擎，这条几何契约只能由真实浏览器断言：页面根
 * （AppShell 的唯一内容区 `#main-content`）在 800×600 与最大化大窗口下
 * 都必须满足 scrollHeight <= clientHeight + 容差；概览数据区不能再把滚动条
 * 推进指标、关系、图表、标签或待办模块内部。
 */

const sizeProfiles = [
  { height: 600, name: "800x600", width: 800 },
  // Windows 2560×1600 在 175% 显示缩放下的最大化 Tauri client area。
  // 这类中间有效高度必须触发紧凑档，而不能只覆盖极矮或高度充足的两端。
  { height: 866, name: "Windows 175% scaled 1462x866", width: 1462 },
  { height: 1080, name: "1920x1080", width: 1920 },
] as const;

/** 亚像素与滚动条预留的容差（px）。 */
const tolerance = 2;

/** 概览的每个数据模块都必须完整落在页面根可视区内。 */
const overviewSelectors = [
  ".sh-overview__metrics",
  ".sh-overview__relations",
  ".sh-overview__content-grid",
  ".sh-overview__panel",
  ".sh-overview__chart-figure",
  ".sh-overview__details",
  ".sh-overview__tag-panel",
  ".sh-overview__pending",
] as const;

interface BlockGeometry {
  contentHeight: number;
  height: number;
  selector: string;
  scrollHeight: number;
  withinPageRoot: boolean;
}

async function scrollMetrics(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("#main-content");
    if (!main) throw new Error("#main-content is missing");
    return {
      clientHeight: main.clientHeight,
      documentClientHeight: document.documentElement.clientHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      scrollHeight: main.scrollHeight,
    };
  });
}

async function blockGeometry(
  page: import("@playwright/test").Page,
  selectors: readonly string[],
): Promise<BlockGeometry[]> {
  return page.evaluate((list) => {
    const main = document.querySelector<HTMLElement>("#main-content");
    if (!main) throw new Error("#main-content is missing");
    const mainRect = main.getBoundingClientRect();

    return list.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        return {
          contentHeight: 0,
          height: 0,
          scrollHeight: 0,
          selector,
          withinPageRoot: false,
        };
      }
      const rect = element.getBoundingClientRect();
      const withinPageRoot = rect.top >= mainRect.top - 1 && rect.bottom <= mainRect.bottom + 1;
      return {
        contentHeight: element.clientHeight,
        height: rect.height,
        scrollHeight: element.scrollHeight,
        selector,
        withinPageRoot,
      };
    });
  }, selectors as string[]);
}

test.use({ locale: "en-US" });

for (const profile of sizeProfiles) {
  test(`keeps the overview page root free of vertical scroll at ${profile.name} (DEV-25)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.goto("/__preview/overview");

    // 关系投影落地后再测量，避免占位状态引入的几何竞态。
    await expect(page.getByRole("link", { name: "2 Unconfirmed relationship conflicts" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Deployment relation count by agent" })).toBeVisible();

    const metrics = await scrollMetrics(page);
    expect(
      metrics.scrollHeight,
      `page root must not scroll: scrollHeight ${metrics.scrollHeight} vs clientHeight ${metrics.clientHeight}`,
    ).toBeLessThanOrEqual(metrics.clientHeight + tolerance);
    expect(
      metrics.documentScrollHeight,
      "the document itself must never scroll",
    ).toBeLessThanOrEqual(metrics.documentClientHeight + tolerance);
  });

  test(`keeps the overview blocks visible and unclipped at ${profile.name} (DEV-25)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.goto("/__preview/overview");

    await expect(page.getByRole("link", { name: "2 Unconfirmed relationship conflicts" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Deployment relation count by agent" })).toBeVisible();

    for (const block of await blockGeometry(page, overviewSelectors)) {
      expect(block.height, `${block.selector} must remain measurable`).toBeGreaterThan(0);
      expect(
        block.withinPageRoot,
        `${block.selector} must stay fully visible without scrolling`,
      ).toBe(true);
      expect(
        block.scrollHeight,
        `${block.selector} must not clip content behind a fixed-height box`,
      ).toBeLessThanOrEqual(block.contentHeight + tolerance);
    }
  });
}

test("keeps every overview data module free of internal vertical scrolling (DEV-66)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/__preview/overview");

  await expect(page.getByRole("img", { name: "Deployment relation count by agent" })).toBeVisible();

  const scrollableModules = await page.locator(
    ".sh-overview, .sh-overview__metrics, .sh-overview__relations, " +
      ".sh-overview__content-grid, .sh-overview__panel, .sh-overview__details, " +
      ".sh-overview__details-scroll, .sh-overview__tag-panel, " +
      ".sh-overview__tag-details-scroll, .sh-overview__pending",
  ).evaluateAll((elements) => elements
    .filter((element) => {
      const overflowY = getComputedStyle(element).overflowY;
      return overflowY === "auto" || overflowY === "scroll";
    })
    .map((element) => element.className));
  expect(scrollableModules, "overview data modules must not expose vertical scrollbars").toEqual([]);

  const metrics = await scrollMetrics(page);
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + tolerance);
  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.documentClientHeight + tolerance);
});
