import { expect, test } from "./fixtures";

test("batch add and remove from combinations use the selection dialog and show per-Skill results", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("/__preview/skill-library?batchCollections=1");

  await page.getByRole("checkbox", { name: "Select PDF Reader" }).check();
  await page.getByRole("checkbox", { name: "Select DOCX Writer" }).check();
  const batchBar = page.getByRole("complementary", { name: "Batch actions" });
  await expect(batchBar.getByRole("button", { name: "Batch add to combinations" })).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Batch remove from combinations" })).toBeVisible();

  await batchBar.getByRole("button", { name: "Batch add to combinations" }).click();
  const addDialog = page.getByRole("dialog", { name: "Batch add to combinations" });
  await expect(addDialog).toContainText("2 selected Skills");
  await addDialog.getByRole("checkbox", { name: "Document toolkit" }).check();
  const addBounds = await addDialog.boundingBox();
  expect(addBounds).not.toBeNull();
  expect(addBounds!.x).toBeGreaterThanOrEqual(0);
  expect(addBounds!.x + addBounds!.width).toBeLessThanOrEqual(900);
  await addDialog.getByRole("button", { name: "Batch add to combinations" }).click();
  await expect(addDialog).toHaveCount(0);
  const addResult = page.getByTestId("batch-summary").last();
  await expect(addResult).toContainText("1 succeeded");
  await expect(addResult).toContainText("1 skipped");

  await batchBar.getByRole("button", { name: "Batch remove from combinations" }).click();
  const removeDialog = page.getByRole("dialog", { name: "Batch remove from combinations" });
  await removeDialog.getByRole("checkbox", { name: "Document toolkit" }).check();
  await expect(removeDialog).toContainText("does not delete Skills");
  await removeDialog.getByRole("button", { name: "Batch remove from combinations" }).click();
  await expect(removeDialog).toHaveCount(0);
  const removeResult = page.getByTestId("batch-summary").first();
  await expect(removeResult).toContainText("2 succeeded");
});

test("batch basic and AI checks run independently and report the selected Skill", async ({ page }) => {
  await page.goto("/__preview/skill-library");
  await page.getByRole("checkbox", { name: "Select PDF Reader" }).check();
  const batchBar = page.getByRole("complementary", { name: "Batch actions" });

  const basicCheck = batchBar.getByRole("button", { name: "Batch run basic check" });
  await expect(basicCheck).toBeVisible();
  await basicCheck.click();
  const basicResult = page.getByTestId("batch-security-check-summary").last();
  await expect(basicResult).toContainText("Batch basic check results");
  await expect(basicResult).toContainText("1 succeeded");
  await expect(basicResult).toContainText("PDF Reader");

  const aiCheck = batchBar.getByRole("button", { name: "Batch run AI check" });
  await expect(aiCheck).toBeVisible();
  await aiCheck.click();
  const aiResult = page.getByTestId("batch-security-check-summary").first();
  await expect(aiResult).toContainText("Batch AI check results");
  await expect(aiResult).toContainText("1 succeeded");
  await expect(aiResult).toContainText("PDF Reader");
});

test("batch source checks preserve the selected scope and report Skills without update sources", async ({ page }) => {
  await page.goto("/__preview/skill-library?batchUpdates=1");
  await page.getByRole("checkbox", { name: "Select PDF Reader" }).check();
  await page.getByRole("checkbox", { name: "Select DOCX Writer" }).check();

  const batchBar = page.getByRole("complementary", { name: "Batch actions" });
  await batchBar.getByRole("button", { name: "Batch check for updates" }).click();

  const result = page.getByTestId("source-update-checks");
  await expect(result).toContainText("2 selected; 1 have update sources, 1 have none.");
  await expect(result.getByRole("group", { name: "Upgradable (1)" })).toContainText("PDF Reader");
  await expect(result.getByRole("group", { name: "No upstream source (1)" })).toContainText("DOCX Writer");
});
