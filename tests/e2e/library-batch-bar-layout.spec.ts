import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

test("batch actions stay in the library bar and wrap without clipping at narrow widths", async ({ page }) => {
  const screenshots = path.resolve(process.cwd(), "apps/desktop/test-results/ui/library-batch-bar-layout");
  mkdirSync(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/skill-library");
  await page.getByRole("checkbox", { name: "Select PDF Reader" }).check();

  const bar = page.getByRole("complementary", { name: "Batch actions" });
  const actions = bar.locator(".sh-skill-library__batch-actions");
  const expectedOrder = [
    "Batch dispatch",
    "Add tags",
    "Remove tags",
    "Batch add to combinations",
    "Batch remove from combinations",
    "Batch run basic check",
    "Batch run AI check",
    "Start export",
    "Delete selected Skills from library",
  ];
  const buttons = actions.getByRole("button");
  await expect(buttons).toHaveText(expectedOrder);

  for (const width of [1440, 800, 600, 390, 360]) {
    await page.setViewportSize({ width, height: width < 500 ? 760 : 800 });
    await expect(bar).toBeVisible();
    const geometry = await bar.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const actionContainer = element.querySelector<HTMLElement>(".sh-skill-library__batch-actions");
      const actionBounds = actionContainer!.getBoundingClientRect();
      const buttonBounds = Array.from(actionContainer!.querySelectorAll<HTMLElement>("button"))
        .map((button) => button.getBoundingClientRect());
      const buttonRows = buttonBounds
        .map(({ top }) => top)
        .sort((left, right) => left - right)
        .reduce<number[]>((rows, top) => {
          if (rows.length === 0 || Math.abs(rows[rows.length - 1] - top) > 2) rows.push(top);
          return rows;
        }, []);
      return {
        barBounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
        actionBounds: { left: actionBounds.left, right: actionBounds.right },
        barScrollWidth: element.scrollWidth,
        barClientWidth: element.clientWidth,
        actionScrollWidth: actionContainer!.scrollWidth,
        actionClientWidth: actionContainer!.clientWidth,
        buttonsInsideActions: buttonBounds.every((button) =>
          button.left >= actionBounds.left && button.right <= actionBounds.right,
        ),
        buttonRowCount: buttonRows.length,
        viewportWidth: window.innerWidth,
        pageScrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(geometry.barBounds.left).toBeGreaterThanOrEqual(0);
    expect(geometry.barBounds.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.barBounds.top).toBeGreaterThanOrEqual(0);
    expect(geometry.barScrollWidth).toBeLessThanOrEqual(geometry.barClientWidth);
    expect(geometry.actionScrollWidth).toBeLessThanOrEqual(geometry.actionClientWidth);
    expect(geometry.buttonsInsideActions).toBe(true);
    if (width <= 390) expect(geometry.buttonRowCount).toBeGreaterThan(1);
    expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    await expect(buttons).toHaveText(expectedOrder);
  }
  await page.screenshot({ path: path.join(screenshots, "selected-skills-360x760.png") });

  await buttons.first().focus();
  await expect(buttons.first()).toBeFocused();
  for (let index = 1; index < expectedOrder.length; index += 1) {
    await page.keyboard.press("Tab");
    await expect(buttons.nth(index)).toBeFocused();
  }
});
