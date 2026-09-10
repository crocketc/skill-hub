import { expect, test } from "./fixtures";

test("onboarding exposes an unavailable state when bootstrap is not connected", async ({ page }) => {
  await page.goto("/initialize");
  await expect(page.getByRole("status")).toContainText("Bootstrap status is unavailable");
  await expect(page.getByRole("button", { name: "Create a new library" })).not.toBeAttached();
  await expect(page.getByRole("button", { name: "Use an existing library" })).not.toBeAttached();
  await expect(page.getByRole("button", { name: "Restore from a backup" })).not.toBeAttached();
  await expect(page.getByText("Save and restart")).not.toBeVisible();
});

test("bootstrap-unavailable onboarding does not offer a restart workaround", async ({ page }) => {
  await page.goto("/initialize");
  await expect(page.getByRole("status")).toContainText("Initialization and rediscovery are temporarily unavailable");
  await expect(page.getByText("Save and restart")).not.toBeAttached();
});
