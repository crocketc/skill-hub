import { expect, test } from "./fixtures";

// QA-011：进入编辑后源码与预览必须是稳定的左右分栏，源码编辑器和预览
// 内容都不得溢出自己的面板压到对方（常见桌面宽度与小窗口边界）。
const twoColumnWidths = [1440, 1280, 1024, 900] as const;
const singleColumnWidth = 560;

async function enterEditMode(page: import("@playwright/test").Page) {
  await page.goto("/__preview/skill-detail/skill-pdf#description");
  await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();
  await page.getByRole("tab", { name: "Edit" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown source" });
  await expect(editor).toBeVisible();
  // 长不可断行内容是验收中重叠的实际诱因，必须在最坏情况下保持分栏。
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(`\n\n${"overflow-probe-".repeat(40)}end`);
  return page.locator(".sh-markdown-editor__split");
}

test.describe("markdown edit split layout", () => {
  for (const width of twoColumnWidths) {
    test(`keeps source and preview side by side without overlap at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const split = await enterEditMode(page);

      const layout = await split.evaluate((container) => {
        const panes = [...container.children];
        const paneRects = panes.map((pane) => pane.getBoundingClientRect());
        // 编辑器自身盒子（.cm-editor）一旦越过源码面板右缘，就会把文字
        // 画到预览上方——这正是验收报告的重叠。
        const cmEditor = container.querySelector(".cm-editor");
        const renderer = container.querySelector(".sh-markdown-renderer");
        return {
          paneRects: paneRects.map((rect) => ({ left: rect.left, right: rect.right })),
          cmEditorRight: cmEditor?.getBoundingClientRect().right ?? null,
          rendererLeft: renderer?.getBoundingClientRect().left ?? null,
          rendererRight: renderer?.getBoundingClientRect().right ?? null,
        };
      });

      expect(layout.cmEditorRight).not.toBeNull();
      expect(layout.paneRects).toHaveLength(2);
      const [sourcePane, previewPane] = layout.paneRects;
      expect(sourcePane.right).toBeLessThanOrEqual(previewPane.left + 0.5);
      // 源码编辑器盒子必须留在自己的面板内，不能盖住预览。
      expect(layout.cmEditorRight).toBeLessThanOrEqual(sourcePane.right + 0.5);
      // 预览根节点必须在自己的面板内，且不与源码面板重叠。
      expect(layout.rendererLeft).toBeGreaterThanOrEqual(previewPane.left - 0.5);
      expect(layout.rendererRight).toBeLessThanOrEqual(width + 0.5);

      const horizontalOverflow = await page.evaluate(
        () =>
          (document.scrollingElement?.scrollWidth ?? 0) -
          (document.scrollingElement?.clientWidth ?? 0),
      );
      expect(horizontalOverflow).toBeLessThanOrEqual(1);
    });
  }

  test(`collapses to stacked panes at the small-window boundary (${singleColumnWidth}px)`, async ({ page }) => {
    await page.setViewportSize({ width: singleColumnWidth, height: 900 });
    const split = await enterEditMode(page);

    const stacked = await split.evaluate((container) => {
      const panes = [...container.children].map((pane) => pane.getBoundingClientRect());
      const columns = getComputedStyle(container).gridTemplateColumns.split(" ").length;
      const cmEditor = container.querySelector(".cm-editor");
      return {
        columns,
        sourceBottom: panes[0]?.bottom ?? 0,
        previewTop: panes[1]?.top ?? 0,
        panes: panes.map((rect) => ({ left: rect.left, right: rect.right })),
        cmEditorRight: cmEditor?.getBoundingClientRect().right ?? null,
      };
    });
    expect(stacked.columns).toBe(1);
    // 单列堆叠：源码面板在上、预览在下，互不压盖。
    expect(stacked.sourceBottom).toBeLessThanOrEqual(stacked.previewTop + 0.5);
    expect(stacked.cmEditorRight).toBeLessThanOrEqual(singleColumnWidth + 0.5);
  });
});
