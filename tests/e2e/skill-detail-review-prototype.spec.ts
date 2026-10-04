import { expect, test } from "./fixtures";

const reviewUrl = "/__preview/skill-detail/skill-pdf?detailPrototype=review";

test.use({ locale: "zh-CN" });

test("the confirmed drawer and full-detail prototype return to the same selected Skill", async ({ page }) => {
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review&text=pdf");

  const drawer = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("link", { name: /查看完整详情/ }).click();

  await expect(page.getByTestId("skill-detail-review")).toBeVisible();
  await expect(page).toHaveURL(/detailPrototype=review/);
  await expect(page).toHaveURL(/drawerPrototype=review/);
  await expect(page).toHaveURL(/text=pdf/);
  await page.getByRole("link", { name: "返回技能库" }).click();

  await expect(page).toHaveURL(/__preview\/skill-library/);
  await expect(page).toHaveURL(/drawerPrototype=review/);
  await expect(page).toHaveURL(/skill=skill-pdf/);
  await expect(page.getByTestId("drawer-panel")).toBeVisible();
  await expect(page.getByTestId("skill-quick-drawer")).toHaveAttribute("data-drawer-prototype", "review");
});

test("a DEV detail route without prototype parameters keeps the original detail experience", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf");

  await expect(page.getByTestId("skill-detail-review")).toHaveCount(0);
  await expect(page.getByText("原型示例 · 操作不会更改真实文件、网络来源或技能库数据。", { exact: true })).toHaveCount(0);
  await expect(page.locator(".sh-skill-detail__layout")).toBeVisible();
});

test("review detail uses six user-task sections and one compact skill heading", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(reviewUrl);

  const navigation = page.getByRole("navigation", { name: "技能详情导航" });
  await expect(navigation.getByRole("link")).toHaveCount(6);
  for (const section of [
    "概览",
    "内容与文件",
    "安全检查",
    "使用去向",
    "来源更新",
    "版本历史",
  ]) {
    await expect(navigation.getByRole("link", { name: section, exact: true })).toBeVisible();
  }

  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name: "PDF Reader" })).toBeVisible();
  await expect(page.getByRole("button", { name: "派发", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除", exact: true })).toBeVisible();
  await expect(page.getByText("原型示例 · 操作不会更改真实文件、网络来源或技能库数据。", { exact: true })).toBeVisible();
});

test("review detail keeps readable sample facts and the Markdown reader visible without internal identifiers", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(reviewUrl);

  const visibleText = await page.locator("body").innerText();
  for (const internalValue of [
    "skill-pdf",
    "github:example/pdf-reader",
    "project-demo",
    "client_id",
    "sha256:",
    "import.governance.task",
    "1757808000",
    "version-240",
  ]) {
    expect(visibleText).not.toContain(internalValue);
  }

  await expect(page.getByText("PDF 阅读工具原始目录", { exact: true })).toBeVisible();
  await expect(page.getByText("~/SkillHub/skills/pdf-reader", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "内容与文件" }).click();
  await expect(page.getByRole("heading", { name: "Extract PDF tables safely" })).toBeVisible();
});

test("review detail gives one primary reading column and a bounded sticky navigation on narrow screens", async ({ page }) => {
  for (const width of [1440, 750, 390]) {
    await page.setViewportSize({ width, height: 719 });
    await page.goto(reviewUrl);
    const layout = await page.locator(".sh-skill-detail--review").evaluate((element) => {
      const nav = element.querySelector<HTMLElement>(".sh-skill-detail-review__nav");
      const main = element.querySelector<HTMLElement>(".sh-skill-detail-review__main");
      return {
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        navHeight: nav?.getBoundingClientRect().height ?? 0,
        navClientWidth: nav?.clientWidth ?? 0,
        navScrollHeight: nav?.scrollHeight ?? 0,
        navScrollWidth: nav?.scrollWidth ?? 0,
        mainWidth: main?.getBoundingClientRect().width ?? 0,
        mainLeft: main?.getBoundingClientRect().left ?? 0,
      };
    });

    expect(layout.documentScrollWidth - layout.documentClientWidth).toBeLessThanOrEqual(1);
    expect(layout.mainWidth).toBeGreaterThan(0);
    if (width <= 750) {
      expect(layout.navHeight).toBeLessThan(112);
      expect(layout.navScrollWidth).toBeGreaterThanOrEqual(layout.navClientWidth);
      expect(layout.mainLeft).toBeGreaterThanOrEqual(0);
    }
    await page.screenshot({ path: `test-results/detail-review/detail-overview-${width}.png` });
  }
});

test("review safety conclusion does not contradict an unresolved high-risk finding", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "安全检查" }).click();

  const summary = page.getByTestId("review-safety-summary");
  await expect(summary).toContainText("仍有高风险待处理");
  await expect(summary).toContainText("1 项");
  await expect(summary).toContainText("检查已完成");
  await expect(summary).not.toContainText("检查通过");
  await expect(page.getByText("发现疑似凭据字符串，请先确认来源。", { exact: true })).toBeVisible();
});

test("review source flow previews the effect and cancelling does not record a decision", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "来源更新" }).click();

  await page.getByRole("button", { name: "查找更新来源" }).click();
  await expect(page.getByRole("dialog", { name: "选择网络更新来源" })).toBeVisible();
  await page.getByRole("button", { name: "查找来源" }).click();
  await expect(page.getByText("来源已核验，可用于只读检查", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "只关联来源" }).click();
  await expect(page.getByRole("dialog", { name: "关联影响预览" })).toBeVisible();
  await expect(page.getByText("关联不会采用或替换当前内容", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("dialog", { name: "关联影响预览" })).toHaveCount(0);
  await expect(page.getByText("尚未关联更新来源", { exact: true })).toBeVisible();
  await expect(page.getByText("已忽略本次更新", { exact: true })).toHaveCount(0);
});

test("review content save uses the active Markdown draft for overwrite and new-skill inheritance", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "内容与文件" }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  const editor = page.locator(".cm-content");
  await editor.fill("# 评审中的 PDF Reader\n\n当前编辑草稿由保存面板直接读取。\n");

  await page.getByRole("button", { name: "保存…" }).click();
  const saveDialog = page.getByRole("dialog", { name: "保存内容" });
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByLabel("创建新 Skill").check();
  await saveDialog.getByLabel("不继承使用位置").check();
  await saveDialog.getByRole("button", { name: "查看保存影响" }).click();
  const newSkillImpact = page.getByRole("dialog", { name: "保存影响预览" });
  await expect(newSkillImpact.locator("pre")).toContainText("当前编辑草稿由保存面板直接读取。");
  await expect(newSkillImpact).toContainText("新 Skill 不会自动关联网络更新来源");
  await page.getByRole("button", { name: "取消" }).click();
  await expect(saveDialog).toHaveCount(0);
  await expect(editor).toContainText("当前编辑草稿由保存面板直接读取。");

  await page.getByRole("button", { name: "保存…" }).click();
  const overwriteDialog = page.getByRole("dialog", { name: "保存内容" });
  await overwriteDialog.getByLabel("覆盖当前 Skill（保留旧版本）").check();
  await overwriteDialog.getByRole("button", { name: "查看保存影响" }).click();
  await expect(page.getByText("当前版本保留在历史中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认保存并创建版本" }).click();
  await expect(page.getByText("内容已保存为新版本；网络更新来源继续保留。", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "保存…" }).click();
  const newSkillDialog = page.getByRole("dialog", { name: "保存内容" });
  await newSkillDialog.getByLabel("创建新 Skill").check();
  await newSkillDialog.getByLabel("替换继承当前使用位置").check();
  await newSkillDialog.getByRole("button", { name: "查看保存影响" }).click();
  await expect(page.getByRole("dialog", { name: "保存影响预览" })).toContainText("2 个受管链接按新主体更新；1 个独立副本原样保留、不自动覆盖");
  await page.getByRole("button", { name: "确认创建新 Skill" }).click();
  await expect(page.getByText(/新 Skill 已创建并记录“复用修改”关系/)).toBeVisible();
});

test("review overview supports trial review dates and lightweight combination membership edits", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("button", { name: "设置复核日期" }).click();
  const trialDialog = page.getByRole("dialog", { name: "试用复核设置" });
  await trialDialog.getByLabel("复核日期").fill("2026-11-05");
  await trialDialog.getByRole("button", { name: "保存复核日期" }).click();
  await expect(page.getByText("试用中", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "调整复核日期" })).toBeVisible();
  await page.getByRole("button", { name: "管理组合" }).click();
  const combinationDialog = page.getByRole("dialog", { name: "管理组合成员" });
  await combinationDialog.getByLabel("文档处理组合").check();
  await combinationDialog.getByRole("button", { name: "取消" }).click();
  await expect(page.locator(".sh-skill-detail-review__profile-strip dd").filter({ hasText: "未加入组合" })).toBeVisible();
  await page.getByRole("button", { name: "管理组合" }).click();
  await page.getByRole("dialog", { name: "管理组合成员" }).getByLabel("文档处理组合").check();
  await page.getByRole("button", { name: "保存成员变更" }).click();
  await expect(page.getByText("文档处理组合", { exact: true })).toBeVisible();
});

test("review usage details preserve exact target context and return to the same section", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "使用去向" }).click();
  await page.getByRole("button", { name: "查看治理详情" }).first().click();
  const targetDialog = page.getByRole("dialog", { name: "Codex 终端 · 使用关系" });
  await expect(targetDialog.getByText("~/Agents/Codex/skills/pdf-reader", { exact: true })).toBeVisible();
  await targetDialog.getByRole("button", { name: "返回技能详情" }).click();
  await expect(targetDialog).toHaveCount(0);
  await expect(page.locator("#review-usage")).toBeVisible();
  await page.getByRole("button", { name: "进入项目", exact: true }).click();
  const project = page.getByRole("dialog", { name: "文档协作项目 · 目标详情" });
  await expect(project).toContainText("~/Projects/文档协作/skills/pdf-reader");
  await project.getByRole("button", { name: "查看治理详情" }).click();
  await expect(page.getByRole("dialog", { name: "文档协作项目 · 使用关系" })).toContainText("链接可用");
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-usage")).toBeVisible();
});

test("review subject copy acknowledges permission failure and retries with the exact sample path", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(reviewUrl);
  await page.getByRole("button", { name: "打开位置", exact: true }).click();
  const subject = page.getByRole("dialog", { name: "技能库主体位置" });
  await subject.getByRole("button", { name: "复制路径" }).click();
  await expect(subject.getByRole("status")).toHaveText("路径已复制。");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("~/SkillHub/skills/pdf-reader");
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, "writeText", { value: () => Promise.reject(new Error("Permission denied")), configurable: true }); });
  await subject.getByRole("button", { name: "复制路径" }).click();
  await expect(subject.getByRole("alert")).toContainText("请允许剪贴板访问");
  await expect(subject.getByRole("status")).toHaveCount(0);
});

test("review source unlink and derived upstream preserve content and return context", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "来源更新" }).click();
  await page.locator("#review-sources .sh-skill-detail-review__dev-scenarios summary").click();
  await page.getByRole("button", { name: "模拟已关联", exact: true }).click();
  await page.getByRole("button", { name: "解除来源关联" }).click();
  await page.getByRole("dialog", { name: "解除网络来源关联" }).getByRole("button", { name: "取消" }).click();
  await expect(page.getByText("已关联：PDF Reader 官方维护仓库", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "解除来源关联" }).click();
  await page.getByRole("dialog", { name: "解除网络来源关联" }).getByRole("button", { name: "确认解除" }).click();
  await expect(page.getByText("尚未关联更新来源", { exact: true })).toBeVisible();
  // 复用修改追溯默认可见；DEV 切换后先进入“无复用修改依据”态，再切回。
  await page.getByRole("button", { name: "切换复用修改追溯" }).click();
  await expect(page.getByText("无复用修改依据。此技能不是从其他 Skill 复用修改创建的。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "切换复用修改追溯" }).click();
  await page.getByRole("button", { name: "查看原技能", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "PDF Reader 基础版 · 原技能" })).toContainText("原技能后续修改不会自动覆盖当前主体");
  await page.getByRole("button", { name: "返回当前技能" }).click();
  await expect(page.locator("#review-sources")).toBeVisible();
  await page.setViewportSize({ width: 750, height: 719 });
  await page.getByRole("link", { name: "来源更新" }).click();
  await page.screenshot({ path: "test-results/detail-review/detail-sources-750.png" });
});

test("review profile edits cancel or save and translation actions remain explicit", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("button", { name: "编辑别名" }).click();
  await page.getByRole("textbox", { name: "别名", exact: true }).fill("临时别名");
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByText("PDF 表格读取器", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑别名" }).click();
  await page.getByRole("textbox", { name: "别名", exact: true }).fill("PDF 表格工具");
  await page.getByRole("button", { name: "保存别名" }).click();
  await expect(page.getByText("PDF 表格工具", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "重新翻译" }).click();
  await expect(page.getByRole("dialog", { name: "重新翻译" })).toContainText("不会发送技能内容");
  await page.getByRole("dialog", { name: "重新翻译" }).getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "设为我的用途" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "确认替换我的用途" }).click();
  await expect(page.locator(".sh-metadata-panel__editable").filter({ has: page.getByRole("heading", { name: "我的用途说明", exact: true }) })).toContainText("模型译文");
});

test("review security preserves unresolved risk while exposing basic and AI run states", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "安全检查" }).click();
  await expect(page.getByRole("button", { name: "运行 AI 检查" })).toBeDisabled();
  await expect(page.getByText("未配置 LLM 提供商，AI 检查不可用", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "运行基础检查" }).click();
  await expect(page.getByTestId("review-safety-summary")).toContainText("仍有高风险待处理");

  await page.getByRole("button", { name: "忽略此项" }).click();
  const riskDialog = page.getByRole("alertdialog", { name: "高风险发现项处置确认" });
  await expect(riskDialog).toBeVisible();
  await riskDialog.getByRole("button", { name: "取消" }).click();
  await expect(page.getByTestId("review-safety-summary")).toContainText("1 项待处理");
  await page.getByRole("button", { name: "忽略此项" }).click();
  await page.getByRole("alertdialog", { name: "高风险发现项处置确认" }).getByRole("button", { name: "确认并忽略此项" }).click();
  await expect(page.getByText("已忽略", { exact: true })).toBeVisible();
  await expect(page.getByText("发现疑似凭据字符串，请先确认来源。", { exact: true })).toBeVisible();
  await expect(page.getByTestId("review-safety-summary")).toContainText("已处置高风险 1 项");
  await expect(page.getByTestId("review-safety-summary")).not.toContainText("仍有高风险待处理");
});

test("review toolbar provides scoped dispatch, standard export and deletion impact previews", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("button", { name: "派发", exact: true }).click();
  const dispatchDialog = page.getByRole("dialog", { name: "派发到 Agent 或项目" });
  await dispatchDialog.getByRole("button", { name: "查看派发影响" }).click();
  await expect(dispatchDialog).toContainText("将影响 1 个目标");
  await dispatchDialog.getByRole("button", { name: "取消" }).click();

  await page.getByRole("button", { name: "导出", exact: true }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出技能" });
  await expect(exportDialog.getByLabel("导出格式")).toHaveValue("标准 Skill ZIP");
  await expect(exportDialog).toContainText("导出当前版本 v2.4.1");
  await exportDialog.getByRole("button", { name: "导出" }).click();
  await expect(exportDialog).toContainText("未生成或保存文件");
  await exportDialog.getByRole("button", { name: "返回技能详情" }).click();

  await page.getByRole("button", { name: "删除", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "删除技能主体" });
  await expect(deleteDialog).toContainText("已集中管理链接：2 个");
  await expect(deleteDialog).toContainText("独立副本：1 个，保留在原位置");
  await deleteDialog.getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog", { name: "删除技能主体" }).getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByText("没有删除任何主体或目标", { exact: false })).toBeVisible();
});

test("review source replacement and adoption show distinct impacts and retain findings", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "来源更新" }).click();
  await page.locator("#review-sources .sh-skill-detail-review__dev-scenarios summary").click();
  await page.locator(".sh-skill-detail-review__dev-scenarios").getByRole("button", { name: "模拟本地有修改" }).click();
  await page.getByRole("button", { name: "检查更新" }).click();
  await page.getByRole("button", { name: "预览采用影响" }).click();
  const adoptDialog = page.getByRole("dialog", { name: "采用网络更新影响预览" });
  await expect(adoptDialog).toContainText("本机有未同步修改");
  await expect(adoptDialog).toContainText("原有高风险发现保留");
  await adoptDialog.getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: "预览采用影响" }).click();
  await page.getByRole("dialog", { name: "采用网络更新影响预览" }).getByRole("button", { name: "确认采用更新" }).click();
  await expect(page.getByText("示例更新已采用；新版本已创建，安全发现与独立副本仍保留。", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "更换来源" }).click();
  await page.getByRole("dialog", { name: "选择网络更新来源" }).getByRole("button", { name: "查找来源" }).click();
  await page.getByRole("button", { name: "更换来源" }).last().click();
  const replaceDialog = page.getByRole("dialog", { name: "更换网络来源影响预览" });
  await expect(replaceDialog).toContainText("技能内容和现有版本保持不变");
  await replaceDialog.getByRole("button", { name: "确认更换来源" }).click();
  await expect(page.getByText("更新来源已更换；当前内容和导入记录未改变。", { exact: true })).toBeVisible();
});

test("review version rows keep shared info and action slots across rows", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "版本历史" }).click();

  const rows = page.locator("#review-versions .sh-version-timeline ol > li > article");
  await expect(rows).toHaveCount(3);

  // 同类行共用布局槽位：时间列、命名按钮、比较勾选、恢复槽位的起点跨行一致，
  // 不因“当前版本”徽标只有一行有、恢复按钮只有历史行有而错位。
  const lefts = (locator) =>
    locator.evaluateAll((elements) => elements.map((el) => Math.round(el.getBoundingClientRect().left)));
  const expectSameLeft = async (locator) => {
    const values = await lefts(locator);
    expect(new Set(values).size).toBe(1);
  };

  await expectSameLeft(rows.locator("> p:nth-of-type(1)"));
  await expectSameLeft(rows.getByRole("button", { name: /命名版本/ }));
  await expectSameLeft(rows.locator("> label"));
  // 恢复槽位：历史行是真实按钮，当前行是无障碍隐藏的等宽占位。
  const restoreSlots = rows.locator("> *:last-child");
  await expect(restoreSlots).toHaveCount(3);
  await expect(restoreSlots.filter({ hasText: /恢复到/ })).toHaveCount(3);
  await expectSameLeft(restoreSlots);
});

test("review keeps the workspace region height across tabs and unifies safety card actions", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "内容与文件" }).click();

  // 四个视图共用同一舞台高度且联动提示行常驻预留：切换页签时
  // 下方安全检查区的纵向位置不得变化。
  const safetyTop = () =>
    page.evaluate(
      () => Math.round(document.querySelector("#review-safety").getBoundingClientRect().top + window.scrollY),
    );
  const tops: number[] = [];
  for (const mode of ["阅读", "源码", "编辑"]) {
    await page.getByRole("tab", { name: mode }).click();
    await page.waitForTimeout(300);
    tops.push(await safetyTop());
  }
  expect(new Set(tops).size).toBe(1);

  // 安全区两张检查卡共用动作槽：运行按钮都收在 .sh-workflow-actions，
  // 右缘跨卡一致，不因卡片内容差异一个居左一个居右。
  await page.getByRole("link", { name: "安全检查" }).click();
  const rights = await page.evaluate(() => {
    const buttons = [
      ...document.querySelectorAll("#review-safety .sh-workflow-grid .sh-workflow-actions .sh-button"),
    ];
    return buttons.map((button) => Math.round(button.getBoundingClientRect().right));
  });
  expect(rights).toHaveLength(2);
  expect(new Set(rights).size).toBe(1);
});

test("review versions compare, rename and restore with current relationship impact", async ({ page }) => {  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "版本历史" }).click();

  await page.getByRole("checkbox", { name: "选择 v2.4.1 进行比较" }).check();
  await page.getByRole("checkbox", { name: "选择 v2.4.0 进行比较" }).check();
  await page.getByRole("button", { name: "比较所选版本" }).click();
  await expect(page.getByRole("region", { name: "变更文件明细" })).toContainText("SKILL.md");

  await page.getByRole("button", { name: "命名版本 v2.4.0" }).click();
  await page.getByLabel("版本名称").fill("稳定版");
  await page.getByRole("button", { name: "保存名称" }).click();
  await expect(page.getByRole("heading", { name: "稳定版" })).toBeVisible();

  await page.getByRole("button", { name: "恢复到 稳定版" }).click();
  const rollback = page.getByRole("region", { name: "恢复影响预览" });
  await expect(rollback).toContainText("受管链接：2 个");
  await expect(rollback).toContainText("独立副本：1 个");
  await expect(rollback).toContainText("恢复后重新执行基础安全检查");
  await rollback.getByRole("button", { name: "取消" }).click();
  await expect(rollback).toHaveCount(0);

  await page.getByRole("button", { name: "恢复到 稳定版" }).click();
  await page.getByRole("region", { name: "恢复影响预览" }).getByRole("button", { name: "确认创建恢复版本" }).click();
  await expect(page.getByTestId("review-version-result")).toContainText("已创建新的当前版本");
  await expect(page.getByTestId("review-version-result")).toContainText("受管链接继续跟随当前版本");
  await expect(page.getByTestId("review-version-result")).toContainText("独立副本保持原状");
});

test("review content explorer lists files and opens the system app", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "内容与文件" }).click();

  const rail = page.getByRole("navigation", { name: "文件结构" });
  await expect(rail).toBeVisible();
  await expect(rail.getByText("主文件", { exact: true })).toBeVisible();
  await expect(rail.locator("button.is-active")).toContainText("SKILL.md");
  const optionCount = await page.locator("#skillhub-markdown-file option").count();
  await expect(rail.getByRole("button")).toHaveCount(optionCount);
  await expect(page.getByRole("button", { name: "使用默认应用打开" })).toBeVisible();

  // 对照页签已按用户裁决移除（与编辑页签重复），页签只剩阅读/源码/编辑。
  await expect(page.getByRole("tab", { name: "对照" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "编辑" })).toBeVisible();

  await page.setViewportSize({ width: 750, height: 719 });
  await expect(rail).toBeHidden();
  await expect(page.locator("#skillhub-markdown-file")).toBeVisible();
});

test("review usage offers a bounded graph entry explaining the future jump", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "使用去向" }).click();

  await page.getByRole("button", { name: "在图谱中查看" }).click();
  const graphDialog = page.getByRole("dialog", { name: "在技能图谱中查看" });
  await expect(graphDialog).toContainText("使用关系边");
  await expect(graphDialog).toContainText("复用修改");
  await graphDialog.getByRole("button", { name: "返回技能详情" }).click();
  await expect(graphDialog).toHaveCount(0);
  await expect(page.locator("#review-usage")).toBeVisible();
});

test("review source flow supports ignore, badges, auto check and combined associate-adopt", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "来源更新" }).click();

  await page.getByRole("button", { name: "查找更新来源" }).click();
  const chooser = page.getByRole("dialog", { name: "选择网络更新来源" });
  await chooser.getByRole("button", { name: "查找来源" }).click();
  await chooser.getByRole("button", { name: "只关联来源" }).click();
  await page.getByRole("dialog", { name: "关联影响预览" }).getByRole("button", { name: "确认关联" }).click();
  await expect(page.getByText("已关联更新来源，并自动完成一次只读检查；未采用任何内容。", { exact: true })).toBeVisible();
  await expect(page.getByText("发现可检查的上游更新", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "忽略本次更新" }).click();
  await expect(page.getByText("已忽略本次更新；该决定只作用于这一候选，之后的新候选会再次提醒。", { exact: true })).toBeVisible();

  await expect(page.getByText("网络仓库", { exact: true })).toBeVisible();
  await expect(page.getByText("GitHub", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开来源页面" }).click();
  await expect(page.getByText(/已请求在浏览器打开来源页面/)).toBeVisible();

  await page.getByRole("button", { name: "解除来源关联" }).click();
  await page.getByRole("dialog", { name: "解除网络来源关联" }).getByRole("button", { name: "确认解除" }).click();
  await expect(page.getByText("尚未关联更新来源", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "查找更新来源" }).click();
  const secondChooser = page.getByRole("dialog", { name: "选择网络更新来源" });
  await secondChooser.getByRole("button", { name: "查找来源" }).click();
  await secondChooser.getByRole("button", { name: "关联并采用更新" }).click();
  const combined = page.getByRole("dialog", { name: "关联并采用更新影响预览" });
  await expect(combined).toContainText("一次确认同时登记更新来源并采用其核验版本");
  await combined.getByRole("button", { name: "确认关联并采用更新" }).click();
  await expect(page.getByText("已关联来源并采用示例更新；新版本已创建，安全发现与独立副本仍保留。", { exact: true })).toBeVisible();
});

test("review dispatch previews same-name target occupancy handling", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("button", { name: "派发", exact: true }).click();
  const dispatchDialog = page.getByRole("dialog", { name: "派发到 Agent 或项目" });

  await dispatchDialog.getByLabel("演示：目标已有同名技能").check();
  await dispatchDialog.getByRole("button", { name: "查看派发影响" }).click();
  const conflict = dispatchDialog.locator(".sh-skill-detail-review__conflict");
  await expect(conflict).toContainText("目标已有同名技能");
  await conflict.getByLabel("替换为本次技能（核验后结束旧使用关系）").check();
  await dispatchDialog.getByRole("button", { name: "确认派发" }).click();
  await expect(dispatchDialog).toContainText("同名目标按“替换为本次技能”处理");
  await dispatchDialog.getByRole("button", { name: "返回技能详情" }).click();

  await page.getByRole("button", { name: "派发", exact: true }).click();
  const retryDialog = page.getByRole("dialog", { name: "派发到 Agent 或项目" });
  await expect(retryDialog.getByLabel("演示：目标已有同名技能")).not.toBeChecked();
});

test("review rail hosts the fixed identity actions and adjacent skill navigation", async ({ page }) => {
  await page.goto(reviewUrl);

  const identity = page.locator(".sh-skill-detail-review__identity");
  await expect(identity).toBeVisible();
  await expect(identity).toContainText("当前版本 · v2.4.1");
  await expect(identity.getByRole("button", { name: "派发", exact: true })).toBeVisible();

  const adjacent = page.getByRole("navigation", { name: "Skill 导航" });
  await expect(adjacent).toContainText("第 2 个，共 80 个");
  await adjacent.getByRole("link", { name: "上一个 Skill" }).click();
  await expect(page).toHaveURL(/skill-detail\/skill-doc/);
  await expect(page.getByTestId("skill-detail-review")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "DOCX Writer" })).toBeVisible();

  await page.getByRole("navigation", { name: "Skill 导航" }).getByRole("link", { name: "下一个 Skill" }).click();
  await expect(page).toHaveURL(/skill-detail\/skill-pdf/);
  await expect(page.getByRole("heading", { level: 1, name: "PDF Reader" })).toBeVisible();
});

test("review sources show the derived upstream block by default and the DEV toggle explains its absence", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "来源更新" }).click();

  await expect(page.getByRole("heading", { name: "复用修改的原技能" })).toBeVisible();
  await expect(page.getByText("从 PDF Reader 基础版 v2.3.2 创建，两个主体独立维护。此追溯不会自动建立网络更新来源。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看原技能", exact: true })).toBeVisible();

  await page.locator("#review-sources .sh-skill-detail-review__dev-scenarios summary").click();
  await page.getByRole("button", { name: "切换复用修改追溯" }).click();
  await expect(page.getByText("无复用修改依据。此技能不是从其他 Skill 复用修改创建的。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看原技能", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "切换复用修改追溯" }).click();
  await expect(page.getByRole("heading", { name: "复用修改的原技能" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看原技能", exact: true })).toBeVisible();
});

test("review header offers centralized management with basis choice and hides it after confirmation", async ({ page }) => {
  await page.goto(reviewUrl);

  const actionArea = page.locator('[aria-label="技能操作"]');
  const actionOrder = await actionArea.locator(".sh-button").evaluateAll((elements) =>
    elements.map((element) => element.textContent?.trim()),
  );
  expect(actionOrder).toEqual(["转为集中管理", "派发", "导出", "删除"]);
  // 追加裁决：转为集中管理与“待集中管理”徽标同色（warning），不与绿色强调入口混用。
  await expect(actionArea.locator(".sh-skill-detail-review__warning-action")).toHaveText("转为集中管理");
  await expect(actionArea.locator(".sh-skill-detail-review__accent-action")).toHaveCount(0);

  await actionArea.getByRole("button", { name: "转为集中管理" }).click();
  const centralizeDialog = page.getByRole("dialog", { name: "转为集中管理" });
  await expect(centralizeDialog).toContainText("~/Agents/Codex/skills/pdf-reader");
  await expect(centralizeDialog).toContainText("当前为独立副本，原位置内容尚未接管");
  await expect(centralizeDialog.getByLabel("以集中库当前内容为准（推荐）")).toBeChecked();
  await expect(centralizeDialog.getByLabel("以原位置现有内容为准（先保存为集中库历史版本再接管）")).not.toBeChecked();
  await expect(centralizeDialog).toContainText("该位置入口改为受管链接，跟随集中库当前版本");
  await expect(centralizeDialog).toContainText("原独立副本文件保留，可回退");
  await expect(centralizeDialog).toContainText("不删除任何文件");
  await expect(centralizeDialog).toContainText("其他使用关系不受影响");

  await centralizeDialog.getByRole("button", { name: "确认转为集中管理" }).click();
  await expect(centralizeDialog).toHaveCount(0);
  await expect(actionArea.getByRole("button", { name: "转为集中管理" })).toHaveCount(0);
  await expect(page.getByText("已转为集中管理（演示）：原位置已按受管链接跟随当前版本。", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "使用去向" }).click();
  const codexCard = page.locator(".sh-skill-detail-review__destination").filter({ hasText: "~/Agents/Codex/skills/pdf-reader" });
  await expect(codexCard).toContainText("已集中管理");
  await expect(codexCard).toContainText("原位置已由集中库受管链接接管，跟随当前版本；原独立副本内容保留。");
});

test("review governance dialog explains identity-carrying context into relationship governance", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "使用去向" }).click();
  await page.getByRole("button", { name: "查看治理详情" }).first().click();

  const targetDialog = page.getByRole("dialog", { name: "Codex 终端 · 使用关系" });
  await expect(targetDialog).toContainText("已精确选中此目标上下文。返回技能详情不会改变使用状态。");
  await expect(targetDialog).toContainText("正式实现将携带此技能与该使用关系、物理目标的身份进入关系治理，并保留返回技能详情的入口。");
});

test("review usage section explains section-level governance once above the cards", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "使用去向" }).click();

  const usageSection = page.locator("#review-usage");
  await expect(usageSection.getByText("此处汇总每个使用位置的健康状态与治理待办；接管、保留/撤销、修复、回收、结束在关系治理（或对应 Agent/项目页）执行，点击卡片按钮会携带该技能与具体关系的上下文跳转。", { exact: true })).toBeVisible();
  await expect(usageSection.locator(".sh-skill-detail-review__destination")).toHaveCount(3);
});

test("review duplicate candidates gate AI similarity analysis behind provider configuration", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "使用去向" }).click();

  const supplemental = page.locator("#review-usage .sh-skill-detail-review__supplemental");
  await expect(supplemental.getByRole("heading", { name: "可能重复的技能" })).toBeVisible();
  await expect(supplemental.getByText("PDF Text Extractor · 内容比对候选，尚未确认重复。", { exact: true })).toBeVisible();

  const aiButton = supplemental.getByRole("button", { name: "AI 相似性分析" });
  await expect(aiButton).toBeDisabled();
  await expect(supplemental.getByText("可在设置中的网络与 AI 配置提供商；当前原型不会发送内容。", { exact: true })).toBeVisible();

  await supplemental.getByRole("button", { name: "模拟 AI 已配置" }).click();
  await expect(aiButton).toBeEnabled();
  await aiButton.click();
  await expect(supplemental.getByText("AI 相似性分析完成：PDF Text Extractor 相似度最高，建议人工确认；未发现其他高相似候选。", { exact: true })).toBeVisible();
  await expect(supplemental.getByText("AI 结果只是辅助证据，不替代确定性比对。", { exact: true })).toBeVisible();
  await expect(supplemental.getByText("PDF Text Extractor · 内容比对候选，尚未确认重复。", { exact: true })).toBeVisible();

  await supplemental.getByRole("button", { name: "恢复未配置" }).click();
  await expect(aiButton).toBeDisabled();
  await expect(supplemental.getByText("AI 相似性分析完成：PDF Text Extractor 相似度最高，建议人工确认；未发现其他高相似候选。")).toHaveCount(0);
});

test("review supplemental evidence expands by default while DEV scenarios stay collapsed", async ({ page }) => {
  await page.goto(reviewUrl);

  await expect(page.getByRole("heading", { name: "依赖", exact: true })).toBeVisible();
  await expect(page.getByText("2026年10月2日：SKILL.md 在 SkillHub 外发生修改", { exact: true })).toBeVisible();
  await expect(page.locator("#review-usage .sh-skill-detail-review__supplemental")).toHaveAttribute("open", "");
  await expect(page.locator("#review-versions .sh-skill-detail-review__supplemental")).toHaveAttribute("open", "");

  await expect(page.getByRole("button", { name: "模拟未关联" })).toBeHidden();
  await expect(page.getByRole("button", { name: "切换复用修改追溯" })).toBeHidden();
  await expect(page.getByRole("button", { name: "切换到试用复核场景" })).toBeHidden();
});

test("review sections collapse in place and the side nav re-expands a collapsed section", async ({ page }) => {
  await page.goto(reviewUrl);

  // 默认六区全部展开；抽验三区，图标纯装饰。
  for (const id of ["review-overview", "review-sources", "review-versions"]) {
    await expect(page.locator(`#${id} .sh-skill-detail-review__section-toggle`)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`#${id}-body`)).toBeVisible();
  }
  await expect(page.locator("#review-overview .sh-skill-detail-review__section-toggle svg")).toHaveAttribute("aria-hidden", "true");

  // 点击“概览”标题收起：body 隐藏、其他分区不受影响。
  await page.getByRole("button", { name: "概览" }).click();
  await expect(page.locator("#review-overview .sh-skill-detail-review__section-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#review-overview-body")).toBeHidden();
  await expect(page.locator("#review-versions-body")).toBeVisible();

  // 折叠不卸载：收起-展开后 Markdown 草稿仍在。
  await page.getByRole("button", { name: "内容与文件" }).click();
  await expect(page.locator("#review-content-body")).toBeHidden();
  await page.getByRole("button", { name: "内容与文件" }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  await page.locator(".cm-content").fill("# 折叠保草稿\n\n收起再展开后草稿仍在。\n");
  await page.getByRole("button", { name: "内容与文件" }).click();
  await expect(page.locator("#review-content-body")).toBeHidden();
  await page.getByRole("button", { name: "内容与文件" }).click();
  await expect(page.locator(".cm-content")).toContainText("收起再展开后草稿仍在。");

  // 收起“来源更新”后从侧栏导航进入：分区自动展开并滚动可见。
  await page.getByRole("button", { name: "来源更新" }).click();
  await expect(page.locator("#review-sources .sh-skill-detail-review__section-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("link", { name: "来源更新" }).click();
  await expect(page.locator("#review-sources .sh-skill-detail-review__section-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#review-sources-body")).toBeVisible();
  await expect(page.locator("#review-sources")).toBeInViewport();
});
