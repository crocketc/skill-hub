import { expect, test } from "./fixtures";

/**
 * DEV-25：概览页不得出现"无必要的页面级纵向滚动"。
 *
 * jsdom 没有布局引擎，这条几何契约只能由真实浏览器断言：页面根
 * （AppShell 的唯一滚动区 `#main-content`）在 800×600 与最大化大窗口下
 * 都必须满足 scrollHeight <= clientHeight + 容差；内容不被裁掉——每个区块
 * 要么完整落在页面根可视区内，要么落在"真的会滚"的卡片内（可滚即未被裁掉），
 * 且不能出现被 overflow:hidden 祖先裁掉又无处可滚的区块。
 */

const sizeProfiles = [
  { height: 600, name: "800x600", width: 800 },
  { height: 1080, name: "1920x1080", width: 1920 },
] as const;

/** 亚像素与滚动条预留的容差（px）。 */
const tolerance = 2;

/** 无滚动时也必须完整可见的区块（首屏主体）。 */
const alwaysVisibleSelectors = [
  ".sh-overview__metrics",
  ".sh-overview__relations",
  ".sh-overview__content-grid",
  ".sh-overview__panel",
  ".sh-overview__chart-figure",
] as const;

/** 允许由卡片内部滚动承载的区块（页面根仍然不滚）。 */
const reachableSelectors = [
  ".sh-overview__details",
  ".sh-overview__tag-panel",
  ".sh-overview__pending",
] as const;

interface BlockGeometry {
  height: number;
  reachable: boolean;
  selector: string;
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

    /** 从元素往上找第一个"真的会滚"的祖先（在页面根之内）。 */
    const scrollableAncestor = (element: HTMLElement): HTMLElement | null => {
      let node = element.parentElement;
      while (node && node !== main.parentElement) {
        const overflowY = getComputedStyle(node).overflowY;
        if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    };

    /** 是否存在一个 overflow:hidden 的祖先把元素裁掉（且中间没有可滚祖先）。 */
    const clippedByHiddenAncestor = (element: HTMLElement): boolean => {
      const rect = element.getBoundingClientRect();
      let node = element.parentElement;
      while (node && node !== main.parentElement) {
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") return false;
        if (overflowY === "hidden") {
          const box = node.getBoundingClientRect();
          if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1) return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    return list.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return { height: 0, reachable: false, selector, withinPageRoot: false };
      const rect = element.getBoundingClientRect();
      const withinPageRoot = rect.top >= mainRect.top - 1 && rect.bottom <= mainRect.bottom + 1;
      const scroller = scrollableAncestor(element);
      return {
        height: rect.height,
        reachable: (withinPageRoot || Boolean(scroller)) && !clippedByHiddenAncestor(element),
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

    // 首屏主体：不需要任何滚动就完整可见。
    for (const block of await blockGeometry(page, alwaysVisibleSelectors)) {
      expect(block.height, `${block.selector} must remain measurable`).toBeGreaterThan(0);
      expect(
        block.withinPageRoot,
        `${block.selector} must stay fully visible without scrolling`,
      ).toBe(true);
    }

    // 其余区块：页面根不滚的前提下，由卡片内部滚动承载——可见但绝不被裁掉。
    for (const block of await blockGeometry(page, reachableSelectors)) {
      expect(block.height, `${block.selector} must remain measurable`).toBeGreaterThan(0);
      expect(block.reachable, `${block.selector} must not be clipped`).toBe(true);
    }
  });
}

test("scrolls inside the cards, not the page, when the overview content grows (DEV-25)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/__preview/overview");

  await expect(page.getByRole("img", { name: "Deployment relation count by agent" })).toBeVisible();

  // 列表类区域自己在卡片内滚动（页面根保持不滚）。
  await expect(page.locator(".sh-overview__tag-details-scroll")).toHaveCSS("overflow-y", "auto");
  await expect(page.locator(".sh-overview__content-grid")).toHaveCSS("overflow-y", "auto");
  await expect(page.locator(".sh-overview__relations")).toHaveCSS("overflow-y", "auto");
  await expect(page.locator(".sh-overview__metrics")).toHaveCSS("overflow-y", "auto");

  const metrics = await scrollMetrics(page);
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + tolerance);
});
