import { expect, test } from "./fixtures";

/**
 * T3-C Skill 详情五区信息架构：身份 / 状态 / 正文 / 关系 / 生命周期。
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

test("organizes the detail page into five information zones", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf");

  for (const zone of ["Identity", "Status", "Content", "Relations", "Lifecycle"]) {
    await expect(page.getByRole("heading", { level: 2, name: zone, exact: true })).toBeVisible();
  }

  const zoneNav = page.getByRole("navigation", { name: "Detail sections" });
  await expect(zoneNav.getByRole("link")).toHaveCount(5);
  await expect(zoneNav.getByRole("link", { name: "Identity" })).toHaveAttribute(
    "href",
    "#zone-identity",
  );

  // 旧九章节锚点全部保留在对应分区内，外部分链路（快速抽屉 #versions）不断链。
  for (const anchor of [
    "metadata",
    "overview",
    "security",
    "description",
    "relations",
    "requirements",
    "connections",
    "versions",
    "external",
  ]) {
    expect(await page.locator(`#${anchor}`).count()).toBe(1);
  }

  await expect(
    page.getByRole("group", { name: "Source, library, and deployment targets" }),
  ).toBeVisible();
});

test("states each fact once and keeps deterministic candidates ahead of the optional AI layer", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf");

  // P1-12：五区标题唯一，块标题是该块唯一导航标题（面板不再重复）。
  const zoneHeadings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(new Set(zoneHeadings).size).toBe(zoneHeadings.length);
  expect(zoneHeadings).toEqual(["Identity", "Status", "Content", "Relations", "Lifecycle"]);
  await expect(page.getByRole("heading", { name: "Source identity" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "External changes and operation history" }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "External changes", exact: true })).toBeVisible();

  // 用途只出现一次（概览块）；别名只在头部出现一次，编辑契约保留在元数据。
  await expect(page.getByRole("heading", { level: 1, name: "PDF Reader" })).toBeVisible();
  await expect(page.getByText("用于 PDF 表格提取")).toHaveCount(1);
  await expect(page.getByText("PDF 表格读取器")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Edit Alias" })).toBeVisible();

  // 确定性重复候选加载即常显；可选 AI 分析未运行时不显示任何结果来源。
  await expect(
    page.getByRole("heading", { name: "Deterministic duplicate candidates" }),
  ).toBeVisible();
  await expect(
    page.getByText("Computed from the current version content; always available without AI."),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Deterministic duplicate candidates" }),
  ).toContainText("PDF Reader（副本）");
  await expect(page.getByRole("heading", { name: "Optional AI semantic analysis" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible();
  await expect(page.getByText(/Source: deterministic/)).toHaveCount(0);
});

test("keeps legacy section hashes working for deep links", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf#description");
  await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();

  await page.goto("/__preview/skill-detail/skill-pdf#versions");
  await expect(page.getByRole("heading", { name: "Version history" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Export this skill/ })).toBeVisible();
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
  test("collapses the zone navigation into a horizontal strip on narrow workspaces", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto("/__preview/skill-detail/skill-pdf");

    const zoneNav = page.getByRole("navigation", { name: "Detail sections" });
    await expect(zoneNav).toBeVisible();
    for (const zone of ["Identity", "Status", "Content", "Relations", "Lifecycle"]) {
      await expect(zoneNav.getByRole("link", { name: zone })).toBeVisible();
    }

    const tops = await zoneNav.getByRole("link").evaluateAll((links) =>
      links.map((link) => Math.round(link.getBoundingClientRect().top)),
    );
    expect(
      Math.max(...tops) - Math.min(...tops),
      "all zone links must share one row once the workspace is narrow",
    ).toBeLessThanOrEqual(2);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test("keeps the vertical zone rail on wide workspaces", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/skill-detail/skill-pdf");

    const zoneNav = page.getByRole("navigation", { name: "Detail sections" });
    await expect(zoneNav).toBeVisible();
    const tops = await zoneNav.getByRole("link").evaluateAll((links) =>
      links.map((link) => Math.round(link.getBoundingClientRect().top)),
    );
    expect(
      new Set(tops).size,
      "zone links must stack vertically on wide workspaces",
    ).toBeGreaterThanOrEqual(4);
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

    // 唯一滚动所有者可以滚到最后一个章节块；末项操作（导出）仍然可达。
    await page.locator("#versions").scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: /Export this skill/ })).toBeVisible();
    await page.locator("#external").scrollIntoViewIfNeeded();
    await expect(page.getByRole("heading", { name: "External changes", exact: true })).toBeVisible();

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

      // 关键状态：分区导航、状态徽标文字、关系轨迹与状态区概览都可见。
      await expect(page.getByRole("navigation", { name: "Detail sections" })).toBeVisible();
      await expect(page.getByRole("group", { name: "Skill status" })).toBeVisible();
      await expect(page.getByText("Basic check passed")).toBeVisible();
      await expect(
        page.getByRole("group", { name: "Source, library, and deployment targets" }),
      ).toBeVisible();

      // 键盘焦点可见：Tab 走到分区导航链接后必须出现 focus 描边。
      let focusedZoneLink = false;
      for (let tab = 0; tab < 30 && !focusedZoneLink; tab += 1) {
        await page.keyboard.press("Tab");
        focusedZoneLink = await page.evaluate(() =>
          document.activeElement?.closest(".sh-skill-detail__zone-nav") != null,
        );
      }
      expect(focusedZoneLink, "the zone nav must be keyboard reachable").toBe(true);
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
