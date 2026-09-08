import { expect, test } from "./fixtures";

test("skill detail exposes Markdown read, source, and edit modes", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf#description");

  await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Extract PDF tables safely" })).toBeVisible();

  await page.getByRole("tab", { name: "Source" }).click();
  await expect(page.locator("pre")).toContainText("name: pdf-reader");

  await page.getByRole("tab", { name: "Edit" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown source" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and create version" })).toBeVisible();
});
