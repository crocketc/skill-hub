import { expect, test } from "./fixtures";

/**
 * DEV-108（含 DEV-102）：Agent 卡片固定信息区域与派发能力小图标。
 * 只断言公开 DOM 的几何与计算样式：品牌/类型/角色在顶部、路径状态在中部、
 * 派发方式在底部；共享品牌 Logo 区可换行且卡片不横向溢出；三种能力图标
 * 缩小、无边框，以绿/红表达支持/不支持，推荐态保留轻量标记；文字提示与
 * 无障碍名称仍明确说明状态。
 */

test("agent cards keep stable regions, wrapped shared logos, and borderless status icons", async ({ page }) => {
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

  // 三种派发方式图标：无边框、尺寸收敛。
  const icons = page.locator(".sh-agent-card__deployment-method");
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

  // 推荐态保留轻量标记（浅成功色底），不回退为强边框。
  const recommended = page.locator(".sh-agent-card__deployment-method.is-recommended").first();
  await expect(recommended).toBeVisible();
  const recommendedBackground = await recommended.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(recommendedBackground).not.toBe("rgba(0, 0, 0, 0)");
  const recommendedBorder = await recommended.evaluate((element) => getComputedStyle(element).borderStyle);
  expect(recommendedBorder).toBe("none");

  // 文字提示与无障碍名称仍明确说明状态，且支持/不支持的说法可区分。
  const supportedLabel = await supported.getAttribute("aria-label");
  const unsupportedLabel = await unsupported.getAttribute("aria-label");
  expect(supportedLabel).toBeTruthy();
  expect(unsupportedLabel).toBeTruthy();
  expect(supportedLabel).not.toBe(unsupportedLabel);
  expect(await supported.getAttribute("title")).toBe(supportedLabel);

  // 固定区域：品牌/类型/角色在顶部，路径状态在中部，派发方式在底部。
  const card = cards.first();
  const headBox = (await card.locator(".sh-agent-card__head").boundingBox())!;
  const pathsBox = (await card.locator(".sh-agent-card__paths").boundingBox())!;
  const methodsBox = (await card.locator(".sh-agent-card__deployment-methods").boundingBox())!;
  expect(headBox.y).toBeLessThan(pathsBox.y);
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
