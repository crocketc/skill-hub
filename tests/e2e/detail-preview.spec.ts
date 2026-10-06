import { expect, test } from "./fixtures";

test("skill detail exposes Markdown read, source, and edit modes", async ({ page }) => {
  // 转正后旧 #description 锚点移除，深链改用「内容与文件」分区锚点。
  await page.goto("/__preview/skill-detail/skill-pdf#review-content");

  await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Extract PDF tables safely" })).toBeVisible();

  await page.getByRole("tab", { name: "Source" }).click();
  await expect(page.locator("pre")).toContainText("name: pdf-reader");

  await page.getByRole("tab", { name: "Edit" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown source" })).toBeVisible();
  // 评审保存流（reviewSaveFlow）：保存入口改为「保存…」对话框流程，
  // 完整的保存→版本→时间线链路由 edit-recover 用例覆盖。
  await expect(page.getByRole("button", { name: "保存…" })).toBeVisible();
});
