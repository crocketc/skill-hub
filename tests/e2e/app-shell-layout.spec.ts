import { expect, test, type Page } from "./fixtures";

/**
 * M-17-1 壳层验收（真实 AppShell + Sidebar，经 /__preview/skill-library）：
 * 全高侧栏与内容区顶栏并排，收起态 Logo 迁入内容区顶栏左侧；800/1024/1280
 * 与最小高度 600 无水平横溢。
 */

test.use({ locale: "en-US" });

const NAVIGATION = "Main navigation";
const TOGGLE_NAME = /Collapse navigation|Expand navigation/;

async function expectNoRootHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `${label}: scrollWidth (${overflow.scrollWidth}) must not exceed clientWidth (${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

function boxesIntersect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const tolerance = 1;
  return !(
    a.x + a.width <= b.x + tolerance ||
    b.x + b.width <= a.x + tolerance ||
    a.y + a.height <= b.y + tolerance ||
    b.y + b.height <= a.y + tolerance
  );
}

test.describe("app shell collapse button placement", () => {
  for (const width of [800, 1024, 1280] as const) {
    test(`keeps the sidebar toggle and brand geometry stable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/skill-library");

      const toggle = page.getByRole("button", { name: TOGGLE_NAME });
      await expect(toggle).toBeVisible();

      const box = (await toggle.boundingBox())!;
      // 折叠按钮与顶栏应用控件统一为 40px 方形点击面积。
      expect(Math.abs(box.width - box.height), "toggle must be square").toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - 40), "toggle stays a 40px target").toBeLessThanOrEqual(2);
      // 固定在页面左上角（5rem = 80px 内）。
      expect(box.x, "toggle sits in the left edge band").toBeLessThan(80);
      expect(box.y, "toggle sits in the top edge band").toBeLessThan(80);

      // 展开态按钮与实际 Logo 图形不重叠；不是拿占满头部的 Link 外框比较。
      const aside = page.getByRole("complementary", { name: NAVIGATION });
      const brandBox = (await aside.locator(".sh-brand-logo").boundingBox())!;
      const firstLinkBox = (await aside.getByRole("link", { name: "Overview" }).boundingBox())!;
      expect(
        boxesIntersect(box, brandBox),
        "toggle must not overlap the visible brand mark",
      ).toBe(false);
      expect(
        boxesIntersect(box, firstLinkBox),
        "toggle must not overlap the first navigation link",
      ).toBe(false);

      // 点击折叠：状态切换且按钮位置保持稳定（标题栏位置不随侧栏宽度变化）。
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(aside).toHaveClass(/is-collapsed/);
      const collapsedBox = (await toggle.boundingBox())!;
      expect(Math.abs(collapsedBox.x - box.x), "toggle x stays fixed across collapse").toBeLessThanOrEqual(2);
      expect(Math.abs(collapsedBox.y - box.y), "toggle y stays fixed across collapse").toBeLessThanOrEqual(1);

      await expect(toggle).toHaveAttribute("aria-label", "Expand navigation");
      const compactBrand = page.locator(".sh-app-shell__compact-brand .sh-brand-logo");
      await expect(compactBrand).toBeVisible();
      const compactBrandBox = (await compactBrand.boundingBox())!;
      expect(compactBrandBox.x, "collapsed brand follows the toggle visually").toBeGreaterThan(
        collapsedBox.x + collapsedBox.width,
      );
      await expectNoRootHorizontalOverflow(page, `shell@${width}`);
    });
  }

  test("lays out the full-height sidebar beside the content title bar", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/__preview/skill-library");

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? element.getBoundingClientRect().toJSON() : null;
      };
      return {
        bar: rect(".sh-app-shell__topbar"),
        aside: rect(".sh-sidebar"),
        workspace: rect(".sh-app-shell__workspace"),
      };
    });

    // 侧栏全高；内容顶栏从侧栏右边开始，与侧栏顶部对齐。
    expect(geometry.bar).not.toBeNull();
    expect(geometry.aside).not.toBeNull();
    expect(geometry.workspace).not.toBeNull();
    expect(geometry.bar!.x).toBeCloseTo(geometry.aside!.right, 0);
    expect(geometry.bar!.width).toBeCloseTo(geometry.workspace!.width, 0);
    expect(geometry.bar!.y).toBeCloseTo(geometry.aside!.y, 0);
    expect(geometry.aside!.height).toBeCloseTo(900, 0);

    // 技能库路由：视图切换渲染在标题栏 context 分区。
    const switchGroup = page.getByRole("group", { name: "View mode" });
    await expect(switchGroup).toBeVisible();
    const switchBox = (await switchGroup.boundingBox())!;
    expect(switchBox.y, "view switch shares the title-bar row").toBeLessThan(
      geometry.bar!.bottom,
    );
  });

  test("keyboard focus reaches the sidebar toggle first after the skip link", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/skill-library");

    // Tab 顺序：Skip Link 后紧随侧栏头部折叠按钮。
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: TOGGLE_NAME })).toBeFocused();
  });

  test("keeps the shell free of horizontal overflow at the 600px minimum height", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.goto("/__preview/skill-library");

    await expect(page.getByRole("complementary", { name: NAVIGATION })).toBeVisible();
    await expectNoRootHorizontalOverflow(page, "shell@1024x600");
  });

  test("keeps the notification bell reachable on skill detail routes", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/skill-detail/skill-pdf");

    // 通知中心入口保持可达（≥40px 命中区域）。
    const bell = page.getByRole("button", { name: "Notifications" });
    await expect(bell).toBeVisible();
    const box = (await bell.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.width).toBeGreaterThanOrEqual(40);

    await bell.click();
    await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
  });
});
