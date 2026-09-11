import { expect, test } from "@playwright/test";

/**
 * T4-B 初始化与重新发现预览验收（DEV-only /__preview/onboarding/:scenario）。
 * 只断言公开角色、可访问名称与几何；截图产物走 --output 指定的任务 /tmp 目录。
 * 覆盖：统一步骤条、44px 主操作与稳定底部操作区、长路径与 60+ 条目、
 * 800/1024/1280/1440px、失败重试、恢复冲突决策、慢扫描后台继续、
 * 跳过确认焦点恢复，以及默认主题与 9 主题关键控件。
 */

// 与 zh-CN i18n theme.choices 对应的 9 个主题（名称与顺序锁定于 theme.ts）。
const themeChoices = [
  { name: "moss-neutral", label: "苔藓中性" },
  { name: "spring-signal", label: "春日信号" },
  { name: "terracotta", label: "赤陶" },
  { name: "codex-light", label: "Codex 浅色" },
  { name: "ocean-cobalt", label: "海洋钴蓝" },
  { name: "sakura", label: "樱花" },
  { name: "aurora", label: "极光" },
  { name: "roast", label: "烘焙" },
  { name: "grok-night", label: "Grok 夜色" },
] as const;

const previewWidths = [800, 1024, 1280, 1440] as const;

test.use({ locale: "zh-CN" });

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

async function confirmCompatibility(page: import("@playwright/test").Page) {
  await page
    .getByRole("checkbox", { name: "我确认这里只识别 Agent，不会部署技能" })
    .click();
  await page.getByRole("button", { name: "识别 Agent" }).click();
}

/** 到达扫描步骤（第 3 步），供长列表与底部操作区断言使用。 */
async function reachScanStep(page: import("@playwright/test").Page, scenario: string) {
  await page.goto(`/__preview/onboarding/${scenario}`);
  await page.getByRole("checkbox", { name: "我确认只执行只读发现和扫描" }).click();
  await page.getByRole("button", { name: "继续" }).click();
  // 重新发现流程里第 1 步与第 2 步共用同一条确认状态：进入兼容性步骤时
  // 确认框已经是勾选状态，直接识别 Agent。
  await page.getByRole("button", { name: "识别 Agent" }).click();
  await page.getByRole("checkbox", { name: "Codex", exact: true }).click();
  await page.getByRole("checkbox", { name: "我确认所选目标只用于只读扫描，不会部署技能" }).click();
  await page.getByRole("button", { name: "继续" }).click();
  await page.getByRole("button", { name: "开始只读扫描" }).click();
  await expect(page.getByRole("heading", { name: "扫描预览" })).toBeVisible();
}

test("exposes the unified step rail and keeps the primary action at 44px with a stable footer", async ({ page }) => {
  await page.goto("/__preview/onboarding/create");

  const rail = page.getByRole("list", { name: "初始化步骤" });
  await expect(rail.getByRole("listitem")).toHaveCount(3);
  await expect(rail.getByRole("listitem").nth(0)).toHaveAttribute("aria-current", "step");
  await expect(rail.getByRole("listitem").nth(0)).toContainText("确认集中库位置");
  await expect(rail.getByRole("listitem").nth(1)).toContainText("识别兼容的 Agent");
  await expect(rail.getByRole("listitem").nth(2)).toContainText("扫描已有技能");

  const primary = page.getByRole("button", { name: "继续" });
  const initialBox = (await primary.boundingBox())!;
  expect(initialBox.height).toBeGreaterThanOrEqual(44);
  const footerBox = (await page.locator("main footer").boundingBox())!;

  await primary.click();
  const railAfter = page.getByRole("list", { name: "初始化步骤" });
  await expect(railAfter.getByRole("listitem").nth(0)).toContainText("已完成");
  await expect(railAfter.getByRole("listitem").nth(1)).toHaveAttribute("aria-current", "step");

  // 到达最后一步后，底部操作区整体边缘保持稳定（主操作区内、不跳动）。
  await confirmCompatibility(page);
  await page.getByRole("checkbox", { name: "Codex", exact: true }).click();
  await page.getByRole("checkbox", { name: "我确认所选目标只用于只读扫描，不会部署技能" }).click();
  await page.getByRole("button", { name: "继续" }).click();
  const finish = page.getByRole("button", { name: "完成初始化" });
  await expect(finish).toBeVisible();
  const finishBox = (await finish.boundingBox())!;
  expect(finishBox.height).toBeGreaterThanOrEqual(44);
  const lastFooterBox = (await page.locator("main footer").boundingBox())!;
  expect(Math.abs(lastFooterBox.x - footerBox.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(lastFooterBox.width - footerBox.width)).toBeLessThanOrEqual(2);
});

test("rediscovery retries discovery and scan failures without losing library state", async ({ page }) => {
  await page.goto("/__preview/onboarding/rescan-failures");

  await page.getByRole("checkbox", { name: "我确认只执行只读发现和扫描" }).click();
  await page.getByRole("button", { name: "继续" }).click();
  // 同上：确认状态带入兼容性步骤，直接识别 Agent 触发首次失败。
  await page.getByRole("button", { name: "识别 Agent" }).click();

  await expect(page.getByRole("alert")).toContainText("preview.discovery_failed");
  await expect(page.getByText("D:\\very-long-library-root-segment")).toBeVisible();

  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("checkbox", { name: "Codex", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByRole("checkbox", { name: "Codex", exact: true }).click();
  await page.getByRole("checkbox", { name: "我确认所选目标只用于只读扫描，不会部署技能" }).click();
  await page.getByRole("button", { name: "继续" }).click();
  await page.getByRole("button", { name: "开始只读扫描" }).click();

  await expect(page.getByRole("alert")).toContainText("preview.scan_failed");
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("heading", { name: "扫描预览" })).toBeVisible();
  await expect(page.getByText("发现 60 个 Skill")).toBeVisible();
});

test("keeps 60 discovered entries in an internal scroll without page overflow at 800px", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await reachScanStep(page, "rescan");

  await expectNoRootHorizontalOverflow(page, "rescan@800");

  const scroll = await page.evaluate(() => {
    const preview = document.querySelector('[aria-labelledby="scan-preview-title"]');
    if (!preview) return null;
    return { scrollHeight: preview.scrollHeight, clientHeight: preview.clientHeight };
  });
  expect(scroll).not.toBeNull();
  expect(scroll!.scrollHeight).toBeGreaterThan(scroll!.clientHeight);

  // 底部操作区是 sticky 的：长列表滚动时操作区钉在可视区底部。
  const footerPosition = await page.locator("main footer").evaluate((footer) => getComputedStyle(footer).position);
  expect(footerPosition, "the bottom action area must stay pinned while content scrolls").toBe("sticky");

  // 底部操作区的主操作不被遮挡：滚动到底后命中测试仍指向按钮自身。
  const complete = page.getByRole("button", { name: "完成重新扫描" });
  await complete.scrollIntoViewIfNeeded();
  await complete.focus();
  const covered = await page.evaluate(() => {
    const focused = document.activeElement as HTMLElement | null;
    if (!focused) return true;
    const rect = focused.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !(hit === focused || focused.contains(hit));
  });
  expect(covered, "the sticky action area must not cover the focused primary action").toBe(false);
});

test("first-run restore requires an explicit conflict decision and then completes", async ({ page }) => {
  await page.goto("/__preview/onboarding/restore");

  await page.getByRole("button", { name: "选择备份目录" }).click();
  await expect(page.getByText("发现 2 个可恢复技能")).toBeVisible();

  const restore = page.getByRole("button", { name: "恢复并继续" });
  await expect(restore).toBeDisabled();

  await page.getByLabel("preview-skill 的处理方式").selectOption("overwrite");
  await expect(restore).toBeEnabled();
  await restore.click();

  await expect(page.getByRole("heading", { name: "初始化已完成" })).toBeVisible();
  await expect(page.getByRole("button", { name: "进入主界面" })).toBeVisible();
});

test("offers the background hand-off while a scan keeps running and finishes honestly", async ({ page }) => {
  await page.goto("/__preview/onboarding/slow-scan");

  await page.getByRole("button", { name: "继续" }).click();
  await confirmCompatibility(page);
  await page.getByRole("checkbox", { name: "Codex", exact: true }).click();
  await page.getByRole("checkbox", { name: "我确认所选目标只用于只读扫描，不会部署技能" }).click();
  await page.getByRole("button", { name: "继续" }).click();
  await page.getByRole("button", { name: "开始只读扫描" }).click();

  const background = page.getByRole("button", { name: "转入后台，继续完成初始化" });
  await expect(background).toBeVisible({ timeout: 5_000 });
  await background.click();
  await expect(page.getByRole("status")).toContainText("扫描已转入后台");

  await page.getByRole("button", { name: "完成初始化" }).click();
  await expect(page.getByRole("heading", { name: "初始化已完成" })).toBeVisible();
  await expect(page.getByText("扫描仍在后台进行，完成后可在发现中查看预览。")).toBeVisible();
});

test("returns focus to the skip trigger after the confirmation dialog is dismissed", async ({ page }) => {
  await page.goto("/__preview/onboarding/create");

  await page.getByRole("button", { name: "跳过初始化" }).click();
  await expect(page.getByRole("heading", { name: "将创建空集中库" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "跳过初始化" })).toBeFocused();
});

test("keeps initialization unavailable without a library path", async ({ page }) => {
  await page.goto("/__preview/onboarding/unavailable");

  await expect(page.getByText("无法确认默认集中库位置")).toBeVisible();
  await expect(page.getByRole("button", { name: "跳过初始化" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "继续" })).toBeDisabled();
});

test.describe("onboarding flows stay free of horizontal overflow", () => {
  for (const width of previewWidths) {
    test(`create flow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/onboarding/create");
      await expectNoRootHorizontalOverflow(page, `create@${width}`);
    });

    test(`rediscovery at ${width}px with a long library path`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/onboarding/rescan");
      await expectNoRootHorizontalOverflow(page, `rescan@${width}`);
    });
  }
});

test("keeps the rediscovery layout usable at the 600px minimum height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await reachScanStep(page, "rescan");

  await expectNoRootHorizontalOverflow(page, "rescan@1280x600");
  const complete = page.getByRole("button", { name: "完成重新扫描" });
  await complete.scrollIntoViewIfNeeded();
  await expect(complete).toBeInViewport();
});

test("applies all nine themes on the flow with key controls intact at 1280x900", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/onboarding/create");

  for (const theme of themeChoices) {
    await page.getByRole("button", { name: theme.label }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.name);

    // 关键控件与无横溢。
    await expect(page.getByRole("list", { name: "初始化步骤" })).toBeVisible();
    await expect(page.getByRole("button", { name: "继续" })).toBeVisible();
    await expectNoRootHorizontalOverflow(page, `theme ${theme.name}@1280`);

    // 焦点在任意主题下保持可见。
    await page.keyboard.press("Tab");
    const focusVisible = await page.evaluate(() => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !focused.checkVisibility()) return false;
      const style = getComputedStyle(focused);
      return style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    });
    expect(focusVisible, `focus must stay visible under ${theme.name}`).toBe(true);

    // 状态呈现（不可用状态 + 错误按钮禁用）在任意主题下可读且不横溢。
    await page.goto("/__preview/onboarding/unavailable");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.name);
    await expect(page.getByText("无法确认默认集中库位置")).toBeVisible();
    await expect(page.getByRole("button", { name: "跳过初始化" })).toBeDisabled();
    await expectNoRootHorizontalOverflow(page, `theme ${theme.name} unavailable@1280`);

    await page.goto("/__preview/onboarding/create");
  }
});

test("keeps the grok-night theme usable across the full width sweep", async ({ page }) => {
  await page.goto("/__preview/onboarding/create");
  await page.getByRole("button", { name: "Grok 夜色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "grok-night");

  for (const width of previewWidths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("list", { name: "初始化步骤" })).toBeVisible();
    await expect(page.getByRole("button", { name: "继续" })).toBeVisible();
    await expectNoRootHorizontalOverflow(page, `grok-night@${width}`);
  }
});

test("keeps keyboard focus visible on the default theme and grok-night", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__preview/onboarding/create");

  for (const theme of ["moss-neutral", "grok-night"] as const) {
    if (theme === "grok-night") {
      await page.getByRole("button", { name: "Grok 夜色" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "grok-night");
    }

    await page.keyboard.press("Tab");
    const focusVisible = await page.evaluate(() => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !focused.checkVisibility()) return false;
      const style = getComputedStyle(focused);
      return style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    });
    expect(focusVisible, `focus must stay visible under ${theme}`).toBe(true);
  }
});
