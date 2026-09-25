import { expect, test } from "@playwright/test";

/**
 * Task 11 起导入与关系治理分离后的导入治理链路预览验收（DEV-only
 * /__preview/import-wizard?scenario=governance）。
 * 只断言公开角色、可访问名称与确定性事实；全部跑在 mock facade 上。
 * 导入侧：冲突步诚实呈现（含 AI 未配置信号）→ 提交 → 摘要呈现本次导入
 * 的治理待办深链、来源副本整理 CTA 与原件保护事实。
 * 边界：治理页内行为（保留后可查、清理预览完整影响、成功后部署入口）
 * 属于治理页组件测试与真机人工验收范围；E2E 只锁定入口契约——
 * 深链按钮只指向本次导入产生的待办，不把浏览器 fixture 当作真实治理状态。
 */

test.use({ locale: "zh-CN" });

const PREVIEW = "/__preview/import-wizard?scenario=governance";

test("lands the import on a summary with the governance task deep link and organize CTA", async ({
  page,
}) => {
  await page.goto(PREVIEW);
  await page.getByRole("textbox", { name: "来源" }).fill("C:/skills/preview");
  await page
    .getByRole("button", { name: "读取该来源的候选" })
    .click();
  await page
    .getByRole("button", { name: "继续选择候选" })
    .click({ timeout: 10_000 });
  await page.getByRole("checkbox", { name: /PDF Reader/ }).click();
  await page.getByRole("checkbox", { name: /Browser Helper/ }).click();
  await page.getByRole("button", { name: "分析冲突" }).click();

  // 冲突步首屏：结论区先行播报；AI 不可用是真实信号，提示诚实且可继续。
  await expect(
    page.getByRole("status", { name: "本次导入的冲突结论" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText("尚未配置可用的 LLM 供应商，无法运行 AI 预检；可直接继续导入。"),
  ).toBeVisible();

  // 本次导入无强制冲突决策，提交直接可用。
  const commit = page.getByRole("button", { name: "提交导入" });
  await expect(commit).toBeEnabled();
  await commit.click();

  const summary = page.getByRole("region", { name: "导入 Skill" });
  await expect(
    summary.getByText("部分候选项需要关注，下面逐项列出处理结果。"),
  ).toBeVisible({ timeout: 10_000 });
  // 本次导入产生的唯一治理待办（共享目录影响确认）深链；不显示其他来源。
  await expect(
    summary.getByRole("button", { name: "查看治理待办 task:preview-governance" }),
  ).toBeVisible();
  // AgentLocal/UserLocal 导入携带可管理来源副本 → 提供整理 CTA。
  await expect(
    summary.getByRole("button", { name: "整理来源副本" }),
  ).toBeVisible();
  // 原件保护事实：导入不删源，清理必须在关系治理中单独确认。
  await expect(summary.getByText(/原始副本保持不变/)).toBeVisible();
  // 待处理项如实计数，不静默吞掉。
  await expect(summary.getByText(/待处理 1/)).toBeVisible();
});
