import { expect, test } from "./fixtures";

/**
 * TC-GR-09-M03 的浏览器自动化层：核心页面在简体中文和英文下都渲染关键文案。
 * 语言来源与应用一致——i18n 在启动时读取 navigator.languages，因此用 Playwright
 * 的 locale 上下文选项切换。文案可理解性与视觉截断仍留真机人工判断。
 */

const EN_NAV = {
  sidebar: "Main navigation",
  items: [
    "Overview",
    "Skill library",
    "Discover",
    "Agents",
    "Projects",
    "Pending",
    "Operations and recovery",
    "Settings",
  ],
};

const ZH_NAV = {
  sidebar: "主导航",
  items: ["概览", "技能库", "发现", "Agent", "项目", "待处理", "操作记录与恢复", "设置"],
};

test.describe("core flows in English", () => {
  test.use({ locale: "en-US" });

  test("navigation and core pages render English copy", async ({ page }) => {
    await page.goto("/__preview/skill-library");
    // 侧栏 <aside aria-label> 覆盖主导航与底部导航两个地标。
    const sidebar = page.getByRole("complementary", { name: EN_NAV.sidebar });
    for (const item of EN_NAV.items) {
      await expect(sidebar.getByRole("link", { name: item, exact: true })).toBeVisible();
    }
    // T3-B：默认卡片视图下技能名是卡片标题（heading），同时出现在“查看”按钮文案中。
    await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
  });

  test("skill detail renders English workspace labels", async ({ page }) => {
    await page.goto("/__preview/skill-detail/skill-pdf");
    await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Source" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Edit" })).toBeVisible();
  });

  test("LLM settings render English capability and scope copy", async ({ page }) => {
    await page.goto("/__preview/settings-llm");
    await page.getByRole("tab", { name: "Network & AI" }).click();
    await expect(page.getByRole("heading", { name: "LLM providers" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI capabilities" })).toBeVisible();
    await expect(page.getByText("AI safety check")).toBeVisible();
    await expect(
      page.getByText("Sends: skill file contents (after masking sensitive values)"),
    ).toBeVisible();
  });

  test("security preview renders English headings", async ({ page }) => {
    await page.goto("/__preview/security-llm");
    await expect(page.getByRole("heading", { name: "LLM security check" })).toBeVisible();
  });

  test("online discovery renders English title", async ({ page }) => {
    await page.goto("/__preview/discovery-online");
    await expect(page.getByRole("heading", { name: "Online discovery" })).toBeVisible();
  });

  test("import wizard renders English title", async ({ page }) => {
    await page.goto("/__preview/import-wizard");
    await expect(page.getByRole("heading", { name: "Import Skills" })).toBeVisible();
  });
});

test.describe("core flows in Simplified Chinese", () => {
  test.use({ locale: "zh-CN" });

  test("navigation and core pages render Simplified Chinese copy", async ({ page }) => {
    await page.goto("/__preview/skill-library");
    const sidebar = page.getByRole("complementary", { name: ZH_NAV.sidebar });
    for (const item of ZH_NAV.items) {
      await expect(sidebar.getByRole("link", { name: item, exact: true })).toBeVisible();
    }
    // T3-B：默认卡片视图下技能名是卡片标题（heading）。
    await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
  });

  test("skill detail renders Simplified Chinese workspace labels", async ({ page }) => {
    await page.goto("/__preview/skill-detail/skill-pdf");
    await expect(page.getByRole("heading", { name: "Markdown 工作区" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "源码" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "编辑" })).toBeVisible();
  });

  test("LLM settings render Simplified Chinese capability and scope copy", async ({ page }) => {
    await page.goto("/__preview/settings-llm");
    await page.getByRole("tab", { name: "网络与 AI" }).click();
    await expect(page.getByRole("heading", { name: "LLM 供应商" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI 能力开关" })).toBeVisible();
    await expect(page.getByText("AI 安全检查")).toBeVisible();
    await expect(page.getByText("发送范围：Skill 文件内容（敏感值遮盖后）")).toBeVisible();
  });

  test("security preview renders Simplified Chinese headings", async ({ page }) => {
    await page.goto("/__preview/security-llm");
    await expect(page.getByRole("heading", { name: "LLM 安全检查" })).toBeVisible();
  });

  test("online discovery renders Simplified Chinese title", async ({ page }) => {
    await page.goto("/__preview/discovery-online");
    await expect(page.getByRole("heading", { name: "在线发现" })).toBeVisible();
  });

  test("import wizard renders Simplified Chinese title", async ({ page }) => {
    await page.goto("/__preview/import-wizard");
    await expect(page.getByRole("heading", { name: "导入 Skill" })).toBeVisible();
  });
});
