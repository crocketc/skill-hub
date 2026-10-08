import { expect, test } from "@playwright/test";

/**
 * Task 7/9 关系视图预览验收（DEV-only /__preview/agents/detail 与
 * /__preview/skill-detail/:id）。只断言公开角色、可访问名称与确定性
 * 事实；识别状态绝不表述为"已加载/一定会调用"。
 */

test.use({ locale: "zh-CN" });

test("agent detail shows the directory matrix with recognition and relation facts", async ({
  page,
}) => {
  await page.goto("/__preview/agents/detail");

  const matrix = page.getByRole("region", {
    name: /目录与关系/,
  });
  await expect(matrix).toBeVisible();
  // 免责声明以否定式如实说明：目录识别不代表已加载/一定会调用。
  await expect(
    page.getByText("目录识别不代表该 Agent 已加载或一定会调用这些 Skill"),
  ).toBeVisible();

  // 共享目录卡片：角色、识别状态、Skill 数、共享消费者。
  const cards = page.getByTestId("directory-card");
  await expect(cards).toHaveCount(2);
  const shared = cards.first();
  await expect(shared.getByText("/Users/preview/.agents/skills")).toBeVisible();
  await expect(shared.getByText("通用共享目录")).toBeVisible();
  await expect(shared.getByText("已确认支持")).toBeVisible();
  // 共享消费者按「品牌厂商 + 展示类型」呈现（Agent 呈现约定），
  // 裸 client_id 不进入界面。
  await expect(shared.getByText("共享消费者：")).toBeVisible();
  await expect(shared.getByLabel("Trae · 终端").first()).toBeVisible();
  await expect(shared.getByText("trae.code")).toHaveCount(0);

  // 关系行按用户语义命名；其他 Agent 的复制部署显式标注归属。
  await expect(shared.getByText("共享目录直接读取")).toBeVisible();
  await expect(shared.getByText("复制部署")).toBeVisible();
  await expect(shared.getByText("归属 Agent：")).toBeVisible();
  // 技术形态只在技术详情内出现。
  await expect(shared.getByText(/符号链接/)).toHaveCount(0);

  // 移除影响入口按关系提供；打开后先展示最小影响动作与其他消费者。
  await shared
    .getByRole("listitem")
    .filter({ hasText: "skill-pdf" })
    .getByRole("button", { name: "查看移除影响" })
    .click();
  await expect(page.getByText("移除影响预览")).toBeVisible();
  await expect(page.getByText("最小影响动作")).toBeVisible();
  // 其他消费者按品牌 + 展示类型呈现，裸 client_id 不进界面。
  await expect(page.getByText("其他识别该目录的 Agent：")).toBeVisible();
  await expect(page.getByLabel("Trae · 终端").first()).toBeVisible();
  await expect(page.getByText("trae.code")).toHaveCount(0);
});

test("skill detail surfaces governed usage and removal impact", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf");

  // 转正后使用去向区以卡片呈现每个使用位置的状态事实（待集中管理/已集中管理）。
  // 真实流接线轮（ed0cdf39/治理卡收口）：去向卡详情改为行动导向措辞，
  // 待接管给出治理入口指引，已接管说明跟随与共享目录计数口径。
  const usage = page.locator("#review-usage-body");
  await expect(usage.getByText("原位置仍是独立副本；可在关系治理中纳入集中管理。")).toBeVisible();
  await expect(
    usage.getByText("受管链接跟随技能库当前版本。共享目录只计一个物理去向。"),
  ).toBeVisible();

  // 真实删除流（47bf9085）：工具栏「删除」打开真实删除对话框——先展示影响
  // 预览（逐目标处置选择 + 依赖项目 + 保留/恢复说明），全部目标都有处置才
  // 允许确认；预览门面提供确定性影响夹具，不在预览里执行真实删除。
  await page.getByRole("button", { name: "删除", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("从库中删除 PDF Reader 吗？");
  await expect(dialog).toContainText("将从技能库删除该 Skill 的记录、内容与版本历史；每个目标中的拷贝按下方选择处理。");
  await expect(dialog).toContainText("Codex CLI");
  await expect(dialog).toContainText("Claude Code");
  await expect(dialog).toContainText("依赖项目");
  await expect(dialog).toContainText("Demo Project");
  await expect(
    dialog.getByText("恢复：从库中删除无法在应用内撤销；建议先在「设置 → 数据保护」导出备份。"),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认从库中删除" })).toBeDisabled();
  await dialog.getByLabel(/目标副本处理方式/).first().selectOption({ label: "保留目标处的文件，解除部署关系（库中记录一并删除）" });
  await dialog.getByLabel(/目标副本处理方式/).last().selectOption({ label: "删除目标目录中的副本（从目标移除）" });
  await expect(dialog.getByRole("button", { name: "确认从库中删除" })).toBeEnabled();
});
