import { expect, test, type Page } from "./fixtures";

/**
 * P1-01a 壳层验收（真实 AppShell + Sidebar，经 /__preview/skill-library）：
 * 折叠按钮是固定在左上角的小型方形按钮（40px、方形、位置稳定），折叠前后
 * 原点不变，与 brand/首个导航项无重叠；侧栏内首个可聚焦元素；800/1024/1280
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
    test(`square toggle stays fixed in the top-left corner at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/skill-library");

      const aside = page.getByRole("complementary", { name: NAVIGATION });
      const toggle = aside.getByRole("button", { name: TOGGLE_NAME });
      await expect(toggle).toBeVisible();

      const box = (await toggle.boundingBox())!;
      // 方形且约 40px（2.5rem）点击面积。
      expect(Math.abs(box.width - box.height), "toggle must be square").toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - 40), "toggle stays a ~40px target").toBeLessThanOrEqual(2);
      // 固定在页面左上角（5rem = 80px 内）。
      expect(box.x, "toggle sits in the left edge band").toBeLessThan(80);
      expect(box.y, "toggle sits in the top edge band").toBeLessThan(80);

      // 与 brand 和首个导航项无重叠。
      const brandBox = (await aside.getByRole("link", { name: "SkillHub" }).boundingBox())!;
      const firstLinkBox = (await aside.getByRole("link", { name: "Overview" }).boundingBox())!;
      expect(
        boxesIntersect(box, brandBox),
        "toggle must not overlap the brand link",
      ).toBe(false);
      expect(
        boxesIntersect(box, firstLinkBox),
        "toggle must not overlap the first navigation link",
      ).toBe(false);

      // 点击折叠：状态切换且按钮位置保持稳定（“固定”）。折叠窄条内按钮
      // 水平居中带来 ≤2px 的亚像素位移，页面位置不变。
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(aside).toHaveClass(/is-collapsed/);
      const collapsedBox = (await toggle.boundingBox())!;
      expect(Math.abs(collapsedBox.x - box.x), "toggle x stays fixed across collapse").toBeLessThanOrEqual(2);
      expect(Math.abs(collapsedBox.y - box.y), "toggle y stays fixed across collapse").toBeLessThanOrEqual(1);

      await expect(toggle).toHaveAttribute("aria-label", "Expand navigation");
      await expectNoRootHorizontalOverflow(page, `shell@${width}`);
    });
  }

  test("keyboard focus reaches the toggle first inside the sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/skill-library");

    // Tab 顺序：壳层第一个可聚焦元素是 Skip Link，紧随其后的是侧栏内
    // 第一个元素——左上角的折叠按钮。
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

    // 详情路由隐藏顶栏，但通知中心入口仍以浮动铃铛保持可达（≥40px 命中区域）。
    const bell = page.getByRole("button", { name: "Notifications" });
    await expect(bell).toBeVisible();
    const box = (await bell.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.width).toBeGreaterThanOrEqual(40);

    await bell.click();
    await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
  });
});
