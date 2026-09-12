import { expect, test } from "@playwright/test";

/**
 * T4-C 导入流程预览验收（DEV-only /__preview/import-wizard）。
 * 只断言公开角色、可访问名称与几何；截图产物走 --output 指定的任务 /tmp 目录。
 * 覆盖：统一步骤条、44px 主操作与稳定底部操作区（几何命中验证）、
 * 60+ 条目与长路径、800/1024/1280/1440px 与 600px 最小高度、
 * 失败/取消/冲突/恢复路径、onboarding 变体、默认主题与 9 主题关键控件。
 */

const PREVIEW = "/__preview/import-wizard";
const previewWidths = [800, 1024, 1280, 1440] as const;

// 与 zh-CN i18n theme.choices 对应的 9 个主题（名称与顺序锁定于 theme.ts）。
const themeChoices = [
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

test.use({ locale: "zh-CN" });

function wizard(page: import("@playwright/test").Page) {
  return page.getByRole("region", { name: "导入 Skill" });
}

function stepRail(page: import("@playwright/test").Page) {
  return page.getByRole("list", { name: "导入步骤" });
}

function footerOf(page: import("@playwright/test").Page) {
  return wizard(page).locator("footer");
}

async function expectNoRootHorizontalOverflow(page: import("@playwright/test").Page, label: string) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `${label}: scrollWidth (${overflow.scrollWidth}) must not exceed clientWidth (${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

async function expectFocusVisible(page: import("@playwright/test").Page, label: string) {
  await page.keyboard.press("Tab");
  const focusVisible = await page.evaluate(() => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !focused.checkVisibility()) return false;
    const style = getComputedStyle(focused);
    return style.outlineStyle !== "none" && style.outlineWidth !== "0px";
  });
  expect(focusVisible, `${label}: keyboard focus must stay visible`).toBe(true);
}

/** 聚焦元素必须可见且不被操作区遮挡：命中测试仍指向元素自身。 */
async function expectNotCovered(page: import("@playwright/test").Page, label: string) {
  const covered = await page.evaluate(() => {
    const focused = document.activeElement as HTMLElement | null;
    if (!focused) return true;
    const rect = focused.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !(hit === focused || focused.contains(hit));
  });
  expect(covered, `${label}: the focused element must not be covered`).toBe(false);
}

async function parseSource(page: import("@playwright/test").Page, source = "C:/skills/preview") {
  await page.getByRole("textbox", { name: "来源" }).fill(source);
  await page.getByRole("button", { name: "解析来源" }).click();
  await page.getByRole("button", { name: "继续选择候选" }).click();
  await expect(page.getByRole("button", { name: "分析冲突" })).toBeVisible();
}

test("keeps the step rail, 44px primary actions and one stable footer across the whole flow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PREVIEW);

  const rail = stepRail(page);
  await expect(rail.getByRole("listitem")).toHaveCount(4);
  await expect(rail.getByRole("listitem").nth(0)).toHaveAttribute("aria-current", "step");
  await expect(rail.getByRole("listitem").nth(0)).toContainText("选择来源");

  const parse = page.getByRole("button", { name: "解析来源" });
  await expect(parse).toBeInViewport();
  expect((await parse.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const footerBox = (await footerOf(page).boundingBox())!;
  expect(footerBox.height).toBeGreaterThan(0);

  await page.getByRole("textbox", { name: "来源" }).fill("C:/skills/preview");
  await parse.click();

  // 门槛页仍是来源步骤（选择来源 → 审阅候选门槛）。
  await expect(rail.getByRole("listitem").nth(0)).toHaveAttribute("aria-current", "step");
  const gateContinue = page.getByRole("button", { name: "继续选择候选" });
  expect((await gateContinue.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const gateFooterBox = (await footerOf(page).boundingBox())!;
  expect(Math.abs(gateFooterBox.x - footerBox.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(gateFooterBox.width - footerBox.width)).toBeLessThanOrEqual(2);
  await gateContinue.click();

  // 进入候选审阅：步骤 1 完成、步骤 2 当前，主操作仍在同一操作区。
  await expect(rail.getByRole("listitem").nth(0)).toContainText("已完成");
  await expect(rail.getByRole("listitem").nth(1)).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("button", { name: "分析冲突" })).toBeVisible();
  const candidatesFooterBox = (await footerOf(page).boundingBox())!;
  expect(Math.abs(candidatesFooterBox.x - footerBox.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(candidatesFooterBox.width - footerBox.width)).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "全选可导入候选" }).click();
  await page.getByRole("button", { name: "分析冲突" }).click();
  const commit = page.getByRole("button", { name: "提交导入" });
  await expect(commit).toBeVisible();
  expect((await commit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const conflictsFooterBox = (await footerOf(page).boundingBox())!;
  expect(Math.abs(conflictsFooterBox.x - footerBox.x)).toBeLessThanOrEqual(2);

  await commit.click();
  const openLibrary = page.getByRole("button", { name: "打开 Skill 库" });
  await expect(openLibrary).toBeVisible();
  expect((await openLibrary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const summaryFooterBox = (await footerOf(page).boundingBox())!;
  expect(Math.abs(summaryFooterBox.x - footerBox.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(summaryFooterBox.width - footerBox.width)).toBeLessThanOrEqual(2);
  await expect(rail.getByRole("listitem").nth(3)).toHaveAttribute("aria-current", "step");
});

test("keeps 60+ candidates usable with an internal scroll and an unobstructed action area at 800px", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(`${PREVIEW}?scenario=bulk`);
  await parseSource(page);

  // 60+ 条目全部可访问；主列表在面板内滚动，根级无横向溢出。
  const checkboxes = page.getByRole("checkbox", { name: /Preview Skill \d+/ });
  await expect(checkboxes).toHaveCount(60);
  await expectNoRootHorizontalOverflow(page, "bulk@800");

  const lastItem = checkboxes.nth(59);
  await lastItem.scrollIntoViewIfNeeded();
  await expect(lastItem).toBeInViewport();
  await lastItem.check();
  await expect(lastItem).toBeChecked();
  await expectNotCovered(page, "bulk last item");

  // 内容在主内容区内部滚动：main 自身不产生页面级滚动。
  const mainScroll = await page.getByRole("main").evaluate((main) => ({
    scrollHeight: main.scrollHeight,
    clientHeight: main.clientHeight,
  }));
  expect(mainScroll.scrollHeight).toBeLessThanOrEqual(mainScroll.clientHeight);

  // 滚动到列表底部后，底部主操作仍完整可见且不被遮挡。
  const analyze = page.getByRole("button", { name: "分析冲突" });
  await expect(analyze).toBeInViewport();
  await analyze.focus();
  await expectNotCovered(page, "bulk footer primary");

  // 全部候选可一次全选并继续分析。
  await page.getByRole("button", { name: "全选可导入候选" }).click();
  await analyze.click();
  await expect(page.getByRole("button", { name: "提交导入" })).toBeVisible();
});

test("keeps the bulk list usable at the 600px minimum height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`${PREVIEW}?scenario=bulk`);
  await parseSource(page);

  await expectNoRootHorizontalOverflow(page, "bulk@1280x600");
  const lastItem = page.getByRole("checkbox", { name: "Preview Skill 60" });
  await lastItem.scrollIntoViewIfNeeded();
  await expect(lastItem).toBeInViewport();
  const analyze = page.getByRole("button", { name: "分析冲突" });
  await expect(analyze).toBeInViewport();
  await analyze.focus();
  await expectNotCovered(page, "bulk@600 footer primary");
});

test("wraps very long Windows paths without horizontal overflow at 800px", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(PREVIEW);
  const longPath = "C:\\very-long-library-root-segment\\second-segment\\third-segment\\incoming-skills\\with-nested-directories\\pdf-tools-bundle";
  await page.getByRole("textbox", { name: "来源" }).fill(longPath);
  await expectNoRootHorizontalOverflow(page, "long source path@800");

  await page.getByRole("button", { name: "解析来源" }).click();
  await page.getByRole("button", { name: "继续选择候选" }).click();
  await expect(page.getByRole("checkbox", { name: /PDF/ }).first()).toBeVisible();
  await expectNoRootHorizontalOverflow(page, "long candidate paths@800");
});

test("keeps the onboarding variant to scanned sources with the acquire action in the footer", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(`${PREVIEW}?scenario=onboarding`);

  // onboarding 变体：不提供"添加到已选来源"；主操作直接读取已选目录。
  await page.getByRole("textbox", { name: "来源" }).fill("C:/windsurf/skills");
  await expect(page.getByRole("button", { name: "添加到已选来源" })).toHaveCount(0);

  const acquire = page.getByRole("button", { name: "读取已选目录候选" });
  expect((await acquire.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await acquire.click();
  await expect(page.getByText("已从 2 个来源目录获取候选")).toBeVisible();
  await page.getByRole("button", { name: "继续选择候选" }).click();
  await expect(page.getByRole("checkbox", { name: /PDF/ }).first()).toBeVisible();
});

test("surfaces per-source acquisition failures in the scan gate and recovers through the gate retry", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${PREVIEW}?scenario=fail-acquire`);

  await page.getByRole("textbox", { name: "来源" }).fill("C:/skills/preview");
  await page.getByRole("button", { name: "解析来源" }).click();

  // M-29：单目录获取失败进入多来源门槛页——失败原因、按目录重试与移除可见，
  // 门槛保持诚实（0 个候选不放行），不再呈现全局 alert。
  await expect(page.getByText("已从 0 个来源目录获取候选")).toBeVisible();
  await expect(page.getByText(/C:\/skills\/preview：导入步骤未能完成（preview\.acquire_failed）。/)).toBeVisible();
  const retry = page.getByRole("button", { name: "重新扫描 C:/skills/preview" });
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const remove = page.getByRole("button", { name: "移除来源 C:/skills/preview" });
  expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("button", { name: "继续选择候选" })).toBeDisabled();

  // 恢复路径：重试扫描只重读该目录，失败行消失并恢复为候选计数。
  await retry.click();
  await expect(page.getByText("已从 1 个来源目录获取候选")).toBeVisible();
  await expect(page.getByText(/C:\/skills\/preview：2 个候选/)).toBeVisible();
  await expect(page.getByText(/导入步骤未能完成（preview\.acquire_failed）。/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "继续选择候选" })).toBeEnabled();
});

test("returns cancelled acquisitions to a reusable source step", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${PREVIEW}?scenario=cancel`);

  await page.getByRole("textbox", { name: "来源" }).fill("C:/skills/preview");
  await page.getByRole("button", { name: "解析来源" }).click();

  const cancel = page.getByRole("button", { name: "取消获取" });
  await expect(cancel).toBeInViewport();
  await cancel.click();

  await expect(page.getByText("获取已取消，来源内容仍然保留。")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const retry = page.getByRole("button", { name: "重试获取" });
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("textbox", { name: "来源" })).toHaveValue("C:/skills/preview");
});

test("requires an explicit conflict decision before the footer commit unlocks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${PREVIEW}?scenario=conflict`);
  await parseSource(page);

  await page.getByRole("button", { name: "全选可导入候选" }).click();
  await page.getByRole("button", { name: "分析冲突" }).click();

  const commit = page.getByRole("button", { name: "提交导入" });
  await expect(commit).toBeDisabled();
  await page.getByRole("radio", { name: "独立导入" }).click();
  await expect(commit).toBeEnabled();
  await commit.click();
  await expect(page.getByRole("button", { name: "打开 Skill 库" })).toBeVisible();
});

test.describe("the import flow stays free of horizontal overflow", () => {
  for (const width of previewWidths) {
    test(`default flow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PREVIEW);
      await expect(stepRail(page)).toBeVisible();
      await expectNoRootHorizontalOverflow(page, `default@${width}`);
    });

    test(`bulk flow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${PREVIEW}?scenario=bulk`);
      await parseSource(page);
      await expectNoRootHorizontalOverflow(page, `bulk@${width}`);
      await expect(page.getByRole("button", { name: "分析冲突" })).toBeInViewport();
    });
  }
});

test.describe("theme contract", () => {
  for (const theme of themeChoices) {
    test(`keeps the import flow usable under ${theme} at 1280x900`, async ({ page }) => {
      await page.addInitScript(([value]) => {
        window.localStorage.setItem("skillhub.appearance", value!);
      }, [theme]);
      await page.setViewportSize({ width: 1280, height: 900 });

      await page.goto(PREVIEW);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(stepRail(page)).toBeVisible();
      await expect(page.getByRole("button", { name: "解析来源" })).toBeVisible();
      await expectNoRootHorizontalOverflow(page, `theme ${theme}@1280`);
      await expectFocusVisible(page, theme);

      // 失败状态（门槛页失败行 + 行内重试/移除操作）在任意主题下可读且不横溢。
      await page.goto(`${PREVIEW}?scenario=fail-acquire`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.getByRole("textbox", { name: "来源" }).fill("C:/skills/preview");
      await page.getByRole("button", { name: "解析来源" }).click();
      await expect(page.getByText(/C:\/skills\/preview：导入步骤未能完成（preview\.acquire_failed）。/)).toBeVisible();
      await expect(page.getByRole("button", { name: "重新扫描 C:/skills/preview" })).toBeVisible();
      await expectNoRootHorizontalOverflow(page, `theme ${theme} failure@1280`);
    });
  }

  test("keeps the grok-night theme usable across the full width sweep", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("skillhub.appearance", "grok-night");
    });

    for (const width of previewWidths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PREVIEW);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "grok-night");
      await expect(stepRail(page)).toBeVisible();
      await expect(page.getByRole("button", { name: "解析来源" })).toBeVisible();
      await expectNoRootHorizontalOverflow(page, `grok-night@${width}`);
    }
  });
});

test("keeps keyboard focus visible on the default theme and grok-night", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PREVIEW);
  await expectFocusVisible(page, "default theme");

  await page.evaluate(() => {
    window.localStorage.setItem("skillhub.appearance", "grok-night");
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "grok-night");
  await expectFocusVisible(page, "grok-night");
});
