import { expect, test } from "./fixtures";

// 原型转正后不再有 detailPrototype/drawerPrototype 旗标参数（条件路径已删除）。
const reviewUrl = "/__preview/skill-detail/skill-pdf";

test.use({ locale: "zh-CN" });

test("the drawer and full detail return to the same selected Skill", async ({ page }) => {
  await page.goto("/__preview/skill-library?skill=skill-pdf&text=pdf");

  const drawer = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("link", { name: /查看完整详情/ }).click();

  await expect(page.getByTestId("skill-detail-review")).toBeVisible();
  // 往返上下文只靠库页 search 参数承载；原型形态已无旗标可断言。
  await expect(page).toHaveURL(/skill-detail\/skill-pdf/);
  await expect(page).toHaveURL(/text=pdf/);
  await page.getByRole("link", { name: "返回技能库" }).click();

  await expect(page).toHaveURL(/__preview\/skill-library/);
  await expect(page).toHaveURL(/skill=skill-pdf/);
  await expect(page).toHaveURL(/text=pdf/);
  await expect(page.getByTestId("drawer-panel")).toBeVisible();
  await expect(page.getByTestId("skill-quick-drawer")).toHaveAttribute("data-drawer-prototype", "review");
});

test("a DEV detail route without prototype parameters renders the promoted review experience", async ({ page }) => {
  // 原型转正裁决（界面呈现与操作入口 §9）：评审布局即生产默认形态，
  // 不存在“无旗标回落旧布局”的分支可断言。
  await page.goto("/__preview/skill-detail/skill-pdf");

  await expect(page.getByTestId("skill-detail-review")).toBeVisible();
  // 真实流接线轮（8a8baf01，§9 裁决：评审原型即生产默认呈现）：原型示例
  // 警示横幅已退役，页面直接呈现评审布局本身。
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
  // 8a8baf01：原型示例警示横幅随 §9 转正裁决退役，不再断言。
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
  // K9/W3-6：主体位置展示真实物化根路径（预览夹具 rootPath），
  // 不再有样例路径弹层。
  await expect(page.getByText("C:/Users/demo/SkillHub/skills/pdf-reader", { exact: true })).toBeVisible();
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

  // 真实流接线轮（W3-4/K6）：来源更新区接五命令真实契约，夹具已置
  // update_available_with_local_changes 候选。采用入口先取得真实预览，
  // 取消不产生任何采用决定。
  await expect(page.getByText("发现可采用的更新候选（v2.5.0）")).toBeVisible();
  await page.getByRole("button", { name: "预览采用影响" }).click();
  const adoptDialog = page.getByRole("dialog", { name: "采用更新影响预览" });
  await expect(adoptDialog).toBeVisible();
  await expect(adoptDialog).toContainText("确认后将按以下文件级变化创建新版本；当前内容保留为历史版本。");
  await expect(adoptDialog).toContainText("SKILL.md（修改）");
  await expect(adoptDialog).toContainText("scripts/run.py（新增）");
  await adoptDialog.getByRole("button", { name: "取消" }).click();
  await expect(adoptDialog).toHaveCount(0);
  // 状态投影不变：候选仍如实呈现，没有冒充已采用的文案。
  await expect(page.getByText("发现可采用的更新候选（v2.5.0）")).toBeVisible();
  await expect(page.getByText("已采用来源更新并创建新版本。")).toHaveCount(0);
});

test("review content save uses the active Markdown draft for overwrite and new-skill inheritance", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "内容与文件" }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  const editor = page.locator(".cm-content");
  await editor.fill("# 评审中的 PDF Reader\n\n当前编辑草稿由保存面板直接读取。\n");

  // K5/MS-06：创建分支收编进统一另存对话框——原型选择步只承载保存方式与
  // 草稿事实，继承选择与目标预览都由真实 SaveAsCopyDialog 按真实预览承载。
  await page.getByRole("button", { name: "保存…" }).click();
  const saveDialog = page.getByRole("dialog", { name: "保存内容" });
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByLabel("创建新 Skill（另存，登记复用修改来源）").check();
  await saveDialog.getByRole("button", { name: "查看保存影响" }).click();
  const newSkillImpact = page.getByRole("dialog", { name: "保存影响预览" });
  await expect(newSkillImpact.locator("pre")).toContainText("当前编辑草稿由保存面板直接读取。");
  await expect(newSkillImpact).toContainText("使用位置影响由保存前的目标预览如实分列");
  await newSkillImpact.getByRole("button", { name: "继续：选择继承与目标" }).click();

  // 真实另存对话框：不继承/替换继承二选一，默认不继承。
  const copyDialog = page.getByRole("dialog", { name: "另存为新技能" });
  await expect(copyDialog).toBeVisible();
  await expect(copyDialog.getByLabel("不继承使用位置")).toBeChecked();
  await expect(copyDialog.getByLabel("接管选定的使用位置")).toBeVisible();
  await copyDialog.getByRole("button", { name: "创建新技能" }).click();
  const copyResult = page.getByRole("dialog", { name: "新技能已创建" });
  await expect(copyResult).toBeVisible();
  await expect(copyResult).toContainText("已登记「复用修改」来源。");
  await expect(copyResult).toContainText("未请求接管使用位置；原有使用位置保持原状。");
  await copyResult.getByRole("button", { name: "关闭" }).click();
  await expect(copyDialog).toHaveCount(0);
  await expect(editor).toContainText("当前编辑草稿由保存面板直接读取。");

  await page.getByRole("button", { name: "保存…" }).click();
  const overwriteDialog = page.getByRole("dialog", { name: "保存内容" });
  await overwriteDialog.getByLabel("覆盖当前 Skill（保留旧版本）").check();
  await overwriteDialog.getByRole("button", { name: "查看保存影响" }).click();
  await expect(page.getByText("当前版本保留在历史中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认保存并创建版本" }).click();
  await expect(page.getByText("内容已保存为新版本；网络更新来源继续保留。", { exact: true })).toBeVisible();

  // 替换继承分支：确认门在真实对话框——无候选目标时如实呈现空态，
  // 没有目标预览就没有接管提交入口。
  await page.getByRole("button", { name: "保存…" }).click();
  const newSkillDialog = page.getByRole("dialog", { name: "保存内容" });
  await newSkillDialog.getByLabel("创建新 Skill（另存，登记复用修改来源）").check();
  await newSkillDialog.getByRole("button", { name: "查看保存影响" }).click();
  // 影响步更换对话框标题（保存内容 → 保存影响预览），按新名称重新解析。
  await page.getByRole("dialog", { name: "保存影响预览" }).getByRole("button", { name: "继续：选择继承与目标" }).click();
  const replaceDialog = page.getByRole("dialog", { name: "另存为新技能" });
  await replaceDialog.getByLabel("接管选定的使用位置").check();
  await expect(replaceDialog).toContainText("当前没有可接管的使用位置。");
  await expect(replaceDialog.getByRole("button", { name: "生成接管预览" })).toBeDisabled();
  await replaceDialog.getByRole("button", { name: "取消" }).click();
  await expect(replaceDialog).toHaveCount(0);
});

test("review overview supports trial review dates and readonly combination facts", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("button", { name: "设置复核日期" }).click();
  const trialDialog = page.getByRole("dialog", { name: "试用复核设置" });
  await trialDialog.getByLabel("复核日期").fill("2026-11-05");
  await trialDialog.getByRole("button", { name: "保存复核日期" }).click();
  await expect(page.getByText("试用中", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "调整复核日期" })).toBeVisible();

  // 真实流接线轮（W3-7）：组合成员编辑移至组合管理页；详情区只读展示
  // 组合事实并提供入口链接，不再有页内「管理组合成员」弹层。
  await expect(page.getByText("Document toolkit", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "管理组合" })).toHaveAttribute("href", "/library/combinations");
  await expect(page.getByRole("dialog", { name: "管理组合成员" })).toHaveCount(0);
});

test("review usage cards carry exact relation identity into governance and agent pages", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "使用去向" }).click();

  // 真实流接线轮（W3-3b/§7.8）：卡片治理入口携 Skill+关系身份深链治理页，
  // 演示用「使用关系」弹层随之退役；返回上下文由治理页 returnTo 承载。
  await page.getByRole("button", { name: "查看治理详情" }).first().click();
  await expect(page).toHaveURL(/\/relationships\/governance\?/);
  await expect(page).toHaveURL(/skillId=skill-pdf/);
  await expect(page).toHaveURL(/relationId=rel%3Askill-preview%3Acopy/);
  await page.goBack();
  await expect(page.locator("#review-usage")).toBeVisible();

  // 项目卡入口进真实项目列表页（Agent 详情路由的 id 空间与治理行不同，
  // 不伪造直达链接）。
  await page.getByRole("button", { name: "进入项目", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/?$/);
});

test("review subject copy reports clipboard outcomes honestly with the exact root path", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(reviewUrl);

  // 真实流接线轮（W3-6）：主体位置改为概览区常驻行（K9 真实物化根路径），
  // 不再有「技能库主体位置」弹层；复制路径如实报告成功与失败。
  await expect(page.getByRole("button", { name: "打开位置", exact: true })).toBeVisible();
  const locationRow = page.locator(".sh-skill-detail-review__context-row");
  await locationRow.getByRole("button", { name: "复制路径" }).click();
  await expect(locationRow.getByRole("status")).toHaveText("路径已复制。");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("C:/Users/demo/SkillHub/skills/pdf-reader");
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, "writeText", { value: () => Promise.reject(new Error("Permission denied")), configurable: true }); });
  await locationRow.getByRole("button", { name: "复制路径" }).click();
  await expect(locationRow.getByRole("alert")).toContainText("请允许剪贴板访问");
  await expect(locationRow.getByRole("status")).toHaveCount(0);
});

test("review sources keep the derived lineage visible and offer no unlink entry", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "来源更新" }).click();

  // 契约缺口（W3-4 登记）：后端没有「解除来源关联」命令，界面不提供该入口，
  // 以诚实缺省代替演示解除流。
  await expect(page.getByRole("button", { name: "解除来源关联" })).toHaveCount(0);
  // 复用修改追溯默认可见；来源主体名称即真实深链入口（§7.8 谱系事实），
  // DEV「切换复用修改追溯」与「查看原技能」弹层随真实流退役。
  await expect(page.getByRole("heading", { name: "复用修改的原技能" })).toBeVisible();
  await expect(page.getByRole("link", { name: "DOCX Writer" })).toHaveAttribute("href", "/library/skill-doc");
  await expect(page.getByText("复用修改创建，两个主体独立维护。此追溯不会自动建立网络更新来源。")).toBeVisible();
  await expect(page.getByRole("button", { name: "查看原技能", exact: true })).toHaveCount(0);

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

  // 真实流接线轮（W1-4/testFixtures emitIntent）：重新翻译直接执行并回写，
  // 不再有「重新翻译」演示弹层；译文写入用途仍需显式确认。
  await page.getByRole("button", { name: "重新翻译描述" }).click();
  await expect(page.getByText("Retranslated description (zh-CN)")).toBeVisible();
  await page.getByRole("button", { name: "设为我的用途" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "确认替换我的用途" }).click();
  await expect(page.locator(".sh-metadata-panel__editable").filter({ has: page.getByRole("heading", { name: "我的用途说明", exact: true }) })).toContainText("Retranslated description (zh-CN)");
});

test("review security preserves unresolved risk while exposing basic and AI run states", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "安全检查" }).click();
  // 转正后预览门面已配置 LLM 提供商，AI 检查在此路由可用；
  // "未配置 LLM 提供商"的禁用态由 SecurityResults.test.tsx 单测把守。
  await expect(page.getByRole("button", { name: "运行 AI 检查" })).toBeEnabled();
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

test("review toolbar routes dispatch and export to their real flows and previews deletion", async ({ page }) => {
  // 真实流接线轮（§10/W3-2）：派发跳真实部署页、导出跳数据保护页并携带
  // 本 Skill（exportSkillIds 经路由 state 传递，不在 URL 展示）。
  await page.goto(reviewUrl);
  await page.getByRole("button", { name: "派发", exact: true }).click();
  await expect(page).toHaveURL(/\/library\/skill-pdf\/deploy\/?$/);

  await page.goto(reviewUrl);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/data-protection\/?$/);

  // K2 两段式：删除先呈现结构化影响预览；逐目标处置门控与恢复说明由
  // relationship-views 同页用例完整把守，这里锁入口与门控起点。
  await page.goto(reviewUrl);
  await page.getByRole("button", { name: "删除", exact: true }).click();
  const deleteDialog = page.getByRole("dialog");
  await expect(deleteDialog).toContainText("从库中删除 PDF Reader 吗？");
  await expect(deleteDialog.getByRole("button", { name: "确认从库中删除" })).toBeDisabled();
  await deleteDialog.getByRole("button", { name: "取消" }).click();
  await expect(deleteDialog).toHaveCount(0);
});

test("review source replacement and adoption stay distinct flows with honest results", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "来源更新" }).click();

  // 真实流接线轮（W3-4/K6/G-15）：更换来源只登记关系（显式类型+地址），
  // 采用更新走预览绑定两段确认；两条流的影响说明各自独立呈现。
  await page.getByRole("button", { name: "更换来源" }).click();
  const replaceDialog = page.getByRole("dialog", { name: "更换网络更新来源" });
  await expect(replaceDialog).toContainText("来源类型由你显式选择；SkillHub 不会从地址文本猜测协议，也不会替换当前内容。");
  await expect(replaceDialog.getByRole("button", { name: "确认更换" })).toBeDisabled();
  await replaceDialog.getByRole("button", { name: "关闭" }).click();
  await expect(page.getByText("更新来源已更换；当前内容和导入记录未改变。")).toHaveCount(0);

  await expect(page.getByText("本机内容有未同步修改，采用前会说明覆盖影响。")).toBeVisible();
  await page.getByRole("button", { name: "预览采用影响" }).click();
  const adoptDialog = page.getByRole("dialog", { name: "采用更新影响预览" });
  await expect(adoptDialog).toContainText("确认后将按以下文件级变化创建新版本；当前内容保留为历史版本。");
  await adoptDialog.getByRole("button", { name: "确认采用更新" }).click();
  await expect(page.getByText("已采用来源更新并创建新版本。", { exact: true })).toBeVisible();

  // 采用不触碰安全事实：高风险发现照常呈现，不由来源更新结果抹掉。
  await expect(page.getByText("发现疑似凭据字符串，请先确认来源。", { exact: true })).toBeVisible();
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

  // 真实流接线轮（FB-②）：图谱入口携当前 Skill 身份真实跳转关系页，
  // 详情页不复制图谱画布，演示「在技能图谱中查看」弹层退役。
  await page.getByRole("link", { name: "在图谱中查看" }).click();
  await expect(page).toHaveURL(/\/relationships\?skillId=skill-pdf\/?$/);
});

test("review source flow keeps the ignore decision scoped to the current candidate", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "来源更新" }).click();

  // 真实流接线轮（W3-4/K6）：候选由持久状态投影呈现（夹具置
  // update_available_with_local_changes）；忽略按候选身份记录，重新拉取
  // 的状态如实标注忽略事实，采用入口随之隐藏。「关联并采用」联合演示
  // 由显式两段流程（登记来源 → 检查 → 预览采用）替代。
  await expect(page.getByText("发现可采用的更新候选（v2.5.0）")).toBeVisible();
  await page.getByRole("button", { name: "忽略本次更新" }).click();
  await expect(page.getByText("已忽略当前候选；之后的新候选会再次提醒。", { exact: true })).toBeVisible();
  await expect(page.getByText("当前候选已被忽略；之后的新候选会再次提醒。")).toBeVisible();
  await expect(page.getByRole("button", { name: "预览采用影响" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "忽略本次更新" })).toHaveCount(0);
});

test("review dispatch routes to the real deployment flow with occupancy handling", async ({ page }) => {
  // 真实流接线轮（§10）：派发演示弹层（含「演示：目标已有同名技能」开关）
  // 退役；同名占用处置由真实部署流承载——workflow-deployment E2E 与
  // DeploymentResults/DeploymentPreview 单测把守「目标目录已存在同名内容」
  // 的处置分组与文案。这里锁定详情页入口路由到部署页。
  await page.goto(reviewUrl);
  await page.getByRole("button", { name: "派发", exact: true }).click();
  await expect(page).toHaveURL(/\/library\/skill-pdf\/deploy\/?$/);
});

test("review rail hosts the fixed identity actions without fabricating adjacent skills", async ({ page }) => {
  await page.goto(reviewUrl);

  const identity = page.locator(".sh-skill-detail-review__identity");
  await expect(identity).toBeVisible();
  await expect(identity).toContainText("当前版本 · v2.4.1");
  await expect(identity.getByRole("button", { name: "派发", exact: true })).toBeVisible();

  // W1-5（FB-①/D7-A）：相邻技能由库列表推导；预览路由未注入库门面时
  // 隐藏导航，不伪造相邻（真实相邻导航由生产路由的库上下文承载）。
  await expect(page.getByRole("navigation", { name: "Skill 导航" })).toHaveCount(0);
});

test("review sources show the derived upstream block by default without DEV toggles", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "来源更新" }).click();

  // 真实流接线轮（W3-4）：复用修改追溯只由门面谱系事实承载（夹具指向
  // DOCX Writer），默认可见；DEV「切换复用修改追溯」与 dev-scenarios
  // 容器随真实流退役。
  await expect(page.getByRole("heading", { name: "复用修改的原技能" })).toBeVisible();
  await expect(page.getByRole("link", { name: "DOCX Writer" })).toBeVisible();
  await expect(page.getByText("无复用修改依据")).toHaveCount(0);
  await expect(page.locator("#review-sources .sh-skill-detail-review__dev-scenarios")).toHaveCount(0);
});

test("review header offers centralized management through the shared governance batch", async ({ page }) => {
  await page.goto(reviewUrl);

  const actionArea = page.locator('[aria-label="技能操作"]');
  const actionOrder = await actionArea.locator(".sh-button").evaluateAll((elements) =>
    elements.map((element) => element.textContent?.trim()),
  );
  expect(actionOrder).toEqual(["转为集中管理", "派发", "导出", "删除"]);
  // 追加裁决：转为集中管理与“待集中管理”徽标同色（warning），不与绿色强调入口混用。
  await expect(actionArea.locator(".sh-skill-detail-review__warning-action")).toHaveText("转为集中管理");
  await expect(actionArea.locator(".sh-skill-detail-review__accent-action")).toHaveCount(0);

  // 真实流接线轮（§7.8 生产承载）：确认入口打开与治理页共用的真实批次
  // 对话框（候选行来自治理清单、prepare→commit 真实契约），演示确认弹层
  // 与「原位置已按受管链接接管」的前端状态翻转退役；接管后的卡片刷新由
  // 关系治理页用例把守。
  await actionArea.getByRole("button", { name: "转为集中管理" }).click();
  const batchDialog = page.getByTestId("governance-batch-dialog");
  await expect(batchDialog).toBeVisible();
  await expect(batchDialog).toContainText("批量纳入集中库管理");
  await expect(batchDialog.getByRole("checkbox", { name: "执行 PDF Reader" })).toBeChecked();
  await batchDialog.getByTestId("governance-batch-confirm").click();
  await expect(page.getByTestId("governance-batch-result-title")).toContainText("已全部纳入集中库管理（1 条）");
  await expect(page.getByTestId(`governance-batch-result-rel:skill-preview:copy`)).toContainText("成功");
});

test("review governance deep link carries each card's relation identity", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "使用去向" }).click();

  // 真实流接线轮（W3-3b/§7.8）：演示用「使用关系」弹层与其说明文案退役，
  // 身份承载由真实深链完成——项目卡的治理入口携带自己的关系身份。
  await page.locator(".sh-skill-detail-review__destination").filter({ hasText: "文档协作" }).getByRole("button", { name: "查看治理详情" }).click();
  await expect(page).toHaveURL(/\/relationships\/governance\?/);
  await expect(page).toHaveURL(/skillId=skill-pdf/);
  await expect(page).toHaveURL(/relationId=rel%3Askill-preview%3Amanaged-project/);
});

test("review usage section explains section-level governance once above the cards", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "使用去向" }).click();

  const usageSection = page.locator("#review-usage");
  await expect(usageSection.getByText("此处汇总每个使用位置的健康状态与治理待办；接管、保留/撤销、修复、回收、结束在关系治理（或对应 Agent/项目页）执行，点击卡片按钮会携带该技能与具体关系的上下文跳转。", { exact: true })).toBeVisible();
  await expect(usageSection.locator(".sh-skill-detail-review__destination")).toHaveCount(3);
});

test("review duplicate candidates stay visible while the optional AI layer only adds evidence", async ({ page }) => {
  await page.goto(reviewUrl);
  await page.getByRole("link", { name: "使用去向" }).click();

  // 真实流接线轮（149c7065 面板契约，zh-CN 渲染）：确定性候选常显；
  // 预览门面已配置 LLM 提供商，AI 分析可运行并如实标注来源与仅供参考，
  // 「未配置停用」降级态由 SemanticDuplicatePanel 单测把守；DEV「模拟 AI
  // 已配置/恢复未配置」开关退役。
  const supplemental = page.locator("#review-usage .sh-skill-detail-review__supplemental");
  await expect(supplemental.getByRole("heading", { name: "确定性重复候选" })).toBeVisible();
  await expect(supplemental.getByText("PDF Reader（副本）")).toBeVisible();
  await expect(supplemental.getByText("结果来源：确定性候选 + AI 语义分析")).toHaveCount(0);

  const aiButton = supplemental.getByRole("button", { name: "运行分析" });
  await expect(aiButton).toBeEnabled();
  await aiButton.click();
  await expect(supplemental.getByText("结果来源：确定性候选 + AI 语义分析")).toBeVisible();
  await expect(supplemental.getByText("PDF Text Extractor")).toBeVisible();
  await expect(supplemental.getByText(/分析结果仅供参考；合并、删除、归档/)).toBeVisible();
  await expect(supplemental.getByText("PDF Reader（副本）")).toBeVisible();
});

test("review usage supplemental evidence expands by default while fabricated history stays removed", async ({ page }) => {
  await page.goto(reviewUrl);

  // 使用区补充证据（依赖/重复候选/使用证据）默认展开；8a8baf01 移除版本区
  // 伪造外部变化样例后，版本区不再有补充证据 details。
  await expect(page.getByRole("heading", { name: "依赖", exact: true })).toBeVisible();
  await expect(page.locator("#review-usage .sh-skill-detail-review__supplemental")).toHaveAttribute("open", "");
  await expect(page.locator("#review-versions .sh-skill-detail-review__supplemental")).toHaveCount(0);
  await expect(page.getByText("2026年10月2日：SKILL.md 在 SkillHub 外发生修改")).toHaveCount(0);

  // DEV 场景切换按钮随真实流退役（W3-4/W3-7），页面不再提供模拟态入口。
  await expect(page.getByRole("button", { name: "模拟未关联" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "切换复用修改追溯" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "切换到试用复核场景" })).toHaveCount(0);
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
