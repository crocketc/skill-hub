import { expect, test } from "@playwright/test";

/**
 * W2-2 / W3-1 安全链路预览验收（DEV-only 预览路由，全部走 mock 门面）。
 * 覆盖：
 * 1. 批内冲突链路（?scenario=batch-conflicts）：同内容建议保留/跳过、
 *    同名独立命名（含即时重名反馈）、未处置提交在 UI 层被拦。
 * 2. 危险级候选决策链路（?scenario=security-danger）：置顶决策区块 →
 *    仍然导入 → 完成导入。
 * 3. 待办预警三选链路（/__preview/pending）：完全信任确认留痕后条目经
 *    真实重读消失；不信任跳转既有删除流；稍后处理只有静态说明。
 * 4. 派发安全拦截引导（?scenario=security-alert-blocked）：结构化错误码
 *    升级为可读文案，并给出安全页/待办导航。
 */

const IMPORT_PREVIEW = "/__preview/import-wizard";

test.use({ locale: "zh-CN" });

async function reachConflictStep(page: import("@playwright/test").Page, scenario: string, source: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${IMPORT_PREVIEW}?scenario=${scenario}`);
  await page.getByRole("textbox", { name: "来源" }).fill(source);
  await page.getByRole("button", { name: "读取该来源的候选" }).click();
  await page.getByRole("button", { name: "全选可导入候选" }).click();
  await page.getByRole("button", { name: "分析冲突" }).click();
  // 第 24 节：分析后先落在安全检测步；带冲突处置步的场景再显式继续。
  await expect(page.getByRole("status", { name: "安全检测结论" })).toBeVisible();
  const proceed = page.getByRole("button", { name: "继续处置冲突" });
  if (await proceed.isVisible()) {
    await proceed.click();
  }
  await expect(page.getByRole("button", { name: "提交导入" })).toBeVisible();
}

test("batch conflicts: suggests keep/skip for identical content and blocks unhandled same-name commit", async ({ page }) => {
  await reachConflictStep(page, "batch-conflicts", "C:/skills/batch-preview");

  // 批内同内容组：建议保留一项复制、其余跳过，且建议即默认勾选状态。
  const sameContent = page.getByRole("region", { name: "批内重复：内容与来源相同" });
  await expect(sameContent).toBeVisible();
  await expect(sameContent.locator("li")).toHaveCount(2);
  const keepRow = sameContent.locator("li").filter({ hasText: "建议保留" });
  const skipRow = sameContent.locator("li").filter({ hasText: "建议跳过" });
  await expect(keepRow.getByRole("radio", { name: "复制到 SkillHub" })).toBeChecked();
  await expect(skipRow.getByRole("radio", { name: "跳过此候选项" })).toBeChecked();

  // 批内同名组：没有静默默认，必须逐项处置。
  const sameName = page.getByRole("region", { name: "批内同名：内容不同" });
  await expect(sameName).toBeVisible();
  await expect(sameName.locator("li")).toHaveCount(2);
  for (const radio of await sameName.getByRole("radio").all()) {
    await expect(radio).not.toBeChecked();
  }

  // 未处置提交被拦：提交禁用 + 页面警示逐项指路。
  const commit = page.getByRole("button", { name: "提交导入" });
  await expect(commit).toBeDisabled();
  const pendingAlert = page.getByRole("alert").filter({ hasText: "还有 2 个同名不同内容的候选项未处置" });
  await expect(pendingAlert).toBeVisible();

  // 独立命名：先留空与撞名都被即时拦截，换有效新名后解除。
  const codexRow = sameName.locator("li").filter({ hasText: "codex/alpha" });
  await codexRow.getByRole("radio", { name: "独立导入" }).check();
  await expect(commit).toBeDisabled();
  await codexRow.getByLabel("新名称").fill("alpha");
  await expect(codexRow.getByText("该名称与批内其他候选重名，请换一个。")).toBeVisible();
  await codexRow.getByLabel("新名称").fill("Alpha Codex");
  await expect(codexRow.getByText(/重名，请换一个/)).toHaveCount(0);

  // 第二个同名成员选择跳过后，处置齐备，提交解锁并完成。
  const claudeRow = sameName.locator("li").filter({ hasText: "claude/alpha" });
  await claudeRow.getByRole("radio", { name: "跳过此候选项" }).check();
  await expect(pendingAlert).toHaveCount(0);
  await expect(commit).toBeEnabled();
  await commit.click();
  await expect(page.getByRole("button", { name: "打开 Skill 库" })).toBeVisible();
});

test("security danger: pinned decision block gates commit until every candidate is decided", async ({ page }) => {
  await reachConflictStep(page, "security-danger", "C:/skills/security-preview");

  // 置顶决策区块：完整发现明细 + 仍要导入/不导入二选，没有静默默认。
  const danger = page.getByRole("region", { name: "危险级安全风险（需要逐个决策）" });
  await expect(danger).toBeVisible();
  const riskyRow = danger.locator("li").filter({ hasText: "Risky Deploy" });
  await expect(riskyRow.getByText("包含破坏性命令（如强制删除、格式化）")).toBeVisible();
  await expect(riskyRow.getByText("尝试提升权限执行命令")).toBeVisible();
  await expect(riskyRow.getByText("scripts/deploy.sh:12")).toBeVisible();
  await expect(riskyRow.getByRole("radio", { name: "仍然导入（导入后需处理预警才能派发）" })).not.toBeChecked();
  await expect(riskyRow.getByRole("radio", { name: "不导入" })).not.toBeChecked();

  // 警告级只聚合提示，正常导入并进入预警状态。
  const warning = page.getByRole("region", { name: "警告级安全提示" });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("以下 1 个技能存在警告级提示，将正常导入并进入预警状态（处理前不可派发）。");
  await expect(warning).toContainText("Suspicious Fetch");

  // 未决策提交被拦；逐个决策后解除。
  const commit = page.getByRole("button", { name: "提交导入" });
  await expect(commit).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: "还有 1 个危险级技能未做安全决策" })).toBeVisible();

  await riskyRow.getByRole("radio", { name: "仍然导入（导入后需处理预警才能派发）" }).check();
  await expect(commit).toBeEnabled();
  await commit.click();
  await expect(page.getByRole("button", { name: "打开 Skill 库" })).toBeVisible();
  // 仍要导入的候选按导入落账；摘要只陈述结果，不夸大为无风险。
  await expect(page.getByText("所有选中的候选项都已完成处理。")).toBeVisible();
});

test("pending security alert: trust requires confirmation and removes the item via a real re-read", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/pending");

  await page.getByRole("button", { name: "查看事项明细: 安全与基础检查" }).click();
  // 高风险条目不重复渲染对象名（组摘要已给出），行定位用操作组的可访问名。
  const row = page.locator("li.sh-pending-item").filter({
    has: page.getByRole("group", { name: "处理 flagged-skill 的建议操作" }),
  });
  await expect(row).toBeVisible();

  // 三选形态：完全信任 + 不信任（删除） + 稍后处理静态说明；无顺延/忽略。
  await expect(row.getByRole("button", { name: "完全信任" })).toBeVisible();
  await expect(row.getByRole("link", { name: "不信任（删除）" })).toHaveAttribute("href", "/library/flagged-skill");
  await expect(row.getByText("稍后处理将保留待办并持续不可派发。")).toBeVisible();
  await expect(row.getByRole("button", { name: "暂缓" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "忽略" })).toHaveCount(0);

  // 完全信任必须经过明确确认；确认文案交代留痕与版本绑定语义。
  await row.getByRole("button", { name: "完全信任" }).click();
  const dialog = page.getByRole("alertdialog", { name: "完全信任该技能的安全状态？" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("信任后可正常派发；此决定会记录留痕并绑定当前内容版本");
  await expect(dialog).toContainText("内容更新后再次发现风险将重新预警");

  // 确认后走真实重读：条目从重读后的列表消失，而不是前端假删除。
  await dialog.getByRole("button", { name: "确认信任" }).click();
  await expect(page.locator("li.sh-pending-item").filter({
    has: page.getByRole("group", { name: "处理 flagged-skill 的建议操作" }),
  })).toHaveCount(0);
});

test("dispatch blocked by security alert: readable copy with security-page and pending navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/deployment?scenario=security-alert-blocked");

  await page.getByLabel("Preview Agent 1").check();
  await page.getByRole("button", { name: "预览" }).click();

  // 结构化错误码升级为可读文案，同时给出两个处理入口。
  const blocked = page.getByRole("alert").filter({ hasText: "该技能存在待处理的安全预警，处理前不可派发" });
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText("可在详情安全页或待办中处理");
  const securityLink = page.getByRole("link", { name: "前往安全页处理" });
  const pendingLink = page.getByRole("link", { name: "打开待办" });
  await expect(securityLink).toHaveAttribute("href", "/library/preview-skill/security");
  await expect(pendingLink).toHaveAttribute("href", "/pending");

  // 导航真实可达：待办路由按普通 SPA 跳转，不落坏路由。
  await pendingLink.click();
  await expect(page).toHaveURL(/\/pending$/);
});
