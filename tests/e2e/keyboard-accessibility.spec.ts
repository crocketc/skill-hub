import { expect, test } from "./fixtures";

test("keyboard focus and reduced motion remain visible in the preview shell", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/__preview/skill-library");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  await expect(page.getByRole("link", { name: "SkillHub" })).toBeVisible();
});
