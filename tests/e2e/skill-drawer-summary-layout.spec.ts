import { expect, test } from "@playwright/test";

// macOS 的网页引擎曾将字段值区膨胀到百余像素，普通 DOM 单测无法检测。
test.use({ browserName: "webkit" });

for (const viewport of [{ width: 950, height: 750 }, { width: 750, height: 719 }]) {
  test(`drawer summary keeps single-line fields compact at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review");
    const fields = page.locator(".sh-skill-drawer__summary-item");
    await expect(fields).toHaveCount(6);
    await expect(fields.first()).toContainText(/reader/i);

    const boxes = await fields.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    }));
    for (const box of boxes) {
      expect(box.height).toBeGreaterThan(20);
      expect(box.height).toBeLessThanOrEqual(80);
    }
    for (let row = 0; row < 3; row += 1) {
      expect(boxes[row * 2].top).toBeCloseTo(boxes[row * 2 + 1].top, 0);
      if (row < 2) {
        expect(boxes[(row + 1) * 2].top - boxes[row * 2].bottom).toBeCloseTo(4, 0);
      }
    }
  });
}
