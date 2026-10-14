import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

test.use({ locale: "zh-CN" });

test("graph overlays stay readable and details remain top-aligned at compact widths", async ({ page }) => {
  const screenshots = path.resolve(process.cwd(), "apps/desktop/test-results/ui/relationship-graph-presentation");
  mkdirSync(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/__preview/relationships?skillId=skill-long-path-preview&fixture=long-path");

  const surface = page.getByTestId("skill-graph-surface");
  await expect(surface).toBeVisible();
  const controls = page.locator(".sh-graph-canvas__controls");
  const legend = page.locator(".sh-graph__legend");
  const details = page.locator(".sh-graph-details");
  await expect(controls).toBeVisible();
  await expect(legend).toBeVisible();
  await expect(details).toBeVisible();

  for (const theme of ["moss-neutral", "grok-night"]) {
    await page.locator("html").evaluate((root, name) => root.setAttribute("data-theme", name), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

    const controlStyle = await controls.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        backdrop: style.backdropFilter,
        borderStyle: style.borderTopStyle,
        shadow: style.boxShadow,
      };
    });
    const legendStyle = await legend.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        backdrop: style.backdropFilter,
        borderStyle: style.borderTopStyle,
        shadow: style.boxShadow,
      };
    });
    expect(controlStyle.background).not.toBe("rgba(0, 0, 0, 0)");
    const backgroundAlpha = Number(
      controlStyle.background.match(/\/\s*([\d.]+)\s*\)$/)?.[1]
        ?? controlStyle.background.match(/,\s*([\d.]+)\s*\)$/)?.[1],
    );
    expect(backgroundAlpha).toBeCloseTo(0.72);
    expect(controlStyle.backdrop).toBe("blur(6px)");
    expect(controlStyle.borderStyle).toBe("solid");
    expect(controlStyle.shadow).not.toBe("none");
    expect(legendStyle).toEqual(controlStyle);
    if (theme === "moss-neutral") {
      await page.screenshot({ path: path.join(screenshots, "light-center-details-1280x800.png") });
    }
  }

  const legendToggle = legend.getByRole("button");
  await expect(legendToggle).toHaveAttribute("aria-expanded", "false");
  await legendToggle.click();
  await expect(legendToggle).toHaveAttribute("aria-expanded", "true");

  const zoomIn = controls.getByRole("button").first();
  const layer = page.locator(".sh-graph-canvas__layer");
  const transformBeforeZoom = await layer.getAttribute("style");
  await zoomIn.click();
  await expect.poll(() => layer.getAttribute("style")).not.toBe(transformBeforeZoom);

  const sourceNode = page.locator(".sh-graph-node--source");
  await expect(sourceNode).toBeVisible();
  await sourceNode.click();
  const pathDetail = details.locator(".sh-relationship-path");
  await expect(pathDetail).toBeVisible();
  expect(await pathDetail.getAttribute("title")).toContain("a-path-that-is-deliberately-long");
  await page.screenshot({ path: path.join(screenshots, "dark-long-path-details-1280x800.png") });

  const detailLayout = await details.evaluate((element) => {
    const style = getComputedStyle(element);
    const center = element.querySelector(".sh-graph-details__center")!.getBoundingClientRect();
    const selection = element.querySelector(".sh-graph-details__selection")!.getBoundingClientRect();
    return {
      alignContent: style.alignContent,
      overflowY: style.overflowY,
      firstContentOffset: center.top - element.getBoundingClientRect().top,
      sectionGap: selection.top - center.bottom,
    };
  });
  expect(detailLayout.alignContent).toBe("start");
  expect(detailLayout.overflowY).toBe("auto");
  expect(detailLayout.firstContentOffset).toBeLessThan(36);
  expect(detailLayout.sectionGap).toBeLessThan(36);

  const zoomOut = controls.getByRole("button").nth(1);
  await zoomIn.focus();
  await page.keyboard.press("Tab");
  await expect(zoomOut).toBeFocused();
  expect(await zoomOut.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  expect(await zoomOut.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe("2px");

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await controls.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  expect(await legend.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.setViewportSize({ width: 800, height: 600 });
  await legendToggle.click();
  await expect(legendToggle).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
  await expect(surface).toBeVisible();
  await expect(legend).toBeVisible();

  const narrowScrollMetrics = await details.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(narrowScrollMetrics.scrollHeight).toBeGreaterThan(narrowScrollMetrics.clientHeight);
  await details.hover();
  const documentScrollBefore = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(documentScrollBefore);
  const pathInsidePanel = await pathDetail.evaluate((element) => {
    const pathBounds = element.getBoundingClientRect();
    const panelBounds = element.closest(".sh-graph-details")!.getBoundingClientRect();
    return pathBounds.top >= panelBounds.top && pathBounds.bottom <= panelBounds.bottom;
  });
  expect(pathInsidePanel).toBe(true);
  await page.screenshot({ path: path.join(screenshots, "dark-long-path-details-800x600.png") });
});
