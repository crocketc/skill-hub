import { expect, test } from "./fixtures";

test("onboarding exposes the native-path boundary before enabling initialization", async ({ page }) => {
  await page.goto("/initialize");
  await expect(page.getByRole("heading", { name: "The default library location cannot be confirmed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip initialization" })).toBeDisabled();
});
