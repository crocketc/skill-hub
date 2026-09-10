import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

const PREVIEW = "/__preview/discovery-cards";

/** 依据实测内容容器宽度推导契约列数：≥1180 三列、760–1179 两列、<760 单列。 */
function expectedColumns(contentWidth: number): number {
  if (contentWidth >= 1180) return 3;
  if (contentWidth >= 760) return 2;
  return 1;
}

async function firstRowGeometry(page: Page, listName: string) {
  const list = page.getByRole("list", { name: listName });
  await expect(list).toBeVisible();
  const listBox = await list.boundingBox();
  expect(listBox).not.toBeNull();
  const cards = list.getByRole("article");
  const count = await cards.count();
  const boxes = [];
  for (let index = 0; index < count; index += 1) {
    boxes.push(await cards.nth(index).boundingBox());
  }
  const firstRow = boxes.filter((box) => Math.abs((box?.y ?? 0) - (boxes[0]?.y ?? 0)) < 4);
  return { contentWidth: listBox?.width ?? 0, columns: firstRow.length, rowBoxes: firstRow };
}

async function rootHorizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function searchOnlineResults(page: Page) {
  await page.getByRole("textbox", { name: "Search skills.sh" }).fill("pdf");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
}

test.describe("discovery shared skill cards", () => {
  test("online search renders shared cards with honest statuses and independent semantics", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(PREVIEW);
    await searchOnlineResults(page);

    // AI 扩展命中、已在库、不可安装三个可证实状态并列可见。
    await expect(page.getByTestId("assist-skills.sh/community/pdf-tools")).toBeVisible();
    await expect(page.getByTestId("imported-skills.sh/acme/markdown-renderer")).toBeVisible();
    await expect(page.getByText("Not installable")).toBeVisible();

    // 标题、链接、操作保持独立语义：卡片是 article，不是整体按钮。
    const card = page.getByRole("article").filter({ hasText: "PDF Reader" }).first();
    await expect(card.getByRole("link", { name: "View" })).toBeVisible();
    const install = card.getByRole("button", { name: "Install & import" });
    await expect(install).toBeVisible();

    // 已在库命中的安装被禁用并说明原因。
    const importedCard = page
      .getByRole("article")
      .filter({ hasText: "Markdown Renderer" })
      .first();
    await expect(importedCard.getByRole("button", { name: "Install & import" })).toBeDisabled();

    await expect.poll(() => rootHorizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("repo and lock results map onto the same card model", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(PREVIEW);

    await page.getByRole("button", { name: "Scan repositories" }).click();
    const repoList = page.getByRole("list", { name: "Scan results" });
    await expect(repoList.getByRole("heading", { name: "PDF Processor" })).toBeVisible();
    const repoCard = page.getByRole("article").filter({ hasText: "PDF Processor" }).first();
    await expect(repoCard.getByText("anthropics/skills@main")).toBeVisible();
    await expect(repoCard.getByRole("link", { name: "README" })).toBeVisible();
    // 归档未提供描述的卡片不伪造文案。
    const nestedCard = page.getByRole("article").filter({ hasText: "Nested Tool" }).first();
    await expect(nestedCard).toBeVisible();
    await expect(nestedCard.getByText("deep/nested/tool")).toBeVisible();

    await page.getByRole("button", { name: "Scan lock file" }).click();
    const lockList = page.getByRole("list", { name: "Lock entries" });
    await expect(lockList.getByRole("heading", { name: "pdf", exact: true })).toBeVisible();
    const lockCard = lockList.getByRole("article").first();
    await expect(lockCard.getByText("anthropics/skills@v2")).toBeVisible();
    await expect(lockCard.getByText("Repo path: skills/pdf")).toBeVisible();
    // lock 条目没有描述与安装数：卡片如实省略。
    expect(await lockCard.getByText(/Installs:/).count()).toBe(0);
  });

  for (const width of [800, 1024, 1280, 1440, 1600]) {
    test(`results grid maps measured content width to 3/2/1 columns at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PREVIEW);
      await searchOnlineResults(page);

      const { contentWidth, columns } = await firstRowGeometry(page, "Search results");
      expect(columns).toBe(expectedColumns(contentWidth));
      // 卡片最小宽度约 280px（单列窄容器除外）。
      if (contentWidth >= 760) {
        expect(columns).toBeGreaterThan(1);
      }
      await expect.poll(() => rootHorizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test("card action areas stay pinned to the shared row bottom", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(PREVIEW);
    await searchOnlineResults(page);

    const { columns, rowBoxes } = await firstRowGeometry(page, "Search results");
    expect(columns).toBeGreaterThan(1);
    const bottoms = rowBoxes.map((box) => box.y + box.height);
    const maxHeight = Math.max(...bottoms);
    const minHeight = Math.min(...bottoms);
    // 等高拉伸后，同一行卡片底边一致，操作区不漂移。
    expect(maxHeight - minHeight).toBeLessThanOrEqual(2);
  });

  test("long skill names stay inside the card without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto(PREVIEW);
    await searchOnlineResults(page);

    const longCard = page.getByRole("article").filter({ hasText: /long-name stress fixture/ }).first();
    await expect(longCard).toBeVisible();
    const cardBox = await longCard.boundingBox();
    const list = page.getByRole("list", { name: "Search results" });
    const listBox = await list.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(listBox).not.toBeNull();
    expect(cardBox!.x).toBeGreaterThanOrEqual(listBox!.x - 1);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(listBox!.x + listBox!.width + 1);
    await expect.poll(() => rootHorizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("keyboard reaches the search controls and results actions", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(PREVIEW);

    const input = page.getByRole("textbox", { name: "Search skills.sh" });
    let inputFocused = false;
    for (let tabs = 0; tabs < 40 && !inputFocused; tabs += 1) {
      inputFocused = await input.evaluate((el) => el === document.activeElement);
      if (!inputFocused) await page.keyboard.press("Tab");
    }
    expect(inputFocused).toBe(true);

    await input.fill("pdf");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();

    const install = page
      .getByRole("article")
      .filter({ hasText: "PDF Reader" })
      .first()
      .getByRole("button", { name: "Install & import" });
    let buttonFocused = false;
    for (let tabs = 0; tabs < 40 && !buttonFocused; tabs += 1) {
      buttonFocused = await install.evaluate((el) => el === document.activeElement);
      if (!buttonFocused) await page.keyboard.press("Tab");
    }
    expect(buttonFocused).toBe(true);
  });

  test("minimum 600px height keeps the workbench controls usable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto(PREVIEW);

    await expect(page.getByRole("textbox", { name: "Search skills.sh" })).toBeVisible();
    await page.getByRole("textbox", { name: "Search skills.sh" }).fill("pdf");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    await expect.poll(() => rootHorizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("discovery cards across nine themes", () => {
  const themes = [
    "moss-neutral",
    "spring-signal",
    "terracotta",
    "codex-light",
    "ocean-cobalt",
    "sakura",
    "aurora",
    "roast",
    "grok-night",
  ];

  for (const theme of themes) {
    test(`theme ${theme} keeps cards legible without horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(PREVIEW);
      await searchOnlineResults(page);

      await page.getByRole("group", { name: "主题切换" }).getByRole("button", { name: theme }).click();

      await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
      await expect(page.getByTestId("assist-skills.sh/community/pdf-tools")).toBeVisible();
      await expect.poll(() => rootHorizontalOverflow(page)).toBeLessThanOrEqual(0);

      // 主题确实生效：卡片边界颜色随主题变化（默认主题 vs grok-night 有差异）。
      const cardBorder = await page
        .getByRole("article")
        .first()
        .evaluate((el) => getComputedStyle(el).borderTopColor);
      test.info().annotations.push({ type: "card-border", description: `${theme}: ${cardBorder}` });
    });
  }

  test("grok-night keeps the full-width three-column layout", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(PREVIEW);
    await searchOnlineResults(page);

    await page
      .getByRole("group", { name: "主题切换" })
      .getByRole("button", { name: "grok-night" })
      .click();
    await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();

    const { contentWidth, columns } = await firstRowGeometry(page, "Search results");
    expect(contentWidth).toBeGreaterThanOrEqual(1180);
    expect(columns).toBe(3);
    await expect.poll(() => rootHorizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("default and grok-night produce different card surface colors", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(PREVIEW);
    await searchOnlineResults(page);

    const readBorder = () =>
      page.getByRole("article").first().evaluate((el) => getComputedStyle(el).borderTopColor);
    const defaultBorder = await readBorder();
    await page
      .getByRole("group", { name: "主题切换" })
      .getByRole("button", { name: "grok-night" })
      .click();
    const nightBorder = await readBorder();
    expect(defaultBorder).not.toBe(nightBorder);
  });
});

test.describe("discovery cards in Simplified Chinese", () => {
  test.use({ locale: "zh-CN" });

  test("renders Chinese card copy and statuses", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(PREVIEW);

    await page.getByRole("textbox", { name: "搜索 skills.sh" }).fill("pdf");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();

    await expect(page.getByText("AI 扩展命中")).toBeVisible();
    await expect(page.getByText("同名 Skill 已在库中")).toBeVisible();
    await expect(page.getByText("不可安装")).toBeVisible();
    await expect(page.getByText("安装次数：42")).toBeVisible();
    await expect(page.getByRole("button", { name: "安装导入" }).first()).toBeVisible();

    await page.getByRole("button", { name: "扫描仓库" }).click();
    await expect(page.getByRole("heading", { name: "PDF Processor" })).toBeVisible();
    await expect(page.getByRole("button", { name: "下载并导入" }).first()).toBeVisible();
  });
});
