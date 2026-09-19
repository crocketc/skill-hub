import { expect, test } from "@playwright/test";

/**
 * Task 5/9 导入关系治理阶段预览验收（DEV-only
 * /__preview/import-wizard?scenario=governance）。
 * 只断言公开角色、可访问名称与确定性事实；全部跑在 mock facade 上。
 * 覆盖：分析后插入治理阶段（5 步流程）、分组确认门槛、单项覆盖、
 * AI 不可用诚实提示、提交后待处理摘要与治理待办入口。
 */

test.use({ locale: "zh-CN" });

const PREVIEW = "/__preview/import-wizard?scenario=governance";

function wizard(page: import("@playwright/test").Page) {
  return page.getByRole("region", { name: "导入 Skill" });
}

test("routes the import through the governance phase before conflicts", async ({
  page,
}) => {
  await page.goto(PREVIEW);
  await page.getByRole("textbox", { name: "来源" }).fill("C:/skills/preview");
  await page.getByRole("button", { name: "读取该来源的候选" }).click();
  await page
    .getByRole("button", { name: "继续选择候选" })
    .click({ timeout: 10_000 });
  await page.getByRole("checkbox", { name: /PDF Reader/ }).click();
  await page.getByRole("checkbox", { name: /Browser Helper/ }).click();
  await page.getByRole("button", { name: "分析冲突" }).click();

  // 治理阶段出现在分析与冲突之间；步骤条为 5 步且当前步骤是治理。
  const heading = page.getByRole("heading", { name: "确认导入后的关系处理" });
  await expect(heading).toBeVisible({ timeout: 10_000 });
  const rail = page.getByRole("list", { name: "导入步骤" });
  await expect(rail.getByRole("listitem")).toHaveCount(5);
  await expect(rail.getByText("关系治理")).toBeVisible();

  // AI 不可用是真实信号（预览环境无已配置供应商），提示诚实且不伪造入口。
  await expect(
    page.getByText("AI 建议未配置；已保留确定性关系判断。"),
  ).toBeVisible();

  // 分组按类别聚合：通用目录直接读取 + 同名不同内容，各自带影响与回退说明。
  await expect(page.getByText("通用目录直接读取")).toBeVisible();
  await expect(page.getByText("同名不同内容")).toBeVisible();
  await expect(
    page.getByText("1 个 Skill 将导入集中库。受影响 Agent：Trae。"),
  ).toBeVisible();
  await expect(
    page.getByText("回退方式：共享目录原件不会被本操作修改。"),
  ).toBeVisible();

  // 确认门槛：未显式选择任何分组动作时主按钮保持禁用。
  const confirm = page.getByRole("button", { name: "确认关系处理" });
  await expect(confirm).toBeDisabled();

  // 展开成员并做单项覆盖（单项优先于分组动作）。
  await page.getByRole("button", { name: "展开 1 个项目" }).first().click();
  await page
    .getByRole("radio", { name: "PDF Reader：先不导入，记为待办" })
    .first()
    .click();
  await page
    .getByRole("radio", { name: "先不导入，记为待办" })
    .last()
    .click();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // 治理确认后进入既有冲突阶段（该场景无需强制决策，可直接提交）。
  await page.getByRole("button", { name: "提交导入" }).click();

  const summary = page.getByRole("region", { name: "导入 Skill" });
  await expect(
    summary.getByText("导入完成，有待处理事项").or(summary.getByText("导入已完成")),
  ).toBeVisible({ timeout: 10_000 });
  await expect(summary.getByText(/待处理 1/)).toBeVisible();
  await expect(
    summary.getByRole("button", { name: /查看治理待办 task:preview-governance/ }),
  ).toBeVisible();
  // 原文件保护：导入不删源，摘要明示原始副本保持不变。
  await expect(
    summary.getByText(/原始副本保持不变/),
  ).toBeVisible();
});
