import { expect, test, type Page } from "./fixtures";

/**
 * T1 M-10 页头钉顶回归：满屏高度下页头与正文之间不得出现整段空白。
 * 根因是共享栅格容器在 align-content:normal 下把剩余高度摊进行高；
 * 本规范用真实 getBoundingClientRect 几何在概览/发现/待办三个回归样本上
 * 锁定"页头底缘↔正文顶缘 = 其所有者容器的区块间距"的契约（pending 的
 * 页头嵌在 .sh-pending 包装内，间距按 .sh-workflow-page 的 gap 判定）。
 */

test.use({ locale: "en-US" });

interface TopAlignment {
  alignContent: string;
  headerToContent: number;
  rowGap: number;
}

const samples: Array<{
  label: string;
  route: string;
  containerSelector: string;
  headerSelector: string;
  contentSelector: string;
}> = [
  {
    label: "overview",
    route: "/__preview/overview",
    containerSelector: ".sh-page-frame",
    headerSelector: ".sh-page-header",
    contentSelector: ".sh-overview",
  },
  {
    // 集成后 /__preview/discovery-cards 是卡片验收看板（DiscoveryCardsPreview）：
    // 页头后第一个区块是主题切换组；.sh-discovery-home__grid 只存在于真实
    // /discovery 路由的 DiscoveryHome，不在本预览。
    label: "discovery",
    route: "/__preview/discovery-cards",
    containerSelector: ".sh-page-frame",
    headerSelector: ".sh-page-header",
    contentSelector: ".sh-preview-board__themes",
  },
  {
    // 待办页的 PageHeader 位于 .sh-pending 包装内部，页头后第一个内容区块
    // 是 .sh-pending__card（间距由 .sh-workflow-page 的 gap 决定）。
    label: "pending",
    route: "/__preview/pending",
    containerSelector: ".sh-page-frame",
    headerSelector: ".sh-page-header",
    contentSelector: ".sh-pending__card",
  },
];

async function measure(
  page: Page,
  sample: (typeof samples)[number],
): Promise<TopAlignment> {
  return page.evaluate(
    ({ containerSelector, headerSelector, contentSelector }) => {
      const container = document.querySelector<HTMLElement>(containerSelector);
      const header = document.querySelector<HTMLElement>(headerSelector);
      const content = document.querySelector<HTMLElement>(contentSelector);
      if (!container || !header || !content) {
        throw new Error("layout nodes missing");
      }
      // 页头与其后第一个内容区块的实际所有者容器（overview/discovery 是
      // PageFrame；pending 是 .sh-workflow-page——间距各按自己的 gap 判定）。
      const owner = header.parentElement ?? container;
      const style = getComputedStyle(container);
      return {
        alignContent: style.alignContent,
        headerToContent:
          content.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
        rowGap: parseFloat(getComputedStyle(owner).rowGap),
      };
    },
    {
      containerSelector: sample.containerSelector,
      headerSelector: sample.headerSelector,
      contentSelector: sample.contentSelector,
    },
  );
}

for (const height of [1200, 800] as const) {
  for (const sample of samples) {
    test(`${sample.label} keeps the header pinned to the content at 1600x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1600, height });
      await page.goto(sample.route);
      await expect(
        page.locator(sample.contentSelector).first(),
      ).toBeVisible();

      const alignment = await measure(page, sample);
      expect(
        alignment.alignContent,
        `${sample.label} container must pin its rows to the top`,
      ).toBe("start");
      expect(
        Math.abs(alignment.headerToContent - alignment.rowGap),
        `${sample.label} header-to-content distance must equal the section gap`,
      ).toBeLessThanOrEqual(1);
    });
  }
}
