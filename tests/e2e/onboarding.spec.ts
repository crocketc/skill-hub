import { expect, test } from "./fixtures";

test("onboarding exposes the native-path boundary before enabling initialization", async ({ page }) => {
  await page.goto("/initialize");
  await page.getByRole("button", { name: "Create a new library" }).click();
  await expect(page.getByRole("heading", { name: "The default library location cannot be confirmed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip initialization" })).toBeDisabled();
  await expect(page.getByText("Save and restart")).not.toBeVisible();
});

test("first-run onboarding does not offer a restart workaround", async ({ page }) => {
  await page.goto("/initialize");
  await expect(page.getByRole("heading", { name: "Choose how to initialize" })).toBeVisible();
  await expect(page.getByText("Save and restart")).not.toBeAttached();
});
