import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

const screenshotDirectory = path.resolve(process.cwd(), "test-results/ui/skill-drawer");

test("quick drawer keeps only its toolbar and name fixed while long content scrolls without clipping", async ({ page }, testInfo) => {
  await page.goto("/__preview/skill-library");
  await page.getByRole("heading", { name: "PDF Reader" }).click();

  const drawer = page.getByTestId("skill-quick-drawer");
  const panel = page.getByTestId("drawer-panel");
  const title = drawer.locator(".sh-skill-drawer__pinned-title h2");
  const openingMotion = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  expect(openingMotion).toEqual({ name: "sh-skill-drawer-in", duration: "0.36s" });
  await expect(drawer).toBeVisible();
  await expect.poll(() => panel.evaluate((element) =>
    element.getAnimations().filter((animation) => animation.playState === "running").length,
  )).toBe(0);
  const body = drawer.getByTestId("drawer-modules-scroll");
  await expect(body).toHaveAttribute("role", "region");
  await expect(body).toHaveAttribute("tabindex", "0");
  const editButtons = drawer.locator(".sh-skill-drawer__edit-icon");
  await expect(editButtons).toHaveCount(4);
  const editButtonGeometry = await editButtons.evaluateAll((buttons) => buttons.map((button) => {
    // offsetWidth/Height measure the CSS hit box before fractional transforms
    // from the drawer's slide animation are applied to the visual rect.
    return { width: (button as HTMLElement).offsetWidth, height: (button as HTMLElement).offsetHeight };
  }));
  expect(editButtonGeometry.every(({ width, height }) => width >= 40 && height >= 40)).toBe(true);
  for (let tabCount = 0; tabCount < 60; tabCount += 1) {
    if (await drawer.locator(".sh-skill-drawer__edit-icon:focus-visible").count()) break;
    await page.keyboard.press("Tab");
  }
  const keyboardFocusedEdit = drawer.locator(".sh-skill-drawer__edit-icon:focus-visible").first();
  await expect(keyboardFocusedEdit).toBeFocused();
  await expect.poll(() => keyboardFocusedEdit.evaluate((button) =>
    getComputedStyle(button, "::after").visibility,
  )).toBe("visible");
  await keyboardFocusedEdit.evaluate((button) => (button as HTMLElement).blur());
  await editButtons.first().hover();
  await expect.poll(() => editButtons.first().evaluate((button) =>
    getComputedStyle(button, "::after").visibility,
  )).toBe("visible");
  await page.mouse.move(0, 0);

  const longDescription = "Source description remains available while the rest of the drawer scrolls. ".repeat(90);
  await drawer.locator(".sh-skill-drawer__description-block .sh-skill-drawer__field-value")
    .evaluate((field, content) => { field.textContent = content; }, longDescription);

  for (const viewport of [
    { width: 800, height: 600 },
    { width: 900, height: 600 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const measurements = await drawer.evaluate((root) => {
      const panel = document.querySelector<HTMLElement>('[data-testid="drawer-panel"]')!;
      const scroll = root.querySelector<HTMLElement>('[data-testid="drawer-modules-scroll"]')!;
      const chrome = root.querySelector<HTMLElement>(".sh-skill-drawer__chrome")!;
      const identity = root.querySelector<HTMLElement>(".sh-skill-drawer__overview")!;
      const actions = root.querySelector<HTMLElement>(".sh-skill-drawer__actions")!;
      const risk = root.querySelector<HTMLElement>(".sh-skill-drawer__risk")!;
      const description = root.querySelector<HTMLElement>(".sh-skill-drawer__description-block .sh-skill-drawer__field-value")!;
      const style = getComputedStyle(description);
      const lineHeight = Number.parseFloat(style.lineHeight);
      return {
        panelHeight: panel.clientHeight,
        bodyHeight: scroll.clientHeight,
        identityInBody: scroll.contains(identity),
        actionsInBody: scroll.contains(actions),
        riskInBody: scroll.contains(risk),
        titleInChrome: chrome.contains(root.querySelector(".sh-skill-drawer__pinned-title h2")),
        descriptionHeight: description.getBoundingClientRect().height,
        threeLines: lineHeight * 3,
      };
    });

    expect(measurements.bodyHeight / measurements.panelHeight).toBeGreaterThanOrEqual(0.6);
    expect(measurements.identityInBody).toBe(true);
    expect(measurements.actionsInBody).toBe(true);
    expect(measurements.riskInBody).toBe(true);
    expect(measurements.titleInChrome).toBe(true);
    expect(measurements.descriptionHeight).toBeGreaterThan(measurements.threeLines);

    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath(`quick-drawer-${viewport.width}x${viewport.height}-top.png`),
    });
    const titleTopBeforeScroll = await title.evaluate((element) => element.getBoundingClientRect().top);
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(title).toBeVisible();
    await expect.poll(() => title.evaluate((element) => element.getBoundingClientRect().top))
      .toBe(titleTopBeforeScroll);
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath(`quick-drawer-${viewport.width}x${viewport.height}-scrolled.png`),
    });
    await body.evaluate((element) => { element.scrollTop = 0; });
  }

  await drawer.getByRole("button", { name: "Close" }).click();
  const closingPanel = page.locator(".sh-skill-drawer[data-state='closed']");
  await expect(closingPanel).toHaveCount(1);
  const closingMotion = await closingPanel.evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  expect(closingMotion).toEqual({ name: "sh-skill-drawer-out", duration: "0.32s" });
  await expect(panel).toBeHidden();
});

test("quick drawer honors its reduced-motion setting", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("skillhub.reduced-motion", "true"));
  await page.goto("/__preview/skill-library");
  await page.getByRole("heading", { name: "PDF Reader" }).click();

  const panel = page.getByTestId("drawer-panel");
  await expect(panel).toHaveAttribute("data-reduced-motion", "true");
  await expect.poll(() => panel.evaluate((element) => getComputedStyle(element).animationName))
    .toBe("none");
  await page.getByTestId("skill-quick-drawer").getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
});

test("quick drawer stays readable at the minimum viewport in a dark theme", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("skillhub.appearance", "dark");
    localStorage.setItem("skillhub.reduced-motion", "true");
  });
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/__preview/skill-library");
  await page.getByRole("heading", { name: "PDF Reader" }).click();

  const drawer = page.getByTestId("skill-quick-drawer");
  const body = drawer.getByTestId("drawer-modules-scroll");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "grok-night");
  await expect.poll(() => body.evaluate((element) =>
    element.clientHeight / document.querySelector<HTMLElement>("[data-testid='drawer-panel']")!.clientHeight,
  )).toBeGreaterThanOrEqual(0.6);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("quick-drawer-dark-800x600.png"),
  });
  const pinnedTitle = drawer.locator(".sh-skill-drawer__pinned-title h2");
  const titleTop = await pinnedTitle.evaluate((element) => element.getBoundingClientRect().top);
  const runBasicCheck = drawer.getByRole("button", { name: "Run basic check" });
  await runBasicCheck.scrollIntoViewIfNeeded();
  await expect(runBasicCheck).toBeInViewport();
  await expect.poll(() => pinnedTitle.evaluate((element) => element.getBoundingClientRect().top)).toBe(titleTop);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("quick-drawer-security-dark-800x600.png"),
  });
  const finding = drawer.getByText("发现疑似凭据字符串，请先确认来源。");
  await finding.scrollIntoViewIfNeeded();
  await expect(finding).toBeInViewport();
  await expect(drawer.getByRole("button", { name: "Acknowledge" })).toBeInViewport();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("quick-drawer-security-finding-dark-800x600.png"),
  });
});

test("quick drawer keeps its lifecycle summary, actions, and module controls usable", async ({ page }, testInfo) => {
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/skill-library");
  const skillCard = page.getByRole("heading", { name: "PDF Reader" }).locator("xpath=../..");
  await skillCard.getByRole("heading", { name: "PDF Reader" }).click();

  const drawer = page.getByTestId("skill-quick-drawer");
  const panel = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".sh-skill-drawer__summary-item--lifecycle")).toContainText("Regular");
  await expect(drawer.locator(".sh-skill-drawer__summary-item--version")).toContainText("1.4.0");
  await expect(drawer.locator(".sh-skill-drawer__summary-item--agents")).toBeVisible();
  await expect(drawer.locator(".sh-skill-drawer__summary-item--projects")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Add to…" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Run basic check" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Run AI check" })).toBeVisible();
  await expect(drawer.getByText("发现疑似凭据字符串，请先确认来源。")).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Open security checks" })).toHaveCount(0);
  const runBasicCheck = drawer.getByRole("button", { name: "Run basic check" });
  await runBasicCheck.scrollIntoViewIfNeeded();
  await expect(runBasicCheck).toBeInViewport();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("quick-drawer-security-module-1440x900.png"),
  });
  await drawer.getByTestId("drawer-modules-scroll").evaluate((element) => { element.scrollTop = 0; });
  await expect(drawer.getByRole("link", { name: "View versions" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Delete from library" })).toBeVisible();
  await expect(drawer.getByRole("region", { name: "Risk summary" })).toBeVisible();
  const standardWidth = drawer.getByRole("button", { name: "Standard width" });
  await expect(standardWidth).toHaveAttribute("title", "Standard width");
  await expect(standardWidth.locator(".sh-skill-drawer__preset-icon")).toBeVisible();
  await expect(drawer.locator(".sh-skill-drawer__summary-grid")).toBeInViewport();
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    path: path.join(screenshotDirectory, "skill-drawer-1440x900.png"),
  });

  const resizeHandle = panel.getByRole("separator", { name: "Resize quick drawer" });
  const initialWidth = Number(await resizeHandle.getAttribute("aria-valuenow"));
  await resizeHandle.focus();
  await expect(resizeHandle).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(resizeHandle).toHaveAttribute("aria-valuenow", String(initialWidth + 16));
  await page.keyboard.press("ArrowRight");
  await expect(resizeHandle).toHaveAttribute("aria-valuenow", String(initialWidth));

  await drawer.getByRole("button", { name: "Configure quick drawer" }).click();
  const configuration = drawer.getByRole("region", { name: "Configure quick drawer" });
  const versionsToggle = configuration.getByRole("button", { name: "Versions" });
  const relationsToggle = configuration.getByRole("button", { name: "Relations" });
  await expect(versionsToggle).toHaveAttribute("aria-pressed", "true");
  await expect(relationsToggle).toHaveAttribute("aria-pressed", "true");

  const versionsBox = await versionsToggle.boundingBox();
  const relationsBox = await relationsToggle.boundingBox();
  expect(versionsBox).not.toBeNull();
  expect(relationsBox).not.toBeNull();
  await page.mouse.move(versionsBox!.x + versionsBox!.width / 2, versionsBox!.y + versionsBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(relationsBox!.x + relationsBox!.width / 2, relationsBox!.y + relationsBox!.height / 2, { steps: 6 });
  await page.mouse.up();
  const moduleHeadings = drawer.locator(".sh-skill-drawer__modules .sh-skill-drawer__module h3");
  await expect(moduleHeadings.first()).toHaveText("Versions");

  const externalChangesToggle = configuration.getByRole("button", { name: "External changes" });
  await externalChangesToggle.click();
  await expect(externalChangesToggle).toHaveAttribute("aria-pressed", "false");
  await expect(moduleHeadings.filter({ hasText: "External changes" })).toHaveCount(0);
  await configuration.getByRole("button", { name: "Reset to default" }).click();
  await expect(configuration.getByRole("button", { name: "Relations" })).toHaveAttribute("aria-pressed", "true");
  await expect(moduleHeadings.first()).toHaveText("Relations");
  await drawer.getByRole("button", { name: "Configure quick drawer" }).click();
  await drawer.getByTestId("drawer-modules-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });

  await page.setViewportSize({ width: 900, height: 600 });
  await drawer.getByTestId("drawer-modules-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    path: path.join(screenshotDirectory, "skill-drawer-900x600.png"),
  });
  const compactFacts = drawer.locator(".sh-skill-drawer__summary-item");
  await expect(compactFacts).toHaveCount(6);
  await expect.poll(() => drawer.evaluate((root) => {
    const overview = root.querySelector<HTMLElement>(".sh-skill-drawer__overview")!;
    const viewport = overview.getBoundingClientRect();
    return Array.from(root.querySelectorAll<HTMLElement>(".sh-skill-drawer__summary-item"))
      .every((item) => item.getBoundingClientRect().bottom <= viewport.bottom);
  })).toBe(true);
  const tagList = drawer.locator(".sh-skill-drawer__tag-list");
  await tagList.evaluate((list) => {
    for (let index = 0; index < 12; index += 1) {
      const tag = document.createElement("li");
      tag.className = "sh-skill-drawer__tag";
      tag.textContent = `workflow-tag-${index + 1}`;
      list.append(tag);
    }
  });

  const modulesScroll = drawer.getByTestId("drawer-modules-scroll");
  await expect.poll(() => modulesScroll.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(140);

  const body = drawer.getByTestId("drawer-modules-scroll");
  await expect.poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await body.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
  await expect.poll(() => drawer.evaluate((root) => {
    const chrome = root.querySelector<HTMLElement>(".sh-skill-drawer__chrome")!;
    const title = root.querySelector<HTMLElement>(".sh-skill-drawer__pinned-title h2")!;
    const chromeBounds = chrome.getBoundingClientRect();
    const titleBounds = title.getBoundingClientRect();
    return titleBounds.top >= chromeBounds.top && titleBounds.bottom <= chromeBounds.bottom;
  })).toBe(true);
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    path: path.join(screenshotDirectory, "skill-drawer-900x600-long-summary.png"),
  });

  await drawer.locator(".sh-skill-drawer__summary-item--projects").evaluate((element) => {
    element.scrollIntoView({ block: "nearest" });
  });
  await expect.poll(() => drawer.evaluate((root) => {
    const body = root.querySelector<HTMLElement>("[data-testid='drawer-modules-scroll']")!;
    const lastFact = root.querySelector<HTMLElement>(".sh-skill-drawer__summary-item--projects")!;
    const bodyBounds = body.getBoundingClientRect();
    const factBounds = lastFact.getBoundingClientRect();
    return factBounds.top >= bodyBounds.top && factBounds.bottom <= bodyBounds.bottom + 1;
  })).toBe(true);
  await expect(drawer.getByRole("button", { name: "Add to…" })).toBeVisible();
  await expect(drawer.getByRole("region", { name: "Risk summary" })).toBeVisible();

  for (const [section, selector] of [
    [drawer.locator(".sh-skill-drawer__actions"), ".sh-skill-drawer__actions"],
    [drawer.getByRole("region", { name: "Risk summary" }), ".sh-skill-drawer__risk"],
  ] as const) {
    await section.scrollIntoViewIfNeeded();
    const contentIsVisible = await drawer.evaluate((root, targetSelector) => {
      const body = root.querySelector<HTMLElement>("[data-testid='drawer-modules-scroll']")!;
      const content = root.querySelector<HTMLElement>(targetSelector)!;
      const bodyBounds = body.getBoundingClientRect();
      const contentBounds = content.getBoundingClientRect();
      return contentBounds.top >= bodyBounds.top && contentBounds.bottom <= bodyBounds.bottom;
    }, selector);
    expect(contentIsVisible, selector).toBe(true);
  }

  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();
  await expect(skillCard).toBeFocused();
});
