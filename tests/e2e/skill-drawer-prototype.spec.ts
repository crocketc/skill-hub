import { expect, test } from "@playwright/test";

test("drawer review prototype stays isolated and fits a compact desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review");

  const drawer = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveClass(/sh-skill-drawer--prototype/);
  await page.waitForFunction(() => {
    const panel = document.querySelector(".sh-skill-drawer--prototype");
    return panel !== null && panel.getAnimations().every((animation) => animation.playState === "finished");
  });

  const geometry = await drawer.evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    const chrome = panel.querySelector<HTMLElement>(".sh-skill-drawer__chrome");
    const body = panel.querySelector<HTMLElement>(".sh-skill-drawer__scroll");
    return {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      radius: Number.parseFloat(getComputedStyle(panel).borderTopLeftRadius),
      bodyHeight: body?.getBoundingClientRect().height ?? 0,
      headerHeight: chrome?.getBoundingClientRect().height ?? 0,
      right: rect.right,
      top: rect.top,
    };
  });

  expect(geometry.left).toBeGreaterThanOrEqual(8);
  expect(geometry.top).toBeGreaterThanOrEqual(8);
  expect(geometry.right).toBeLessThanOrEqual(742);
  expect(geometry.bottom).toBeLessThanOrEqual(711);
  expect(geometry.radius).toBeGreaterThanOrEqual(12);
  expect(geometry.bodyHeight).toBeGreaterThan(geometry.height * 0.6);
  expect(geometry.headerHeight).toBeLessThan(geometry.height * 0.4);

  await expect(drawer.locator(".sh-skill-drawer__pinned-title h2")).toHaveText("PDF Reader");
  const prototypeActions = drawer.locator(".sh-skill-drawer__prototype-actions");
  const actionButtons = prototypeActions.locator("button[data-prototype-action]");
  await expect(actionButtons).toHaveCount(3);
  for (const button of await actionButtons.all()) {
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(button).not.toBeEmpty();
  }
  const actionDescription = await actionButtons.first().getAttribute("aria-describedby");
  expect(actionDescription).toBeTruthy();
  await expect(drawer.locator(`[id="${actionDescription}"]`)).not.toBeEmpty();
  const widthCycle = drawer.locator(".sh-skill-drawer__prototype-presets button");
  await expect(widthCycle).toHaveCount(1);
  const initialWidthLabel = await widthCycle.getAttribute("aria-label");
  expect(initialWidthLabel?.trim().length).toBeGreaterThan(0);
  await widthCycle.click();
  await expect(widthCycle).not.toHaveAttribute("aria-label", initialWidthLabel ?? "");
  await expect(widthCycle).toHaveAttribute("title", await widthCycle.getAttribute("aria-label") ?? "");
  const updateLink = drawer.locator(".sh-skill-drawer__prototype-update a");
  await expect(updateLink).toBeVisible();
  await expect(updateLink).toHaveAttribute("href", /#versions$/);
  await expect(drawer.getByRole("heading", { name: "依赖与重复项" })).toHaveCount(0);
  await expect(drawer.getByRole("heading", { name: "外部变更" })).toHaveCount(0);
  const agentCards = drawer.locator(".sh-skill-drawer__prototype-agent-card .sh-agent-presentation");
  await expect(agentCards).toHaveCount(2);
  await agentCards.first().scrollIntoViewIfNeeded();
  await expect(agentCards.nth(0)).toHaveAttribute("aria-label", /OpenAI.*(?:Terminal|终端)/);
  await expect(agentCards.nth(1)).toHaveAttribute("aria-label", /Claude.*(?:Terminal|终端)/);

  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(pageWidth).toBeLessThanOrEqual(750);
});

test("drawer review prototype remains inside a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review");

  const drawer = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveClass(/sh-skill-drawer--prototype/);
  await page.waitForFunction(() => {
    const panel = document.querySelector(".sh-skill-drawer--prototype");
    return panel !== null && panel.getAnimations().every((animation) => animation.playState === "finished");
  });

  const geometry = await drawer.evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(8);
  expect(geometry.right).toBeLessThanOrEqual(382);
  expect(geometry.width).toBeLessThanOrEqual(374);
  const prototypeActions = drawer.locator(".sh-skill-drawer__prototype-actions");
  await expect(prototypeActions.locator("button")).toHaveCount(3);
  await expect(prototypeActions).toBeVisible();
  const purposeHelp = drawer.locator(".sh-skill-drawer__purpose-row .sh-skill-drawer__edit-icon");
  await purposeHelp.focus();
  await expect.poll(() => purposeHelp.evaluate((element) => getComputedStyle(element, "::after").visibility)).toBe("visible");
  const helpGeometry = await purposeHelp.evaluate((element) => {
    const tooltip = getComputedStyle(element, "::after");
    return {
      focusVisible: element.matches(":focus-visible"),
      maxWidth: Number.parseFloat(tooltip.maxWidth),
      whiteSpace: tooltip.whiteSpace,
    };
  });
  expect(helpGeometry.focusVisible).toBe(true);
  expect(helpGeometry.maxWidth).toBeLessThanOrEqual(240);
  expect(helpGeometry.whiteSpace).toBe("normal");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("review layout only activates with the explicit development preview flag", async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf");

  const drawer = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();
  await expect(drawer).not.toHaveClass(/sh-skill-drawer--prototype/);
  await expect(drawer.locator(".sh-skill-drawer__prototype-actions")).toHaveCount(0);
});
