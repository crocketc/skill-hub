import { expect, test } from "./fixtures";

test("recovery navigation remains blocked until the native bootstrap contract is available", async ({ page }) => {
  await page.goto("/recovery");
  await expect(page.getByText("Unable to read data")).toBeVisible();
});

// P1-14：受控"保存并替换原 Skill"主链路——替换保存经确认面板（推荐副本、
// 风险与可恢复说明）创建版本，详情页版本时间线的回滚链路保持可用。
test("guarded replace save records a version and the timeline stays recoverable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/skill-detail/skill-pdf#description");
  await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();

  await page.getByRole("tab", { name: "Edit" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown source" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nGuarded replace-save probe");

  await page.getByRole("button", { name: "Save and create version" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  // 覆盖风险 + 可恢复边界必须出现在确认面板里。
  await expect(dialog).toContainText("history version");
  await expect(dialog.getByRole("button", { name: "Save as copy (recommended)" })).toBeVisible();

  await dialog.getByRole("button", { name: "Replace and save" }).click();
  // 保存命令成功后：确认面板关闭、无保存失败告警；工作区按新 contentIdentity
  // 重新挂载编辑器（版本已生成的即时反馈在组件层测试中覆盖，重挂载后即清空）。
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Markdown source" })).toContainText(
    "Guarded replace-save probe",
  );

  // 版本时间线可用，回滚链路完整走通（预览夹具提供确定性版本列表）。
  const timeline = page.locator(".sh-version-timeline");
  await expect(timeline.getByRole("heading", { name: "v2.4.0" })).toBeVisible();
  await timeline.getByRole("button", { name: "Rollback to v2.4.0" }).click();
  const confirmRollback = timeline.getByRole("button", {
    name: "Confirm and create rollback version",
  });
  await expect(confirmRollback).toBeVisible();
  await expect(timeline.getByText("Rollback impact preview")).toBeVisible();
  await confirmRollback.click();
  // 回滚提交成功后确认面板收起，且不出现错误告警。
  await expect(confirmRollback).toBeHidden();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
