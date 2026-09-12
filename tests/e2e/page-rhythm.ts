import { expect, type Page } from "@playwright/test";

export interface PageRhythm {
  paddingTop: number;
  rowGap: number;
  headerToContent: number;
}

/**
 * P2-01 页面节奏断言的共享测量（overview / discovery 等页共用）：
 * - 区块间距消费统一的 --page-gap（= --space-4 = 16px）；
 * - PageFrame 不得叠加第二层内边距（AppShell 内容区已统一提供留白）；
 * - 页头底缘↔正文顶缘的实际距离必须等于区块间距。
 * `contentSelector` 传各页正文根节点的选择器。
 */
export async function expectUnifiedPageRhythm(
  page: Page,
  contentSelector: string,
  label: string,
): Promise<void> {
  const rhythm = await page.evaluate((selector) => {
    const frame = document.querySelector<HTMLElement>(".sh-page-frame");
    if (!frame) return null;
    const content = frame.querySelector(selector);
    if (!content) return null;
    const style = getComputedStyle(frame);
    const header = frame.querySelector(".sh-page-header");
    if (!header) return null;
    return {
      paddingTop: parseFloat(style.paddingTop),
      rowGap: parseFloat(style.rowGap),
      headerToContent:
        content.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
    };
  }, contentSelector);
  expect(rhythm, `the ${label} page frame must exist`).not.toBeNull();
  expect(rhythm!.rowGap, "section gap must sit on the unified 16px step").toBe(16);
  expect(rhythm!.paddingTop, "page frame must not stack a second padding layer").toBe(0);
  expect(
    Math.abs(rhythm!.headerToContent - rhythm!.rowGap),
    "header-to-content distance must equal the section gap",
  ).toBeLessThanOrEqual(1);
}
