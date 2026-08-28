import { expect, test } from "./fixtures";

test("recovery navigation remains blocked until the native bootstrap contract is available", async ({ page }) => {
  await page.goto("/recovery");
  await expect(page.getByText("Unable to read data")).toBeVisible();
});
