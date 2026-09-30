import { expect, test } from "./fixtures";
test.use({ locale: "zh-CN" });

test("compatibility feedback distinguishes creation from Agent loading and closes verified work", async ({ page }) => {
  await page.goto("/__preview/pending?compatibility=1");
  await expect(page.getByText("Agent 版本", { exact: true })).toBeVisible();
  const save = page.getByRole("button", { name: "保存本机验证结果" });
  await expect(save).toBeDisabled();
  await page.getByLabel("Agent 版本").fill("0.159.2");
  await page.getByLabel("验证步骤与结果说明").fill("目录联接创建成功；Agent 发现并加载了测试 Skill；已清理测试入口。");
  await page.getByLabel("验证结果").selectOption("supported");
  await expect(save).toBeDisabled();
  await page.getByRole("checkbox", { name: /已在 Agent 中检查/ }).check();
  await expect(save).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("compatibility-feedback.png"), fullPage: true });
  await save.click();
  await expect(page.getByLabel("Agent 版本")).toHaveCount(0);
});

test("unverified results remain pending and write failures preserve feedback", async ({ page }) => {
  await page.goto("/__preview/pending?compatibility=1&actionError=1");
  await page.getByLabel("Agent 版本").fill("test-1");
  await page.getByLabel("验证步骤与结果说明").fill("尚未确认 Agent 加载结果。");
  await page.getByRole("button", { name: "保存本机验证结果" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("验证步骤与结果说明")).toHaveValue("尚未确认 Agent 加载结果。");
  await page.goto("/__preview/pending?compatibility=1");
  await page.getByLabel("Agent 版本").fill("test-1");
  await page.getByLabel("验证步骤与结果说明").fill("创建失败，不能判断 Agent 是否兼容。");
  await page.getByRole("button", { name: "保存本机验证结果" }).click();
  await expect(page.getByLabel("Agent 版本")).toBeVisible();
});
