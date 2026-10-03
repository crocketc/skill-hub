import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

test.use({ locale: "en-US" });

test("shared directory overflow stays in place and its title resolves a path-shaped target", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 640 });
  await page.goto("/__preview/agents?path-style-target=1");
  const evidenceDirectory = path.resolve(process.cwd(), "apps/desktop/test-results/fb014");
  mkdirSync(evidenceDirectory, { recursive: true });

  const sharedCard = page.getByTestId("agent-card").filter({ has: page.getByText("Agent shared directory", { exact: true }) });
  await expect(sharedCard).toHaveCount(1);
  const overflow = sharedCard.locator(".sh-agent-presentation__shared-brand-overflow");
  const beforeUrl = page.url();
  await page.screenshot({ path: path.join(evidenceDirectory, "shared-directory-collapsed-800x640.png") });

  await overflow.focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(beforeUrl);
  await expect(overflow).toHaveAttribute("aria-expanded", "true");
  const popover = page.getByRole("dialog", { name: "Brands that recognise this shared directory" });
  await expect(popover).toBeVisible();
  for (const brand of ["OpenAI", "Claude", "Cursor", "Gemini", "Kimi", "CodeBuddy", "Trae", "GitHub Copilot"]) {
    await expect(popover.getByText(brand, { exact: true })).toBeVisible();
  }
  const cardHeight = await sharedCard.evaluate((card) => card.getBoundingClientRect().height);
  expect(cardHeight).toBe(176);
  const desktopPopoverBox = await popover.boundingBox();
  expect(desktopPopoverBox).not.toBeNull();
  expect(desktopPopoverBox!.x).toBeGreaterThanOrEqual(0);
  expect(desktopPopoverBox!.y).toBeGreaterThanOrEqual(0);
  expect(desktopPopoverBox!.x + desktopPopoverBox!.width).toBeLessThanOrEqual(800);
  expect(desktopPopoverBox!.y + desktopPopoverBox!.height).toBeLessThanOrEqual(640);
  await page.screenshot({ path: path.join(evidenceDirectory, "shared-directory-expanded-800x640.png") });
  await page.keyboard.press("Tab");
  await expect(popover.getByRole("listitem").first()).toBeFocused();
  await page.getByRole("heading", { name: "Agents", exact: true }).click();
  await expect(popover).toHaveCount(0);
  await expect(overflow).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(overflow).toBeFocused();

  await page.setViewportSize({ width: 400, height: 640 });
  await overflow.focus();
  await page.keyboard.press("Enter");
  await expect(popover).toBeVisible();
  const narrowCardHeight = await sharedCard.evaluate((card) => card.getBoundingClientRect().height);
  expect(narrowCardHeight).toBe(176);
  const narrowPopoverBox = await popover.boundingBox();
  expect(narrowPopoverBox).not.toBeNull();
  expect(narrowPopoverBox!.x).toBeGreaterThanOrEqual(0);
  expect(narrowPopoverBox!.x + narrowPopoverBox!.width).toBeLessThanOrEqual(400);
  await page.screenshot({ path: path.join(evidenceDirectory, "shared-directory-expanded-400x640.png") });
  await page.keyboard.press("Escape");
  await expect(overflow).toBeFocused();

  const title = sharedCard.locator(".sh-agent-presentation__identity-link");
  await title.click();
  await expect(page).toHaveURL("/agents/agent-skills%2Fshared%2Fcatalog%2Froot");
  await expect(page.getByText("Unexpected Application Error")).toHaveCount(0);
  await expect(page.locator(".sh-data-state")).toBeVisible();
});
