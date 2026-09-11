import { expect, test } from "./fixtures";

// QA-012：长 SKILL.md 不允许把工作区无限撑高——阅读/源码内容与编辑
// 分屏都要有桌面高度上限，超出部分在各自区域内独立滚动。
const longDocument = Array.from(
  { length: 240 },
  (_, index) => `## Section ${index + 1}\n\nParagraph ${index + 1} with ${"content-".repeat(12)}end.\n`,
).join("\n");

async function typeLongDocument(page: import("@playwright/test").Page) {
  const editor = page.getByRole("textbox", { name: "Markdown source" });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(longDocument);
  await expect
    .poll(
      async () =>
        page.locator(".sh-markdown-editor__split .sh-markdown-renderer").evaluate(
          (element) => element.textContent?.length ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(5000);
}

test.describe("markdown workspace height bounds", () => {
  test("edit split panes stay bounded and scroll independently with long content", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/skill-detail/skill-pdf#description");
    await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();
    await page.getByRole("tab", { name: "Edit" }).click();
    await typeLongDocument(page);

    const bounds = await page.locator(".sh-markdown-editor__split").evaluate((split) => {
      const splitRect = split.getBoundingClientRect();
      const panes = [...split.children].map((pane) => {
        const style = getComputedStyle(pane);
        const rect = pane.getBoundingClientRect();
        return {
          height: rect.height,
          overflowY: style.overflowY,
          scrollHeight: pane.scrollHeight,
          clientHeight: pane.clientHeight,
        };
      });
      return { splitHeight: splitRect.height, panes };
    });

    // 分屏整体高度必须收敛（预览 pane 上限 + 标题留量），不能随内容线性增长。
    expect(bounds.splitHeight).toBeLessThanOrEqual(560);
    const [sourcePane, previewPane] = bounds.panes;
    expect(sourcePane).toBeTruthy();
    expect(previewPane).toBeTruthy();
    // 预览 pane 必须可独立滚动：内容远高于面板时能在面板内部滚动。
    expect(previewPane.overflowY).toBe("auto");
    expect(previewPane.scrollHeight - previewPane.clientHeight).toBeGreaterThan(1000);
  });

  test("read mode workspace stays bounded after saving a long document", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/skill-detail/skill-pdf#description");
    await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();
    await page.getByRole("tab", { name: "Edit" }).click();
    await typeLongDocument(page);
    await page.getByRole("button", { name: "Save and create version" }).click();
    // P1-14：替换保存经过受控确认面板后完成（推荐副本为面板主操作）。
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Replace and save" }).click();
    // 保存成功并重建文件查询后编辑器重挂载，脏状态退出按钮变成干净退出。
    await expect(page.getByRole("button", { name: "Back to preview" })).toBeVisible();
    await page.getByRole("button", { name: "Back to preview" }).click();
    await expect(page.getByRole("heading", { name: "Section 1", exact: true })).toBeVisible();

    const bounds = await page.locator(".sh-markdown-workspace").evaluate((workspace) => {
      const renderer = workspace.querySelector(":scope > .sh-markdown-renderer");
      if (!renderer) return { found: false as const };
      const style = getComputedStyle(renderer);
      const rect = renderer.getBoundingClientRect();
      return {
        found: true as const,
        height: rect.height,
        overflowY: style.overflowY,
        scrollHeight: renderer.scrollHeight,
        clientHeight: renderer.clientHeight,
      };
    });
    expect(bounds.found).toBe(true);
    // 阅读模式的内容区必须有桌面高度上限，并在内部滚动。
    expect(bounds.height).toBeLessThanOrEqual(620);
    expect(bounds.overflowY).toBe("auto");
    expect(bounds.scrollHeight - bounds.clientHeight).toBeGreaterThan(1000);
  });
});
