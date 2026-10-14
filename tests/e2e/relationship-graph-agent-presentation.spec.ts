import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

test.use({ locale: "zh-CN" });

test("graph Agent nodes keep their brand, platform type and connected layout", async ({ page }) => {
  const screenshots = path.resolve(process.cwd(), "apps/desktop/test-results/ui/relationship-graph-agent-presentation");
  mkdirSync(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/__preview/relationships?skillId=skill-agent-brand-preview&fixture=agent-brands");

  const surface = page.getByTestId("skill-graph-surface");
  const agentNodes = page.locator(".sh-graph-node--agent");
  await expect(surface).toBeVisible();
  await expect(agentNodes).toHaveCount(8);
  await expect(surface.locator(".sh-graph-edge__line")).toHaveCount(8);

  const longBrand = page.getByRole("button", { name: "DeepSeek Harness · 桌面端" });
  const unknownBrand = page.getByRole("button", { name: "Mistral Code · 终端" });
  await expect(longBrand).toBeVisible();
  await expect(unknownBrand).toBeVisible();
  await expect(longBrand.locator(".sh-agent-presentation__kind")).toHaveText("桌面端");
  await expect(unknownBrand.locator(".sh-brand-tag--neutral .sh-brand-tag__fallback")).toHaveText("M");
  await expect(longBrand.locator(".sh-agent-presentation")).toHaveAttribute(
    "title",
    "DeepSeek Harness · 桌面端",
  );
  await expect(longBrand.locator(".sh-graph-node__kind")).toHaveCount(0);

  const noAgentOverlap = await agentNodes.evaluateAll((nodes) => {
    const boxes = nodes.map((node) => node.getBoundingClientRect());
    return boxes.every((box, index) => boxes.slice(index + 1).every((other) =>
      box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top,
    ));
  });
  expect(noAgentOverlap).toBe(true);

  await page.locator("html").evaluate((root) => root.setAttribute("data-theme", "grok-night"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "grok-night");
  await expect(longBrand.locator(".sh-brand-tag__icon")).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "dense-agents-dark-1280x800.png") });

  const layer = page.locator(".sh-graph-canvas__layer");
  const transformBeforeZoom = await layer.getAttribute("style");
  await page.getByRole("button", { name: "放大" }).click();
  await expect.poll(() => layer.getAttribute("style")).not.toBe(transformBeforeZoom);

  await page.locator(".sh-graph-canvas__controls").getByRole("button").last().focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(longBrand).toBeFocused();
  expect(await longBrand.evaluate((node) => node.matches(":focus-visible"))).toBe(true);
  await page.keyboard.press("Enter");
  await expect(longBrand).toHaveClass(/is-selected/);

  const details = page.locator(".sh-graph-details");
  await expect(details.locator(".sh-agent-presentation")).toHaveAttribute(
    "aria-label",
    "DeepSeek Harness · 桌面端",
  );
  await expect(details.locator(".sh-agent-presentation__kind")).toHaveText("桌面端");

  await page.setViewportSize({ width: 800, height: 600 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
  await expect(longBrand).toBeVisible();
  const noNarrowOverlap = await agentNodes.evaluateAll((nodes) => {
    const boxes = nodes.map((node) => node.getBoundingClientRect());
    return boxes.every((box, index) => boxes.slice(index + 1).every((other) =>
      box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top,
    ));
  });
  expect(noNarrowOverlap).toBe(true);
  await page.screenshot({ path: path.join(screenshots, "dense-agents-narrow-800x600.png") });
});
