import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

test("saved views keep the save action inset and reachable at narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/skill-library");

  const savedViews = page.locator(".sh-skill-library__saved-views");
  const saveButton = page.getByRole("button", { name: "Save current view" });
  await expect(savedViews).toBeVisible();
  await expect(saveButton).toBeVisible();

  const measureSavedViews = () => page.evaluate(() => {
    const container = document.querySelector<HTMLElement>(".sh-skill-library__saved-views");
    const saveButton = container?.querySelector<HTMLElement>(".sh-skill-library__saved-views > section > button");
    const viewList = container?.querySelector<HTMLElement>(".sh-saved-view-list");
    if (!container || !saveButton || !viewList) return null;
    return {
      rightInset: container.getBoundingClientRect().right - saveButton.getBoundingClientRect().right,
      viewListHasOverflow: viewList.scrollWidth > viewList.clientWidth,
      viewListOverflowX: getComputedStyle(viewList).overflowX,
      pageOverflowsHorizontally: document.documentElement.scrollWidth > window.innerWidth,
    };
  });

  const desktopGeometry = await measureSavedViews();
  expect(desktopGeometry).not.toBeNull();
  expect(desktopGeometry?.rightInset).toBeGreaterThanOrEqual(12);
  expect(desktopGeometry?.viewListOverflowX).toBe("auto");
  expect(desktopGeometry?.pageOverflowsHorizontally).toBe(false);

  const desktopScreenshot = path.resolve(process.cwd(), "test-results/fb-004-library-saved-views-1440x900.png");
  fs.mkdirSync(path.dirname(desktopScreenshot), { recursive: true });
  await page.screenshot({ path: desktopScreenshot });

  await page.setViewportSize({ width: 800, height: 900 });
  await expect(saveButton).toBeVisible();
  const narrowGeometry = await measureSavedViews();
  const narrowScreenshot = path.resolve(process.cwd(), "test-results/fb-004-library-saved-views-800x900.png");
  await page.screenshot({ path: narrowScreenshot });
  expect(narrowGeometry).not.toBeNull();
  expect(narrowGeometry?.rightInset).toBeGreaterThanOrEqual(12);
  expect(narrowGeometry?.viewListHasOverflow).toBe(true);
  expect(narrowGeometry?.viewListOverflowX).toBe("auto");
  expect(narrowGeometry?.pageOverflowsHorizontally).toBe(false);

  await saveButton.focus();
  await saveButton.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(saveButton).toBeFocused();
  const saveFocusGeometry = await saveButton.evaluate((element) => {
    const container = element.closest<HTMLElement>(".sh-skill-library__saved-views");
    const style = getComputedStyle(element);
    if (!container) return null;
    const button = element.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    const focusExtent = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
    return {
      outlineStyle: style.outlineStyle,
      focusRingRightGap: bounds.right - button.right - focusExtent,
    };
  });
  expect(saveFocusGeometry).not.toBeNull();
  expect(saveFocusGeometry?.outlineStyle).not.toBe("none");
  expect(saveFocusGeometry?.focusRingRightGap).toBeGreaterThan(0);

  await saveButton.click();
  await expect(page.getByRole("form", { name: "Save current view" })).toBeVisible();
});

test("combination manager remains the right-side module entry with keyboard focus and route", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/skill-library");

  const utilities = page.locator(".sh-skill-library__view-utilities");
  const entry = utilities.getByRole("link", { name: "Combination manager" });
  await expect(entry).toHaveAttribute("href", "/library/combinations");
  await expect(entry.locator("svg")).toHaveCount(1);

  const presentation = await entry.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const utilitiesBounds = element.parentElement?.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      display: style.display,
      background: style.backgroundColor,
      borderStyle: style.borderTopStyle,
      borderWidth: style.borderTopWidth,
      fontWeight: Number.parseInt(style.fontWeight, 10),
      textDecoration: style.textDecorationLine,
      remainsAtUtilityRight: utilitiesBounds !== undefined && Math.abs(bounds.right - utilitiesBounds.right) <= 1,
    };
  });
  expect(presentation.display).toBe("flex");
  expect(presentation.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(presentation.borderStyle).toBe("solid");
  expect(Number.parseFloat(presentation.borderWidth)).toBeGreaterThan(0);
  expect(presentation.fontWeight).toBeGreaterThanOrEqual(600);
  expect(presentation.textDecoration).toBe("none");
  expect(presentation.remainsAtUtilityRight).toBe(true);

  const themeReadability = await entry.evaluate((element) => {
    const root = document.documentElement;
    const previousTheme = root.getAttribute("data-theme");
    const themes = [
      "aurora",
      "codex-light",
      "grok-night",
      "moss-neutral",
      "ocean-cobalt",
      "roast",
      "sakura",
      "spring-signal",
      "terracotta",
    ];
    const luminance = (color: string) => {
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) return 0;
      const linear = channels.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const contrast = (foreground: string, background: string) => {
      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };

    try {
      element.style.transition = "none";
      return themes.map((theme) => {
        root.setAttribute("data-theme", theme);
        const style = getComputedStyle(element);
        const iconStyle = element.querySelector("svg") ? getComputedStyle(element.querySelector("svg")!) : style;
        return {
          theme,
          foreground: style.color,
          background: style.backgroundColor,
          ratio: contrast(style.color, style.backgroundColor),
          iconRatio: contrast(iconStyle.color, style.backgroundColor),
        };
      });
    } finally {
      if (previousTheme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previousTheme);
    }
  });
  for (const result of themeReadability) {
    expect(result.ratio, `${result.theme} theme contrast (${result.foreground} on ${result.background})`).toBeGreaterThanOrEqual(4.5);
    expect(result.iconRatio, `${result.theme} theme icon contrast`).toBeGreaterThanOrEqual(3);
  }

  const restingColors = await entry.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderTopColor };
  });
  await entry.hover();
  const hoverColors = await entry.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderTopColor };
  });
  expect(hoverColors.background).not.toBe(restingColors.background);
  expect(hoverColors.border).not.toBe(restingColors.border);

  const groupButtons = utilities.locator(".sh-skill-library__mode-switch > button");
  await groupButtons.last().focus();
  await groupButtons.last().press("Tab");
  await expect(entry).toBeFocused();
  const focus = await entry.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth) };
  });
  expect(focus.outlineStyle).not.toBe("none");
  expect(focus.outlineWidth).toBeGreaterThan(0);

  const screenshotPath = path.resolve(process.cwd(), "test-results/fb-004-combination-manager-focus.png");
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath });

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/library\/combinations$/);
});
