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

  // F9：堆叠单列下两侧不再并排滚动，联动开关隐藏；回到分屏宽度恢复显示
  //（持久化状态不受影响）。视口宽度是唯一变量，锁定两个断点态。
  test("hides the sync scroll toggle where panes stack and shows it side by side", async ({ page }) => {
    await page.setViewportSize({ width: singleColumnWidth, height: 900 });
    await page.goto("/__preview/skill-detail/skill-pdf#description");
    await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();
    await page.getByRole("tab", { name: "Edit" }).click();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toBeVisible();

    const toggle = page.getByRole("checkbox", { name: "Sync scrolling" });
    await expect(toggle).toBeHidden();

    await page.setViewportSize({ width: 900, height: 900 });
    await expect(toggle).toBeVisible();
  });

  // P1-14：同步滚动开关存在且可切换；切换后两侧面板仍并排不重叠，
  // 联动开启时预览跟随源码滚动，关闭后保持不动。
  test("sync scroll toggle drives the preview and keeps the split intact", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/skill-detail/skill-pdf#description");
    await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();
    await page.getByRole("tab", { name: "Edit" }).click();
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    // 预览实时渲染源码：追加长内容让两侧都有足够的纵向滚动空间。
    await page.keyboard.insertText(`\n\n${"sync-probe line\n".repeat(80)}`);

    const toggle = page.getByRole("checkbox", { name: "Sync scrolling" });
    await expect(toggle).toBeChecked();

    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(
        ".sh-markdown-editor__pane--source .cm-scroller",
      );
      scroller.scrollTop = Math.floor(scroller.scrollHeight / 4);
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector<HTMLElement>(".sh-markdown-editor__pane--preview")
              ?.scrollTop ?? 0,
        ),
      )
      .toBeGreaterThan(0);

    // 关闭开关后滚动源码，预览保持原位（无联动、无回弹抖动）。
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    const previewBefore = await page.evaluate(
      () =>
        document.querySelector<HTMLElement>(".sh-markdown-editor__pane--preview")
          ?.scrollTop ?? 0,
    );
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(
        ".sh-markdown-editor__pane--source .cm-scroller",
      );
      scroller.scrollTop = 0;
    });
    // scroll 事件在下一帧前派发：等两个动画帧确认联动已停止（帧边界，非任意延时）。
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(
      await page.evaluate(
        () =>
          document.querySelector<HTMLElement>(".sh-markdown-editor__pane--preview")
            ?.scrollTop ?? 0,
      ),
    ).toBe(previewBefore);

    const layout = await page.locator(".sh-markdown-editor__split").evaluate((container) =>
      [...container.children].map((pane) => {
        const rect = pane.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    );
    expect(layout).toHaveLength(2);
    const [sourcePaneRect, previewPaneRect] = layout;
    expect(sourcePaneRect.right).toBeLessThanOrEqual(previewPaneRect.left + 0.5);
  });
});
