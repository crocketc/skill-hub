import { expect, test, type Page } from "./fixtures";

/**
 * T1 设置页布局与主题验收：几何与行为断言优先，不以像素快照替代。
 * 尺寸矩阵 800/1024/1280/1440 × 900，另测最小高度 600；9 主题在 1280×900
 * 检查关键控件、焦点、状态与无横溢。
 */

const SECTION_NAV = "Settings sections";

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

test.use({ locale: "en-US" });

async function openSettings(page: Page, search = "") {
  await page.goto(`/__preview/settings-llm${search}`);
  const tablist = page.getByRole("tablist", { name: SECTION_NAV });
  await expect(tablist).toBeVisible();
  return tablist;
}

async function layoutMetrics(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector(".sh-settings-nav");
    const panels = document.querySelector(".sh-settings-panels");
    const cards = [
      ...document.querySelectorAll<HTMLElement>(".sh-settings-panel:not([hidden]) .sh-settings-card"),
    ];
    const navBox = nav!.getBoundingClientRect();
    const panelBox = panels!.getBoundingClientRect();
    const stackedCards = cards.every((card, index) =>
      index === 0 ? true : card.getBoundingClientRect().top >= cards[index - 1]!.getBoundingClientRect().bottom - 1,
    );
    const singleColumn = cards.every(
      (card) => Math.abs(card.getBoundingClientRect().left - cards[0]!.getBoundingClientRect().left) < 1,
    );
    return {
      sideBySide: navBox.right <= panelBox.left + 1,
      stacked: navBox.bottom <= panelBox.top + 1,
      singleColumn,
      stackedCards,
      rootScrollWidth: document.documentElement.scrollWidth,
      rootClientWidth: document.documentElement.clientWidth,
    };
  });
}

test.describe("settings section layout across widths", () => {
  for (const width of [800, 1024, 1280, 1440] as const) {
    test(`no horizontal overflow and single-column content at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const tablist = await openSettings(page);

      const metrics = await layoutMetrics(page);
      expect(metrics.rootScrollWidth, `at ${width}px`).toBeLessThanOrEqual(metrics.rootClientWidth);
      expect(metrics.singleColumn, `cards stay single column at ${width}px`).toBe(true);
      expect(metrics.stackedCards, `cards never sit side by side at ${width}px`).toBe(true);

      // P2-01：页头↔正文留白节奏统一消费 --page-gap（= --space-4 = 16px）。
      const pageGap = await page.evaluate(
        () => parseFloat(getComputedStyle(document.querySelector<HTMLElement>(".sh-settings-page")!).rowGap),
      );
      expect(pageGap, `unified section gap at ${width}px`).toBe(16);

      // 分区导航位置：1280/1440 左侧，800/1024 顶部紧凑。
      if (width >= 1280) {
        expect(metrics.sideBySide, `nav sits left of content at ${width}px`).toBe(true);
      } else {
        expect(metrics.stacked, `nav stacks above content at ${width}px`).toBe(true);
      }

      // 顶部紧凑模式同样可以通过键盘/指针使用。
      await tablist.getByRole("tab", { name: "Automation" }).click();
      await expect(page.getByRole("switch", { name: "Batch checks" })).toBeVisible();
    });
  }

  for (const width of [800, 1280] as const) {
    test(`minimum height 600px keeps sections reachable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 600 });
      const tablist = await openSettings(page);

      const metrics = await layoutMetrics(page);
      expect(metrics.rootScrollWidth).toBeLessThanOrEqual(metrics.rootClientWidth);

      await tablist.getByRole("tab", { name: "App update" }).click();
      await expect(page.getByRole("tabpanel", { name: "App update" })).toBeVisible();
    });
  }
});

test.describe("long text and multiple providers", () => {
  test("long names, endpoints, models and error codes stay readable without overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const tablist = await openSettings(page, "?scenario=long-text");
    await tablist.getByRole("tab", { name: "Network & AI" }).click();

    const rows = page.locator("li.sh-settings-provider");
    await expect(rows).toHaveCount(3);

    const longRow = page.locator("li.sh-settings-provider", { hasText: "A".repeat(24) });
    await expect(longRow).toBeVisible();

    await longRow.getByRole("button", { name: "Test connection" }).click();
    await expect(
      longRow.getByText(
        "Model connection failed (llm.provider_not_found_or_unauthorized_very_long_code_suffix); reachability alone does not prove the model works",
      ),
    ).toBeVisible();

    const metrics = await layoutMetrics(page);
    expect(metrics.rootScrollWidth).toBeLessThanOrEqual(metrics.rootClientWidth);
  });

  test("drawer keeps long drafts on a single column at 800px", async ({ page }) => {
    // 减少动态效果下抽屉直接到达终态，避免动画进行中测量几何。
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 800, height: 900 });
    const tablist = await openSettings(page, "?scenario=long-text");
    await tablist.getByRole("tab", { name: "Network & AI" }).click();

    await page.getByRole("button", { name: "Add provider" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    const inputs = [
      drawer.getByRole("textbox", { name: "Provider ID" }),
      drawer.getByRole("textbox", { name: "Display name" }),
      drawer.getByRole("textbox", { name: "API address (Base URL)" }),
    ];
    const boxes = [];
    for (const input of inputs) {
      boxes.push((await input.boundingBox())!);
    }
    for (const box of boxes.slice(1)) {
      expect(box.x).toBeCloseTo(boxes[0]!.x, 0);
      expect(box.width).toBeLessThanOrEqual(boxes[0]!.width + 1);
    }

    await drawer.getByRole("button", { name: "Cancel" }).click();
  });
});

test.describe("wide-container dual scroll owners", () => {
  for (const width of [1280, 1440] as const) {
    test(`section nav stays fixed while only the content column scrolls at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const tablist = await openSettings(page);
      // 切到内容最长的分区，保证内容列溢出。
      await tablist.getByRole("tab", { name: "Network & AI" }).click();
      await expect(page.getByRole("heading", { name: "LLM providers" })).toBeVisible();

      const before = await page.evaluate(() => {
        const panels = document.querySelector<HTMLElement>(".sh-settings-panels");
        const nav = document.querySelector<HTMLElement>(".sh-settings-nav");
        if (!panels || !nav) return null;
        return {
          panelsScrollable: panels.scrollHeight > panels.clientHeight,
          navScrollable: nav.scrollHeight > nav.clientHeight,
          navTop: nav.getBoundingClientRect().top,
          rootScrollHeight: document.documentElement.scrollHeight,
          rootClientHeight: document.documentElement.clientHeight,
        };
      });
      expect(before).not.toBeNull();
      // 宽容器双滚动所有者：内容列自滚；短导航无独立滚动条；页面外壳不滚。
      expect(before!.panelsScrollable, "content column owns the scrolling").toBe(true);
      expect(before!.navScrollable, "a short section nav shows no own scrollbar").toBe(false);
      expect(before!.rootScrollHeight, "page shell has no vertical scroll").toBeLessThanOrEqual(
        before!.rootClientHeight,
      );

      // 滚动内容列：分区导航纹丝不动。
      await page.locator(".sh-settings-panels").evaluate((node) => {
        node.scrollTop = 120;
      });
      await page.waitForFunction(() => {
        const panels = document.querySelector<HTMLElement>(".sh-settings-panels");
        return !!panels && panels.scrollTop > 0;
      });
      const navTopAfter = await page.evaluate(
        () => document.querySelector<HTMLElement>(".sh-settings-nav")!.getBoundingClientRect().top,
      );
      expect(
        Math.abs(navTopAfter - before!.navTop),
        "nav stays fixed while the content column scrolls",
      ).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("nine themes on the settings page at 1280x900", () => {
  for (const theme of themeNames) {
    test(`${theme} keeps controls, focus and drawer usable`, async ({ page }) => {
      await page.addInitScript((stored) => {
        window.localStorage.setItem("skillhub.appearance", stored);
      }, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      const tablist = await openSettings(page);

      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

      // 选中分区使用主题语义 token（非写死颜色）。
      const colors = await page.evaluate(() => {
        const selected = document.querySelector<HTMLElement>(
          '.sh-settings-nav__tab[aria-selected="true"]',
        );
        const probe = document.createElement("div");
        probe.style.background = "var(--ui-selected-surface)";
        document.body.appendChild(probe);
        const tokenColor = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          tabBackground: selected ? getComputedStyle(selected).backgroundColor : "",
          tokenColor,
        };
      });
      expect(colors.tabBackground, `${theme} selected tab uses --ui-selected-surface`).toBe(
        colors.tokenColor,
      );

      // 关键区域可用：LLM 分区、抽屉、焦点可见、无横溢。
      await tablist.getByRole("tab", { name: "Network & AI" }).click();
      await expect(page.getByRole("heading", { name: "LLM providers" })).toBeVisible();
      await expect(page.locator("li.sh-settings-provider").first()).toBeVisible();

      await page.getByRole("button", { name: "Add provider" }).click();
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(drawer).not.toBeVisible();

      const focused = page.locator(":focus");
      await expect(focused).toBeVisible();

      const metrics = await layoutMetrics(page);
      expect(metrics.rootScrollWidth, `${theme} overflow`).toBeLessThanOrEqual(
        metrics.rootClientWidth,
      );
    });
  }
});
