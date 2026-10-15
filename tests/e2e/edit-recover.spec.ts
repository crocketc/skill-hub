import { expect, test } from "./fixtures";

test("recovery navigation remains blocked until the native bootstrap contract is available", async ({ page }) => {
  await page.goto("/recovery");
  await expect(page.getByText("Unable to read data")).toBeVisible();
});

// P1-14：受控"保存并替换原 Skill"主链路——评审保存流先选保存方式、再核对
// 影响预览（当前版本保留在历史中），确认后创建版本；版本时间线回滚保持可用。
test("guarded replace save records a version and the timeline stays recoverable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/skill-detail/skill-pdf#review-content");
  await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();

  await page.getByRole("tab", { name: "Edit" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown source" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nGuarded replace-save probe");

  await page.getByRole("button", { name: "Save…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // 覆盖风险 + 可恢复边界必须出现在保存流里：默认推荐覆盖（旧版本保留），
  // 影响预览如实列出"当前版本保留在历史中"。
  await expect(dialog.getByText("Replace the current Skill and keep the old versions")).toBeVisible();
  await dialog.getByRole("button", { name: "View save impact" }).click();
  await expect(dialog).toContainText("The current version stays in history.");
  await dialog.getByRole("button", { name: "Confirm and create version" }).click();
  // 保存命令成功后：结果反馈出现在编辑器状态条、无保存失败告警；评审流下
  // 编辑器不再按 contentIdentity 重挂载，草稿文本原位保留。
  await expect(page.getByText("Content saved as a new version.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Markdown source" })).toContainText(
    "Guarded replace-save probe",
  );

  // 版本时间线可用，回滚链路完整走通（预览夹具提供确定性版本列表）。
  // 评审布局下回滚入口与确认面板使用当前界面语言的文案。
  const timeline = page.locator(".sh-version-timeline");
  await expect(timeline.getByRole("heading", { name: "v2.4.0" })).toBeVisible();
  await timeline.getByRole("button", { name: "Rollback to v2.4.0" }).click();
  const confirmRollback = timeline.getByRole("button", { name: "Confirm and create rollback version" });
  await expect(confirmRollback).toBeVisible();
  const rollbackPreview = timeline.getByRole("region", { name: "Rollback impact preview" });
  await expect(rollbackPreview).toContainText("Rollback creates a new current version; it does not erase history.");
  await expect(rollbackPreview).toContainText("共享目录 · 受管链接 will update");
  await expect(rollbackPreview).toContainText("文档协作项目 · 受管链接 will update");
  await expect(rollbackPreview).toContainText("Codex 终端 · 独立拷贝 is pinned and will not be affected");
  await confirmRollback.click();
  // 回滚提交成功后确认面板收起、结果反馈出现，且不出现错误告警。
  await expect(confirmRollback).toBeHidden();
  await expect(timeline.getByTestId("review-version-result")).toContainText("A new current version has been created.");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
