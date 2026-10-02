import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

test("pending review prepares the existing batch workspace without running it", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/__preview/skill-library");
  await page.evaluate(() => {
    history.replaceState({ ...history.state, usr: { pendingReview: {
      skillIds: ["skill-docx", "skill-docx"], intent: "security_check", returnTo: "/pending?kind=basic_check",
    } } }, "");
  });
  await page.reload();
  const batch = page.getByRole("complementary", { name: "Batch actions" });
  await expect(batch).toBeVisible();
  await expect(batch).toBeFocused();
  await expect(page.getByRole("checkbox", { name: "Select DOCX Writer" })).toBeChecked();
  await expect(page.getByRole("link", { name: "Return to pending items" })).toHaveAttribute("href", "/pending?kind=basic_check");
  await expect(page.getByRole("button", { name: "Run security check" })).toBeVisible();
  await expect(page.getByText("Security check completed")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const screenshot = path.resolve("test-results/ui/pending/pending-library-handoff-900x600.png");
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot });
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(batch).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Return to pending items" })).toBeVisible();
});
