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

test("skill detail surfaces provenance sources, governed relations and removal impact", async ({
  page,
}) => {
  await page.goto("/__preview/skill-detail/skill-pdf");

  // 多来源/关系事实区：复制部署关系行与治理待办可追踪。
  await expect(page.getByText("复制部署").first()).toBeVisible();
  await expect(page.getByText(/convert_copy_to_managed_link|复制副本转管理链接/).first()).toBeVisible();

  // 移除影响入口：打开后展示备份位置与最小影响动作，不假装成功。
  const impact = page.getByRole("button", { name: /查看移除影响|移除影响/ }).first();
  await impact.click();
  await expect(page.getByText("移除影响预览")).toBeVisible();
  await expect(page.getByText(/可回退；备份位置/)).toBeVisible();
});
