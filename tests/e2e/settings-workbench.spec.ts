import { expect, test } from "./fixtures";

test.use({ locale: "en-US" });

async function openSettings(page: import("@playwright/test").Page, query = "") {
  await page.goto(`/__preview/settings-llm${query}`);
  await expect(page.getByRole("heading", { name: "Shape SkillHub around your workflow" })).toBeVisible();
}

test("settings search routes to real controls and keeps section navigation in browser history", async ({ page }) => {
  await openSettings(page, "?section=appUpdate");
  const search = page.getByRole("searchbox", { name: "Search settings" });

  await page.keyboard.press("Control+f");
  await expect(search).toBeFocused();
  await search.fill("information density");
  await page.getByRole("button", { name: "Information density", exact: true }).click();
  await expect(page).toHaveURL(/section=interfaceView#settings-density$/);
  await expect(page.locator("#settings-density")).toBeFocused();

  await page.getByRole("tab", { name: "App update" }).click();
  await expect(page).toHaveURL(/section=appUpdate$/);
  await page.goBack();
  await expect(page).toHaveURL(/section=interfaceView#settings-density$/);
  await expect(page.getByRole("tab", { name: "Interface & view" })).toHaveAttribute("aria-selected", "true");

  await search.fill("no matching setting exists");
  await expect(page.getByRole("status")).toContainText("No settings match that search.");
  await search.clear();
  await expect(page.getByText("No settings match that search.")).toHaveCount(0);
});

test("update preferences stay separate from Skill automation", async ({ page }) => {
  await openSettings(page, "?section=automation");
  await expect(page.getByText(/These three fields only save local preferences/)).toBeVisible();
  await expect(page.getByRole("switch", { name: "Global-scope preference" })).toBeVisible();
  await expect(page.getByText("Global automatic Skill checks and upgrades are not available yet.")).toBeVisible();

  await page.getByRole("tab", { name: "App update" }).click();
  const startup = page.getByRole("switch", { name: "Check at startup" });
  await expect(startup).toBeChecked();
  await startup.click();
  await expect(startup).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Check for SkillHub app updates" })).toBeChecked();
});

test("invalid percent-encoded settings hash does not prevent rendering", async ({ page }) => {
  await openSettings(page, "?section=general#%E0%A4%A");
  await expect(page.getByRole("tabpanel", { name: "General" })).toBeVisible();
  await expect(page.getByLabel("Appearance")).toBeVisible();
});

test("captures wide, short, and dark settings layouts for review", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page, "?section=general");
  await page.screenshot({ path: "test-results/settings-wide-1440x900.png" });

  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/__preview/settings-llm?section=interfaceView");
  await expect(page.getByRole("tabpanel", { name: "Interface & view" })).toBeVisible();
  await page.screenshot({ path: "test-results/settings-short-900x600.png" });

  await page.addInitScript(() => window.localStorage.setItem("skillhub.appearance", "grok-night"));
  await page.goto("/__preview/settings-llm?section=general");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "grok-night");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "test-results/settings-dark-1440x900.png" });
});
