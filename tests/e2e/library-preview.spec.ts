import { expect, test } from "./fixtures";

test("skill library search narrows results and recovers from an empty filter", async ({ page }) => {
  await page.goto("/__preview/skill-library");

  const search = page.getByRole("searchbox", { name: "Search skills" });
  await search.fill("PDF");
  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /DOCX Writer/ })).not.toBeVisible();

  await search.fill("does-not-exist");
  await expect(page.getByText("No skills match the current filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();
});

test("skill library switches to tagged card view", async ({ page }) => {
  await page.goto("/__preview/skill-library");

  await page.getByRole("combobox", { name: "View mode" }).selectOption("cards");
  await expect(page.getByTestId("skill-cards")).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF Reader" })).toBeVisible();

  await page.getByRole("combobox", { name: "Group by" }).selectOption("tags");
  await expect(page.getByRole("heading", { name: "documents" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "pdf" })).toBeVisible();
});

test("selected skills expose separated batch actions", async ({ page }) => {
  await page.goto("/__preview/skill-library");

  await page.getByRole("checkbox", { name: "Select PDF Reader" }).check();
  const batchBar = page.getByRole("complementary", { name: "Batch actions" });
  await expect(batchBar).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Start export" })).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Run security check" })).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Delete selected Skills" })).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Export", exact: true })).not.toBeVisible();
});

test("quick drawer opens full detail and the version section", async ({ page }) => {
  await page.goto("/__preview/skill-library");

  await page.getByRole("row", { name: /PDF Reader/ }).click();
  await expect(page.getByRole("dialog", { name: "PDF Reader" })).toBeVisible();
  await page.getByRole("link", { name: "View and edit full details" }).click();

  await expect(page).toHaveURL(/\/__preview\/skill-detail\/skill-pdf/);
  await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
  await page.getByRole("link", { name: "Version history" }).click();
  await expect(page).toHaveURL(/#versions$/);
  await expect(page.getByRole("button", { name: /Export this skill/ })).toBeVisible();
});
