import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

const screenshotDirectory = path.resolve(process.cwd(), "test-results/ui/skill-drawer");

test("quick drawer keeps its lifecycle summary, actions, and module controls usable", async ({ page }) => {
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/skill-library");
  const skillCard = page.getByRole("heading", { name: "PDF Reader" }).locator("xpath=../..");
  await skillCard.getByRole("heading", { name: "PDF Reader" }).click();

  const drawer = page.getByTestId("skill-quick-drawer");
  const panel = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".sh-skill-drawer__summary-item--lifecycle")).toContainText("Active");
  await expect(drawer.locator(".sh-skill-drawer__summary-item--version")).toContainText("1.4.0");
  await expect(drawer.locator(".sh-skill-drawer__summary-item--agents")).toBeVisible();
  await expect(drawer.locator(".sh-skill-drawer__summary-item--projects")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Add to…" })).toBeVisible();
  await expect(drawer.getByRole("region", { name: "Primary actions" }).getByRole("link", { name: "Open security checks" })).toBeVisible();
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

  const overview = drawer.locator(".sh-skill-drawer__overview");
  await expect.poll(() => overview.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await overview.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => overview.evaluate((element) => element.scrollTop)).toBe(0);
  await expect.poll(() => drawer.evaluate((root) => {
    const overview = root.querySelector<HTMLElement>(".sh-skill-drawer__overview")!;
    const title = root.querySelector<HTMLElement>(".sh-skill-drawer__identity-title h2")!;
    const overviewBounds = overview.getBoundingClientRect();
    const titleBounds = title.getBoundingClientRect();
    return titleBounds.top >= overviewBounds.top && titleBounds.bottom <= overviewBounds.bottom;
  })).toBe(true);
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    path: path.join(screenshotDirectory, "skill-drawer-900x600-long-summary.png"),
  });

  await overview.evaluate((element) => {
    element.querySelector<HTMLElement>(".sh-skill-drawer__summary-item--projects")
      ?.scrollIntoView({ block: "nearest" });
  });
  await expect.poll(() => drawer.evaluate((root) => {
    const overview = root.querySelector<HTMLElement>(".sh-skill-drawer__overview")!;
    const lastFact = root.querySelector<HTMLElement>(".sh-skill-drawer__summary-item--projects")!;
    const overviewBounds = overview.getBoundingClientRect();
    const factBounds = lastFact.getBoundingClientRect();
    return factBounds.top >= overviewBounds.top && factBounds.bottom <= overviewBounds.bottom + 1;
  })).toBe(true);
  await expect(drawer.getByRole("button", { name: "Add to…" })).toBeVisible();
  await expect(drawer.getByRole("region", { name: "Risk summary" })).toBeVisible();

  const panelBounds = await panel.boundingBox();
  const actionsBounds = await drawer.locator(".sh-skill-drawer__actions").boundingBox();
  const riskBounds = await drawer.getByRole("region", { name: "Risk summary" }).boundingBox();
  expect(panelBounds).not.toBeNull();
  expect(actionsBounds).not.toBeNull();
  expect(riskBounds).not.toBeNull();
  expect(actionsBounds!.y + actionsBounds!.height).toBeLessThanOrEqual(panelBounds!.y + panelBounds!.height);
  expect(riskBounds!.y + riskBounds!.height).toBeLessThanOrEqual(panelBounds!.y + panelBounds!.height);

  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();
  await expect(skillCard).toBeFocused();
});
