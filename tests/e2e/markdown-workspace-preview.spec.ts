import { expect, test } from "./fixtures";

// T3-E：Markdown 工作区保守迁移的确定性验收入口。
// 夹具覆盖长代码、宽表格、大图、Mermaid 与被拦截的远程图片；
// 不依赖真实磁盘、网络或供应商。

test("markdown workspace preview exposes the deterministic rich document", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/markdown-workspace");

  await expect(
    page.getByRole("heading", { name: "Markdown workspace", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Markdown file" })).toHaveValue("SKILL.md");

  // 长代码块：语言标注可见。
  await expect(page.getByText("typescript", { exact: true })).toBeVisible();

  // 宽表格：完整渲染，横向滚动留给表格内部。
  await expect(page.getByRole("table")).toBeVisible();

  // Mermaid：图表/源码双视图可切换（在 Mermaid 自己的 tablist 内定位）。
  const mermaidViews = page.getByRole("tablist", { name: "Mermaid preview" });
  await expect(mermaidViews.getByRole("tab", { name: "Diagram" })).toBeVisible();
  await expect(mermaidViews.getByRole("tab", { name: "Source" })).toBeVisible();

  // 远程图片默认被拦截，本地大图经受控 facade 解析。
  await expect(page.getByText("Remote image blocked: img.example")).toBeVisible();
  // 大图在工作区内部滚动区深处，lazy 加载需要先滚动到可视区。
  await page.getByRole("heading", { name: "Large local image" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("img", { name: "Large diagram" })).toBeVisible();

  // 根级无横向滚动。
  const horizontalOverflow = await page.evaluate(
    () =>
      (document.scrollingElement?.scrollWidth ?? 0) -
      (document.scrollingElement?.clientWidth ?? 0),
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});

test("markdown content slots below the workspace heading on the preview outline", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/markdown-workspace");

  // 页面 outline：顶栏 h1 唯一；页面 h2 -> 工作区 h3 -> Markdown 标题 h4。
  await expect(
    page.getByRole("heading", { name: "Markdown workspace preview", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Skill description", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Preview surface fixture", level: 4 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Long code fence", level: 5 }),
  ).toBeVisible();
});

test("skill detail preview keeps a single route-level h1 with markdown content", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/skill-detail/skill-pdf#description");
  await expect(
    page.getByRole("heading", { name: "Markdown workspace", exact: true }),
  ).toBeVisible();

  // T3-C 报告的已知边界：Markdown 正文不得在详情页再产出 h1。
  const levelOne = page.getByRole("heading", { level: 1 });
  await expect(levelOne).toHaveCount(1);
  await expect(levelOne).toHaveText(/PDF Reader/);
  await expect(
    page.getByRole("heading", { name: "Extract PDF tables safely", level: 4 }),
  ).toBeVisible();
});

const rootHorizontalOverflow = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      (document.scrollingElement?.scrollWidth ?? 0) -
      (document.scrollingElement?.clientWidth ?? 0),
  );

test("wide table and long code scroll internally without root overflow", async ({ page }) => {
  for (const width of [1440, 1280, 1024] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/__preview/markdown-workspace");
    await expect(
      page.getByRole("heading", { name: "Wide table", level: 5 }),
    ).toBeVisible();

    const tableScroll = page.locator(".sh-markdown-table-scroll");
    await expect(tableScroll.getByRole("table")).toBeVisible();
    const tableBox = await tableScroll.evaluate((element) => ({
      clientWidth: element.clientWidth,
      right: element.getBoundingClientRect().right,
      scrollWidth: element.scrollWidth,
    }));
    // 滚动容器收在自己的盒子内；表格内容超宽时由容器内部滚动消化。
    expect(tableBox.right).toBeLessThanOrEqual(width + 0.5);
    expect(tableBox.scrollWidth).toBeGreaterThanOrEqual(tableBox.clientWidth);

    const codePre = page.locator(".sh-markdown-code pre").first();
    await expect(codePre).toBeVisible();
    const codeBox = await codePre.evaluate((element) => ({
      clientWidth: element.clientWidth,
      right: element.getBoundingClientRect().right,
      scrollWidth: element.scrollWidth,
    }));
    // 长代码行始终超出面板宽度，必须在代码块内部横向滚动。
    expect(codeBox.scrollWidth).toBeGreaterThan(codeBox.clientWidth);
    expect(codeBox.right).toBeLessThanOrEqual(width + 0.5);

    expect(await rootHorizontalOverflow(page)).toBeLessThanOrEqual(1);
  }

  // 窄窗口下宽表格必然溢出面板，滚动容器必须在内部收敛横向溢出。
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/__preview/markdown-workspace");
  const narrowScroll = await page
    .locator(".sh-markdown-table-scroll")
    .evaluate((element) => ({
      clientWidth: element.clientWidth,
      right: element.getBoundingClientRect().right,
      scrollWidth: element.scrollWidth,
    }));
  expect(narrowScroll.scrollWidth).toBeGreaterThan(narrowScroll.clientWidth);
  expect(narrowScroll.right).toBeLessThanOrEqual(800 + 0.5);
  expect(await rootHorizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("large local image scales inside the content column", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/markdown-workspace");
  await page.getByRole("heading", { name: "Large local image" }).scrollIntoViewIfNeeded();

  const image = page.getByRole("img", { name: "Large diagram" });
  await expect(image).toBeVisible();
  const box = await image.evaluate((element) => ({
    containerWidth: (element.parentElement as HTMLElement).clientWidth,
    height: element.getBoundingClientRect().height,
    right: element.getBoundingClientRect().right,
    width: element.getBoundingClientRect().width,
  }));
  // 1600x900 的源图按内容列宽缩放，保持纵横比且不溢出。
  expect(box.width).toBeLessThanOrEqual(box.containerWidth + 0.5);
  expect(box.right).toBeLessThanOrEqual(1280 + 0.5);
  expect(box.height / box.width).toBeCloseTo(900 / 1600, 1);
});

test("mermaid diagram renders inside its container and source view stays available", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/markdown-workspace");

  const diagram = page.locator(".sh-mermaid-block__diagram");
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 15_000 });
  const box = await diagram.evaluate((element) => ({
    right: element.getBoundingClientRect().right,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(box.right).toBeLessThanOrEqual(1280 + 0.5);
  if (box.scrollWidth > box.clientWidth) {
    // 超宽图表在容器内滚动，而不是撑开页面。
    expect(await rootHorizontalOverflow(page)).toBeLessThanOrEqual(1);
  }

  const mermaidViews = page.getByRole("tablist", { name: "Mermaid preview" });
  await mermaidViews.getByRole("tab", { name: "Source" }).click();
  await expect(page.getByRole("figure").getByText("flowchart LR")).toBeVisible();
});

test("edit split stays usable across the 40rem boundary", async ({ page }) => {
  for (const width of [648, 640] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/__preview/markdown-workspace");
    await page.getByRole("tab", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    await expect(editor).toBeVisible();

    const layout = await page.locator(".sh-markdown-editor__split").evaluate((split) => ({
      columns: getComputedStyle(split).gridTemplateColumns.split(" ").length,
      cmRight: split.querySelector(".cm-editor")?.getBoundingClientRect().right ?? 0,
      panes: [...split.children].map((pane) => {
        const rect = pane.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top };
      }),
    }));

    expect(layout.panes).toHaveLength(2);
    if (width > 640) {
      // 40rem 以上保持左右分栏，且源码编辑器不越出面板。
      expect(layout.columns).toBe(2);
      const [sourcePane, previewPane] = layout.panes;
      expect(sourcePane.right).toBeLessThanOrEqual(previewPane.left + 0.5);
    } else {
      // 40rem 临界宽度收成上下堆叠，源码在上、预览在下。
      expect(layout.columns).toBe(1);
      expect(layout.panes[0].top).toBeLessThan(layout.panes[1].top);
    }
    expect(layout.cmRight).toBeLessThanOrEqual(width + 0.5);
    expect(await rootHorizontalOverflow(page)).toBeLessThanOrEqual(1);
  }
});

test("workspace stays free of root horizontal overflow at minimum 600px height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/__preview/markdown-workspace");
  await expect(
    page.getByRole("heading", { name: "Markdown workspace", exact: true }),
  ).toBeVisible();
  expect(await rootHorizontalOverflow(page)).toBeLessThanOrEqual(1);

  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Markdown source" })).toBeVisible();
  expect(await rootHorizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("status notices pair icons with text and restore the registry stroke", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/markdown-workspace");

  // 恢复草稿状态：图标 + 文字，且描边在 markdown 专属 CSS 内补齐。
  const draftStatus = page
    .getByRole("status")
    .filter({ hasText: "A local draft was restored." });
  await expect(draftStatus).toBeVisible();
  const draftIcon = draftStatus.locator("svg[aria-hidden='true']");
  await expect(draftIcon).toHaveCount(1);
  expect(await draftIcon.evaluate((element) => getComputedStyle(element).strokeWidth)).toBe(
    "1.75px",
  );

  // 只读状态：切换到外部管理的文件后出现图标 + 文字的只读横幅。
  await page.getByRole("combobox", { name: "Markdown file" }).selectOption("docs/reference.md");
  const readOnlyNotice = page
    .getByRole("status")
    .filter({ hasText: "This file is read-only because it is managed externally." });
  await expect(readOnlyNotice).toBeVisible();
  const noticeIcon = readOnlyNotice.locator("svg[aria-hidden='true']");
  await expect(noticeIcon).toHaveCount(1);
  expect(await noticeIcon.evaluate((element) => getComputedStyle(element).strokeWidth)).toBe(
    "1.75px",
  );
});

const THEME_NAMES = [
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

async function gotoWithTheme(
  page: import("@playwright/test").Page,
  theme: string,
  path = "/__preview/markdown-workspace",
) {
  await page.addInitScript((storageTheme) => {
    window.localStorage.setItem("skillhub.appearance", storageTheme);
  }, theme);
  await page.goto(path);
}

function relativeLuminance(color: string): number {
  const channels = (color.match(/\d+(\.\d+)?/g) ?? [0, 0, 0]).slice(0, 3).map(Number);
  const [r, g, b] = channels.map((value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("code blocks follow the resolved theme in both light and dark", async ({ page }) => {
  // 浅色主题：代码块保持浅底。
  await gotoWithTheme(page, "moss-neutral");
  const lightPre = page.locator(".sh-markdown-code pre").first();
  await expect(lightPre).toBeVisible();
  const lightBackground = await lightPre.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(relativeLuminance(lightBackground)).toBeGreaterThan(0.5);

  // grok-night：代码块必须是暗色底，不能保留白底高亮。
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoWithTheme(page, "grok-night");
  const darkPre = page.locator(".sh-markdown-code pre").first();
  await expect(darkPre).toBeVisible();
  const darkBackground = await darkPre.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(relativeLuminance(darkBackground)).toBeLessThan(0.5);
});

test("mermaid diagram avoids the light default palette in grok-night", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoWithTheme(page, "grok-night");

  const diagram = page.locator(".sh-mermaid-block__diagram");
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 15_000 });

  // 默认浅色节点填充（#ECECFF）在暗色画布上是刺眼的亮块。
  const lightNodeFills = await diagram.evaluate((element) => {
    const fills = new Set<string>();
    for (const shape of element.querySelectorAll("rect, ellipse, polygon, path, circle")) {
      const fill = getComputedStyle(shape).fill;
      if (fill && fill !== "none") {
        fills.add(fill);
      }
    }
    return [...fills];
  });
  expect(lightNodeFills).not.toContain("rgb(236, 236, 255)");
});

test("workspace file picker exposes the shared control focus contract", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoWithTheme(page, "moss-neutral");
  await expect(page.getByRole("combobox", { name: "Markdown file" })).toBeVisible();

  const focus = await page.getByRole("combobox", { name: "Markdown file" }).evaluate(
    (element) => {
      element.focus();
      const style = getComputedStyle(element);
      return { borderColor: style.borderColor, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    },
  );
  // T0 控件契约：可见焦点环 + 控件边界使用语义 token。
  expect(focus.outlineStyle).toBe("solid");
  expect(focus.outlineWidth).toBe("2px");
});

test("all nine themes keep the workspace usable at 1280x900", async ({ page }) => {
  for (const theme of THEME_NAMES) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWithTheme(page, theme);
    await expect(
      page.getByRole("heading", { name: "Markdown workspace", exact: true }),
    ).toBeVisible();

    // 关键控件可用：文件选择、视图切换、保存入口都在文档流内。
    await expect(page.getByRole("combobox", { name: "Markdown file" })).toBeVisible();
    await expect(
      page.getByRole("tablist", { name: "Markdown view" }).getByRole("tab", { name: "Source" }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "Edit" })).toBeVisible();

    // 状态 = 图标 + 文字（拦截提示来自渲染文档内的远程图片）。
    await expect(page.getByText("Remote image blocked: img.example")).toBeVisible();

    expect(await rootHorizontalOverflow(page)).toBeLessThanOrEqual(1);
  }
});

test("grok-night keeps read and edit modes overflow-free across widths and minimum height", async ({ page }) => {
  for (const width of [1440, 1280, 1024, 800] as const) {
    for (const height of [900, 600] as const) {
      await page.setViewportSize({ width, height });
      await gotoWithTheme(page, "grok-night");
      await expect(
        page.getByRole("heading", { name: "Markdown workspace", exact: true }),
      ).toBeVisible();
      expect(await rootHorizontalOverflow(page)).toBeLessThanOrEqual(1);

      await page.getByRole("tab", { name: "Edit", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Markdown source" })).toBeVisible();
      expect(await rootHorizontalOverflow(page)).toBeLessThanOrEqual(1);
    }
  }
});
