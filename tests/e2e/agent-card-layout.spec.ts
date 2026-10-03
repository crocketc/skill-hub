import { expect, test } from "./fixtures";

/**
 * DEV-110：Agent 卡片角色、尺寸和复制/链接能力在各呈现入口统一。
 * 只断言公开 DOM 的几何与计算样式：品牌/类型/状态、目录角色、路径和
 * 底部能力行位置稳定；共享品牌在预留区域内右对齐换行；两个能力图标只
 * 用绿/红表达支持状态，悬浮和无障碍名称使用用户认可的文字。
 */

test("agent cards keep stable regions, wrapped shared logos, and two transparent capability icons", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.goto("/__preview/agents");

  const cards = page.getByTestId("agent-card");
  await expect(cards.first()).toBeVisible();

  // DEV-102：共享品牌 Logo 区在空间不足时换行；任何卡片都不横向溢出。
  const sharedBrands = page.locator(".sh-agent-presentation__shared-brands").first();
  await expect(sharedBrands).toBeVisible();
  await expect(sharedBrands).toHaveCSS("flex-wrap", "wrap");
  const overflowDeltas = await cards.evaluateAll((elements) =>
    elements.map((element) => element.scrollWidth - element.clientWidth),
  );
  for (const delta of overflowDeltas) {
    expect(delta).toBeLessThanOrEqual(1);
  }

  // 复制和链接图标：只有两项、无底色，尺寸收敛。
  const card = cards.first();
  const icons = card.locator(".sh-agent-card__deployment-method");
  await expect(icons).toHaveCount(2);
  const firstIcon = icons.first();
  await expect(firstIcon).toBeVisible();
  await expect(firstIcon).toHaveCSS("border-style", "none");
  const iconBox = await firstIcon.boundingBox();
  expect(iconBox).not.toBeNull();
  expect(iconBox!.width).toBeLessThanOrEqual(20);
  expect(iconBox!.height).toBeLessThanOrEqual(20);

  // 红/绿表达支持情况：支持与不支持的颜色必须可区分。
  const supported = page.locator(".sh-agent-card__deployment-method.is-supported").first();
  const unsupported = page.locator(".sh-agent-card__deployment-method.is-unsupported").first();
  await expect(supported).toBeVisible();
  await expect(unsupported).toBeVisible();
  const supportedColor = await supported.evaluate((element) => getComputedStyle(element).color);
  const unsupportedColor = await unsupported.evaluate((element) => getComputedStyle(element).color);
  expect(supportedColor).not.toBe(unsupportedColor);
  const unverified = page.locator(".sh-agent-card__deployment-method.is-unverified").first();
  await expect(unverified).toBeVisible();
  const unverifiedColor = await unverified.evaluate((element) => getComputedStyle(element).color);
  expect(unverifiedColor).not.toBe(supportedColor);
  expect(unverifiedColor).not.toBe(unsupportedColor);
  await expect(unverified).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.screenshot({ path: test.info().outputPath("traffic-light-cards.png"), fullPage: true });

  const iconBackground = await firstIcon.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(iconBackground).toBe("rgba(0, 0, 0, 0)");

  // 文字提示与无障碍名称仍明确说明状态，且支持/不支持的说法可区分。
  const supportedLabel = await supported.getAttribute("aria-label");
  const unsupportedLabel = await unsupported.getAttribute("aria-label");
  expect(supportedLabel).toBeTruthy();
  expect(unsupportedLabel).toBeTruthy();
  expect(supportedLabel).not.toBe(unsupportedLabel);
  expect(await supported.getAttribute("title")).toBe(supportedLabel);
  expect([
    "支持复制导入",
    "支持链接导入",
    "Copy import supported",
    "Link import supported",
  ]).toContain(supportedLabel);
  expect([
    "不支持复制导入",
    "不支持链接导入",
    "Copy import unavailable",
    "Link import unavailable",
  ]).toContain(unsupportedLabel);

  // 固定区域：品牌/类型在顶部，其下是角色、Skill 路径和底部方法行。
  const headBox = (await card.locator(".sh-agent-card__head").boundingBox())!;
  const roleBox = (await card.locator(".sh-agent-card__role-line").boundingBox())!;
  const pathsBox = (await card.locator(".sh-agent-card__paths").boundingBox())!;
  const methodsBox = (await card.locator(".sh-agent-card__deployment-methods").boundingBox())!;
  expect(Math.round((await card.boundingBox())!.height)).toBe(176);
  expect(headBox.y).toBeLessThan(roleBox.y);
  expect(roleBox.y).toBeLessThan(pathsBox.y);
  expect(pathsBox.y).toBeLessThan(methodsBox.y);

  // 同一行的卡片：派发方式行起点一致（底部区域对齐），且窄卡可读。
  const firstCardBox = (await cards.nth(0).boundingBox())!;
  const methodsBoxes = await cards.evaluateAll((elements) => {
    const firstTop = elements[0]!.getBoundingClientRect().top;
    const row = elements.filter((element) => Math.abs(element.getBoundingClientRect().top - firstTop) < 2);
    return row.map((element) => {
      const methods = element.querySelector(".sh-agent-card__deployment-methods");
      return methods ? methods.getBoundingClientRect().top : Number.NaN;
    });
  });
  const aligned = methodsBoxes.every((top) => Math.abs(top - methodsBoxes[0]!) < 2);
  expect(aligned).toBe(true);
  expect(firstCardBox.width).toBeGreaterThan(240);
});

test("path frames center readable text and keep the shared-directory chip border inside its row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/__preview/agents");

  const openAiCard = page.locator(
    '.sh-agent-card:has(.sh-agent-presentation[aria-label^="OpenAI"])',
  );
  await expect(openAiCard).toBeVisible();
  await expect(openAiCard.locator(".sh-agent-card__shared-chip")).toBeVisible();
  await expect.soft(openAiCard.locator(".sh-agent-card__path")).toHaveAttribute(
    "title",
    "C:\\Users\\Developer\\AppData\\Local\\SkillHub\\agents\\codex\\skills",
  );
  const pendingPath = page.locator(".sh-agent-card__path--pending_creation");
  await expect(pendingPath).toHaveAttribute("title", /.+/);
  await expect(page.locator(".sh-agent-card .sh-agent-directory-role-badge--builtin").first()).toBeVisible();

  const measure = () => openAiCard.evaluate((card) => {
    const label = card.querySelector(".sh-agent-card__paths-label")!;
    const chip = card.querySelector(".sh-agent-card__shared-chip")!;
    const list = card.querySelector(".sh-agent-card__path-list")!;
    const path = card.querySelector(".sh-agent-card__path")!;
    const range = document.createRange();
    range.selectNodeContents(path);
    const labelRect = label.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const pathRect = path.getBoundingClientRect();
    const textRect = range.getBoundingClientRect();
    return {
      chipBottom: chipRect.bottom,
      chipTop: chipRect.top,
      labelBottom: labelRect.bottom,
      labelTop: labelRect.top,
      listBottom: listRect.bottom,
      pathBottom: pathRect.bottom,
      pathCenter: (pathRect.top + pathRect.bottom) / 2,
      pathTop: pathRect.top,
      textCenter: (textRect.top + textRect.bottom) / 2,
    };
  });

  const wide = await measure();
  expect.soft(wide.chipTop).toBeGreaterThanOrEqual(wide.labelTop);
  expect.soft(wide.chipBottom).toBeLessThanOrEqual(wide.labelBottom);
  expect.soft(wide.pathBottom).toBeLessThanOrEqual(wide.listBottom);
  expect.soft(Math.abs(wide.textCenter - wide.pathCenter)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("agent-paths-wide.png"), fullPage: true });

  await page.setViewportSize({ width: 560, height: 1000 });
  const narrow = await measure();
  expect.soft(narrow.chipTop).toBeGreaterThanOrEqual(narrow.labelTop);
  expect.soft(narrow.chipBottom).toBeLessThanOrEqual(narrow.labelBottom);
  expect.soft(narrow.pathBottom).toBeLessThanOrEqual(narrow.listBottom);
  expect.soft(Math.abs(narrow.textCenter - narrow.pathCenter)).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(0);
  const cursorPath = page.locator('.sh-agent-card:has(.sh-agent-presentation[aria-label^="Cursor"]) .sh-agent-card__path');
  await expect(cursorPath).toHaveAttribute("title", /D:\\Very\\Long\\Windows/);
  const longPathGeometry = await cursorPath.evaluate((element) => {
    const text = element.querySelector(".sh-agent-card__path-text")!;
    const range = document.createRange();
    range.selectNodeContents(text);
    return { frameWidth: element.clientWidth, textWidth: range.getBoundingClientRect().width };
  });
  expect(longPathGeometry.textWidth).toBeGreaterThan(longPathGeometry.frameWidth);
  const pendingGeometry = await pendingPath.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const frame = element.getBoundingClientRect();
    const text = range.getBoundingClientRect();
    return { frameCenter: (frame.top + frame.bottom) / 2, textCenter: (text.top + text.bottom) / 2 };
  });
  expect.soft(Math.abs(pendingGeometry.textCenter - pendingGeometry.frameCenter)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("agent-paths-narrow.png"), fullPage: true });

  await page.evaluate(() => window.localStorage.setItem("skillhub.appearance", "grok-night"));
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dark = await measure();
  expect.soft(dark.chipTop).toBeGreaterThanOrEqual(dark.labelTop);
  expect.soft(dark.chipBottom).toBeLessThanOrEqual(dark.labelBottom);
  expect.soft(dark.pathBottom).toBeLessThanOrEqual(dark.listBottom);
  expect.soft(Math.abs(dark.textCenter - dark.pathCenter)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("agent-paths-grok-night.png"), fullPage: true });
});
