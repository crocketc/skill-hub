import { expect, test } from "./fixtures";
test.use({ locale: "zh-CN" });

async function openCompatibilityTask(page: import("@playwright/test").Page, actionError = false) {
  await page.goto(`/__preview/pending?compatibility=1${actionError ? "&actionError=1" : ""}`);
  await page.getByRole("button", { name: /查看事项明细/ }).click();
  const openTask = page
    .getByRole("group", { name: "处理 Codex Desktop 的建议操作" })
    .getByRole("link", { name: "去处理" });
  await expect(openTask).toHaveAttribute(
    "href",
    `/__preview/agents/detail?compatibility=1${actionError ? "&actionError=1" : ""}`,
  );
  await openTask.click();
  await expect(page).toHaveURL(/\/__preview\/agents\/detail\?compatibility=1/);
  const mode = page.locator("details").filter({ hasText: "Windows 目录联接" });
  await mode.locator("summary").click();
  return mode;
}

test("compatibility feedback distinguishes creation from Agent loading and closes verified work", async ({ page }) => {
  const mode = await openCompatibilityTask(page);
  await expect(mode.getByText("Agent 版本", { exact: true })).toBeVisible();
  const save = mode.getByRole("button", { name: "保存本机验证结果" });
  await expect(save).toBeDisabled();
  await mode.getByLabel("Agent 版本").fill("0.159.2");
  await mode.getByLabel("验证步骤与结果说明").fill("目录联接创建成功；Agent 发现并加载了测试 Skill；已清理测试入口。");
  await mode.getByLabel("验证结果").selectOption("supported");
  await expect(save).toBeDisabled();
  await mode.getByRole("checkbox", { name: /已在 Agent 中检查/ }).check();
  await expect(save).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("compatibility-feedback.png"), fullPage: true });
  await save.click();
  await expect(mode.getByRole("status")).toContainText("本机验证结果已保存");
  await page.goto("/__preview/pending?compatibility=1");
  await expect(page.getByRole("link", { name: "去处理" })).toHaveCount(0);
});

test("unverified results remain pending and write failures preserve feedback", async ({ page }) => {
  const failedMode = await openCompatibilityTask(page, true);
  await failedMode.getByLabel("Agent 版本").fill("test-1");
  await failedMode.getByLabel("验证步骤与结果说明").fill("尚未确认 Agent 加载结果。");
  await failedMode.getByLabel("验证结果").selectOption("supported");
  await failedMode.getByRole("checkbox", { name: /已在 Agent 中检查/ }).check();
  await failedMode.getByRole("button", { name: "保存本机验证结果" }).click();
  await expect(failedMode.getByRole("alert")).toBeVisible();
  await expect(failedMode.getByLabel("Agent 版本")).toHaveValue("test-1");
  await expect(failedMode.getByLabel("验证步骤与结果说明")).toHaveValue("尚未确认 Agent 加载结果。");

  const unverifiedMode = await openCompatibilityTask(page);
  await unverifiedMode.getByLabel("Agent 版本").fill("test-1");
  await unverifiedMode.getByLabel("验证步骤与结果说明").fill("创建失败，不能判断 Agent 是否兼容。");
  await unverifiedMode.getByRole("button", { name: "保存本机验证结果" }).click();
  await expect(unverifiedMode.getByRole("status")).toContainText("尚未确定的事项继续保留在待处理");
  await page.goto("/__preview/pending?compatibility=1");
  await expect(page.getByRole("link", { name: "去处理" })).toBeVisible();
});
