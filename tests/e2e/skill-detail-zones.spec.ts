import { expect, test } from "./fixtures";

/**
 * 原型转正后的技能详情评审布局（SkillDetailReviewExperience 六信息区）：
 * 概览 / 内容与文件 / 安全检查 / 使用去向 / 来源更新 / 版本历史。
 * 分区导航与分区标签为组件内置中文，不随 locale 变化。
 * 只断言公开 DOM、可访问名称与几何；截图产物走 --output 指定的任务 /tmp 目录。
 */

test.use({ locale: "en-US" });

// 9 个预设主题（名称与顺序锁定于 src/styles/theme.ts）。
const themeNames = [
  "moss-neutral",
  "spring-signal",
  "terracotta",
  "codex-light",
  "ocean-cobalt",
  "sakura",
  "aurora",
  "roast",
  "grok-night",
] as const;

const reviewSections = [
  ["review-overview", "概览"],
  ["review-content", "内容与文件"],
  ["review-safety", "安全检查"],
  ["review-usage", "使用去向"],
  ["review-sources", "来源更新"],
  ["review-versions", "版本历史"],
] as const;

test("organizes the detail page into six information zones", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf");

  // 六区导航：链接名称与 href 一一对应真实分区。
  const zoneNav = page.getByRole("navigation", { name: "技能详情导航" });
  await expect(zoneNav.getByRole("link")).toHaveCount(6);
  for (const [id, label] of reviewSections) {
    await expect(zoneNav.getByRole("link", { name: label })).toHaveAttribute("href", `#${id}`);
    await expect(page.locator(`#${id}`)).toBeVisible();
    // 分区折叠开关的 aria-controls 指向真实分区体。
    await expect(
      page.locator(`.sh-skill-detail-review__section-toggle[aria-controls="${id}-body"]`),
    ).toBeVisible();
  }

  // 侧栏身份区：返回链接、当前版本与技能操作组常驻。
  await expect(page.getByRole("link", { name: "返回技能库" })).toBeVisible();
  await expect(page.getByText("当前版本 · v2.4.1")).toBeVisible();
  await expect(page.locator('[aria-label="技能操作"]').getByRole("button", { name: "派发" })).toBeVisible();

  // 原型示例警示可见：页面操作不写真实文件与技能库数据。
  await expect(page.getByRole("note")).toContainText("原型示例");
});

test("full Skill details expose the shared security checks and finding dispositions", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/skill-detail/skill-pdf");

  const security = page.locator("#review-safety");
  const runBasicCheck = security.getByRole("button", { name: "Run basic check" });
  await runBasicCheck.scrollIntoViewIfNeeded();
  await expect(runBasicCheck).toBeInViewport();
  await expect(security.getByRole("button", { name: "Run AI check" })).toBeVisible();
  // risk-aware 摘要条：仍有高风险待处理的事实直接可见。
  await expect(security.getByTestId("review-safety-summary")).toContainText("1 high risk · 1 pending");
  await expect(security.getByText("发现疑似凭据字符串，请先确认来源。")).toBeVisible();
  await expect(security.getByText("prompt_injection")).toHaveCount(0);
  // W1-3：预览门面常驻的基础检查代表导入时登记的记录——安全区如实标注来源。
  await expect(security.getByText("Checked at import")).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("skill-detail-security-1440x900.png"),
  });

  const basicCheckTime = security.locator("#basic-security-heading").locator("xpath=..").locator("time");
  const previousBasicCheckTime = await basicCheckTime.getAttribute("datetime");
  await runBasicCheck.click();
  await expect.poll(() => basicCheckTime.getAttribute("datetime")).not.toBe(previousBasicCheckTime);
  await expect(security.getByTestId("review-safety-summary")).toContainText("1 high risk · 1 pending");
  // 手动重跑产生的是本次手动记录：导入时标注如实撤下，不冒充导入检查。
  await expect(security.getByText("Checked at import")).toHaveCount(0);

  const llmSection = security.locator("#llm-security-heading").locator("xpath=..");
  const llmCheckTime = llmSection.locator("time");
  const previousLlmCheckTime = await llmCheckTime.getAttribute("datetime");
  // 预览门面已配置 LLM 提供商（createPreviewSecurityFacade），AI 检查按钮可用。
  await llmSection.getByRole("button", { name: "Run AI check" }).click();
  await expect.poll(() => llmCheckTime.getAttribute("datetime")).not.toBe(previousLlmCheckTime);
  await expect(llmSection).toContainText("Passed");

  await security.getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByRole("alertdialog", { name: "Confirm high-risk finding action" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Acknowledge this finding" })).toBeVisible();
});

test("states each fact once and keeps deterministic candidates ahead of the optional AI layer", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf");

  // 六区标题唯一：分区折叠开关是该块唯一导航标题（旧五区面板标题已整体移除）。
  const zoneLabels = await page.locator(".sh-skill-detail-review__section-toggle").allTextContents();
  expect(new Set(zoneLabels).size).toBe(zoneLabels.length);
  expect(zoneLabels).toEqual(["概览", "内容与文件", "安全检查", "使用去向", "来源更新", "版本历史"]);
  await expect(page.getByRole("heading", { name: "Source identity" })).toHaveCount(0);

  // 旧九章节锚点不再是本页事实出口；外部变更收纳为版本区唯一的补充 details。
  for (const anchor of ["metadata", "overview", "description", "relations", "connections", "external", "zone-identity", "zone-lifecycle"]) {
    expect(await page.locator(`#${anchor}`).count()).toBe(0);
  }
  await expect(page.getByText("外部变更与操作记录")).toHaveCount(1);

  await expect(page.getByRole("heading", { level: 1, name: "PDF Reader" })).toBeVisible();
  // 别名只在元数据面板出现一次：读值与编辑入口同源（EditableTextSection）。
  await expect(page.locator('p[aria-label="Alias"]')).toHaveText("PDF 表格读取器");
  await expect(page.getByRole("button", { name: "Edit Alias" })).toBeVisible();

  // 确定性重复候选加载即常显；可选 AI 分析默认未配置，结果区不提前出现。
  await expect(page.getByRole("heading", { name: "可能重复的技能" })).toBeVisible();
  await expect(page.getByText("PDF Text Extractor · 内容比对候选，尚未确认重复。")).toBeVisible();
  const aiAnalysis = page.getByRole("button", { name: "AI 相似性分析" });
  await expect(aiAnalysis).toBeDisabled();
  await expect(page.getByText("AI 相似性分析未配置，当前保留确定性比对证据。")).toBeVisible();
  await expect(page.getByText("AI 相似性分析完成：")).toHaveCount(0);

  // 模拟配置后分析可运行；结果只是辅助证据，不替代确定性比对。
  await page.getByRole("button", { name: "模拟 AI 已配置" }).click();
  await expect(aiAnalysis).toBeEnabled();
  await aiAnalysis.click();
  await expect(page.getByText(/AI 相似性分析完成：/)).toBeVisible();
  await expect(page.getByText("AI 结果只是辅助证据，不替代确定性比对。")).toBeVisible();
});

test("keeps review-section hashes working for deep links", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf#review-content");
  await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();

  await page.goto("/__preview/skill-detail/skill-pdf#review-versions");
  // 深链可达性以分区真实渲染的版本时间线为锚。
  await expect(page.locator("#review-versions .sh-version-timeline")).toBeVisible();
  await expect(page.locator("#review-versions").getByRole("heading", { name: "v2.4.1" })).toBeVisible();
  await expect(
    page.locator("#review-versions").getByRole("button", { name: "Compare selected versions" }),
  ).toBeVisible();

  // 旧 #versions 锚点随布局转正移除；抽屉/待办/关系图深链已统一指向
  // #review-versions。本页不再提供旧锚点，防止任何深链静默落空。
  expect(await page.locator("#versions").count()).toBe(0);
});

test("renders the deterministic long-name fixture without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/skill-detail/skill-long");

  const heading = page.getByRole("heading", {
    level: 1,
    name: /Long Named Skill/,
  });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveText(
    "Long Named Skill For Layout Regression Coverage With Unusual Multi Segment Title Text And Extended Verification Suffix Words",
  );

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `scrollWidth (${overflow.scrollWidth}) must not exceed clientWidth (${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
});

test.describe("responsive workspace behaviour", () => {
  test("collapses the review navigation into a horizontal strip on narrow workspaces", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto("/__preview/skill-detail/skill-pdf");

    const zoneNav = page.getByRole("navigation", { name: "技能详情导航" });
    await expect(zoneNav).toBeVisible();
    for (const [, zone] of reviewSections) {
      await expect(zoneNav.getByRole("link", { name: zone })).toBeVisible();
    }

    const tops = await zoneNav.getByRole("link").evaluateAll((links) =>
      links.map((link) => Math.round(link.getBoundingClientRect().top)),
    );
    expect(
      Math.max(...tops) - Math.min(...tops),
      "all review nav links must share one row once the workspace is narrow",
    ).toBeLessThanOrEqual(2);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test("keeps the vertical review rail on wide workspaces", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/skill-detail/skill-pdf");

    const zoneNav = page.getByRole("navigation", { name: "技能详情导航" });
    await expect(zoneNav).toBeVisible();
    const tops = await zoneNav.getByRole("link").evaluateAll((links) =>
      links.map((link) => Math.round(link.getBoundingClientRect().top)),
    );
    expect(
      new Set(tops).size,
      "review nav links must stack vertically on wide workspaces",
    ).toBeGreaterThanOrEqual(5);
  });

  for (const width of [800, 1024, 1280, 1440]) {
    test(`long-name fixture stays free of horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/skill-detail/skill-long");

      await expect(page.getByRole("heading", { level: 1, name: /Long Named Skill/ })).toBeVisible();
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    });
  }

  test("keeps the whole page reachable at the 600px minimum height", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto("/__preview/skill-detail/skill-pdf");

    await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();

    // 唯一滚动所有者可以滚到最后两个分区；可达性探针用分区真实存在的
    // 可操作元素（来源更新区的查找入口、版本区的比较入口）。
    await page.locator("#review-sources").scrollIntoViewIfNeeded();
    await expect(
      page.locator("#review-sources").getByRole("button", { name: "查找更新来源" }),
    ).toBeVisible();
    await page.locator("#review-versions").scrollIntoViewIfNeeded();
    await expect(
      page.locator("#review-versions").getByRole("button", { name: "Compare selected versions" }),
    ).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});

test.describe("theme contract", () => {
  for (const theme of themeNames) {
    test(`keeps the detail page usable under ${theme} at 1280×900`, async ({ page }) => {
      await page.addInitScript(([value]) => {
        window.localStorage.setItem("skillhub.appearance", value!);
      }, [theme]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/__preview/skill-detail/skill-pdf");

      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

      // 关键状态：分区导航、技能操作组与概览分区都可见。
      await expect(page.getByRole("navigation", { name: "技能详情导航" })).toBeVisible();
      await expect(page.locator('[aria-label="技能操作"]')).toBeVisible();
      await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();

      // 键盘焦点可见：Tab 走到分区导航链接后必须出现 focus 描边。
      let focusedZoneLink = false;
      for (let tab = 0; tab < 30 && !focusedZoneLink; tab += 1) {
        await page.keyboard.press("Tab");
        focusedZoneLink = await page.evaluate(() =>
          document.activeElement?.closest(".sh-skill-detail-review__nav") != null,
        );
      }
      expect(focusedZoneLink, "the review nav must be keyboard reachable").toBe(true);
      const outlineStyle = await page.evaluate(
        () => getComputedStyle(document.activeElement!).outlineStyle,
      );
      expect(outlineStyle).not.toBe("none");

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    });
  }

  for (const width of [800, 1024, 1280, 1440]) {
    test(`grok-night stays free of horizontal overflow at ${width}px`, async ({ page }) => {
      await page.addInitScript(() => {
        window.localStorage.setItem("skillhub.appearance", "grok-night");
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/skill-detail/skill-long");

      await expect(page.locator("html")).toHaveAttribute("data-theme", "grok-night");
      await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
      await expect(page.getByRole("heading", { level: 1, name: /Long Named Skill/ })).toBeVisible();

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    });
  }
});
