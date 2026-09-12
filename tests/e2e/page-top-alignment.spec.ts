import { expect, test, type Page } from "./fixtures";

/**
 * T1 M-10 页头钉顶回归：满屏高度下页头与正文之间不得出现整段空白。
 * 根因是共享栅格容器在 align-content:normal 下把剩余高度摊进行高；
 * 本规范用真实 getBoundingClientRect 几何在概览/发现/待办三个回归样本上
 * 锁定"页头底缘↔正文顶缘 = 区块间距"的契约。
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
    label: "discovery",
    route: "/__preview/discovery-cards",
    containerSelector: ".sh-discovery-page",
    headerSelector: ".sh-discovery-page__heading",
    contentSelector: ".sh-discovery-home__grid",
  },
  {
    label: "pending",
    route: "/__preview/pending",
    containerSelector: ".sh-page-frame",
    headerSelector: ".sh-page-header",
    contentSelector: ".sh-pending",
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
      const style = getComputedStyle(container);
      return {
        alignContent: style.alignContent,
        headerToContent:
          content.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
        rowGap: parseFloat(style.rowGap),
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
