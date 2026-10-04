import { expect, test } from "@playwright/test";

test("drawer review prototype stays isolated and fits a compact desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review");

  const drawer = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveClass(/sh-skill-drawer--prototype/);
  await page.waitForFunction(() => {
    const panel = document.querySelector(".sh-skill-drawer--prototype");
    return panel !== null && panel.getAnimations().every((animation) => animation.playState === "finished");
  });

  const geometry = await drawer.evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    const chrome = panel.querySelector<HTMLElement>(".sh-skill-drawer__chrome");
    const body = panel.querySelector<HTMLElement>(".sh-skill-drawer__scroll");
    return {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      radius: Number.parseFloat(getComputedStyle(panel).borderTopLeftRadius),
      bodyHeight: body?.getBoundingClientRect().height ?? 0,
      headerHeight: chrome?.getBoundingClientRect().height ?? 0,
      right: rect.right,
      top: rect.top,
    };
  });

  expect(geometry.left).toBeGreaterThanOrEqual(8);
  expect(geometry.top).toBeGreaterThanOrEqual(8);
  expect(geometry.right).toBeLessThanOrEqual(742);
  expect(geometry.bottom).toBeLessThanOrEqual(711);
  expect(geometry.radius).toBeGreaterThanOrEqual(12);
  expect(geometry.bodyHeight).toBeGreaterThan(geometry.height * 0.6);
  expect(geometry.headerHeight).toBeLessThan(geometry.height * 0.4);

  await expect(drawer.locator(".sh-skill-drawer__pinned-title h2")).toHaveText("PDF Reader");
  const prototypeActions = drawer.locator(".sh-skill-drawer__prototype-actions");
  const actionButtons = prototypeActions.locator("button[data-prototype-action]");
  await expect(actionButtons).toHaveCount(3);
  for (const button of await actionButtons.all()) {
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).not.toBeEmpty();
  }
  const actionDescription = await actionButtons.first().getAttribute("aria-describedby");
  expect(actionDescription).toBeTruthy();
  await expect(drawer.locator(`[id="${actionDescription}"]`)).not.toBeEmpty();
  const widthCycle = drawer.locator(".sh-skill-drawer__prototype-presets button");
  await expect(widthCycle).toHaveCount(1);
  const initialWidthLabel = await widthCycle.getAttribute("aria-label");
  expect(initialWidthLabel?.trim().length).toBeGreaterThan(0);
  await widthCycle.click();
  await expect(widthCycle).not.toHaveAttribute("aria-label", initialWidthLabel ?? "");
  await expect(widthCycle).toHaveAttribute("title", await widthCycle.getAttribute("aria-label") ?? "");
  const updateLink = drawer.locator(".sh-skill-drawer__prototype-update a");
  await expect(updateLink).toBeVisible();
  await expect(updateLink).toHaveAttribute("href", /#versions$/);
  await expect(drawer.getByRole("heading", { name: "依赖与重复项" })).toHaveCount(0);
  await expect(drawer.getByRole("heading", { name: "外部变更" })).toHaveCount(0);
  const agentCards = drawer.locator(".sh-skill-drawer__prototype-agent-card .sh-agent-presentation");
  await expect(agentCards).toHaveCount(2);
  await agentCards.first().scrollIntoViewIfNeeded();
  await expect(agentCards.nth(0)).toHaveAttribute("aria-label", /OpenAI.*(?:Terminal|终端)/);
  await expect(agentCards.nth(1)).toHaveAttribute("aria-label", /Claude.*(?:Terminal|终端)/);

  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(pageWidth).toBeLessThanOrEqual(750);
});

test("drawer review prototype remains inside a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review");

  const drawer = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveClass(/sh-skill-drawer--prototype/);
  await page.waitForFunction(() => {
    const panel = document.querySelector(".sh-skill-drawer--prototype");
    return panel !== null && panel.getAnimations().every((animation) => animation.playState === "finished");
  });

  const geometry = await drawer.evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(8);
  expect(geometry.right).toBeLessThanOrEqual(382);
  expect(geometry.width).toBeLessThanOrEqual(374);
  const prototypeActions = drawer.locator(".sh-skill-drawer__prototype-actions");
  await expect(prototypeActions.locator("button")).toHaveCount(3);
  await expect(prototypeActions).toBeVisible();
  const purposeHelp = drawer.locator(".sh-skill-drawer__purpose-row .sh-skill-drawer__edit-icon");
  await purposeHelp.focus();
  await expect.poll(() => purposeHelp.evaluate((element) => getComputedStyle(element, "::after").visibility)).toBe("visible");
  const helpGeometry = await purposeHelp.evaluate((element) => {
    const tooltip = getComputedStyle(element, "::after");
    return {
      focusVisible: element.matches(":focus-visible"),
      maxWidth: Number.parseFloat(tooltip.maxWidth),
      whiteSpace: tooltip.whiteSpace,
    };
  });
  expect(helpGeometry.focusVisible).toBe(true);
  expect(helpGeometry.maxWidth).toBeLessThanOrEqual(240);
  expect(helpGeometry.whiteSpace).toBe("normal");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("review layout only activates with the explicit development preview flag", async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf");

  const drawer = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();
  await expect(drawer).not.toHaveClass(/sh-skill-drawer--prototype/);
  await expect(drawer.locator(".sh-skill-drawer__prototype-actions")).toHaveCount(0);
});

test("review date overlay stays fully inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review");
  const drawer = page.getByTestId("drawer-panel");
  await drawer.getByRole("button", { name: /adjust review date|调整复核日期/i }).click();
  const editor = page.getByRole("dialog", { name: /set review date|设置复核日期/i });
  await expect(editor).toBeVisible();
  const bounds = await editor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const trigger = document.querySelector<HTMLElement>(".sh-skill-drawer__prototype-calendar");
    const triggerRect = trigger?.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      triggerBottom: triggerRect?.bottom ?? 0,
      triggerLeft: triggerRect?.left ?? 0,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(12);
  expect(bounds.top).toBeGreaterThanOrEqual(12);
  expect(bounds.right).toBeLessThanOrEqual(738);
  expect(bounds.bottom).toBeLessThanOrEqual(707);
  expect(Math.abs(bounds.left - bounds.triggerLeft)).toBeLessThanOrEqual(40);
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.triggerBottom);
  expect(bounds.top - bounds.triggerBottom).toBeLessThanOrEqual(40);
});

test("Escape dismisses the review editor without closing the selected Skill drawer", async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review");
  const drawer = page.getByTestId("drawer-panel");
  const dateTrigger = drawer.getByRole("button", { name: /adjust review date|调整复核日期/i });
  await dateTrigger.click();
  const editor = page.getByRole("dialog", { name: /set review date|设置复核日期/i });
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId("drawer-panel")).toBeVisible();
  await expect(page).toHaveURL(/skill=skill-pdf/);
  await expect(dateTrigger).toBeFocused();
});

test("review drawer keeps its clipped floating surface and compact fixed action row", async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review");
  const drawer = page.getByTestId("drawer-panel");

  await expect(drawer.locator(".sh-skill-drawer__toolbar-end > button")).toHaveCount(1);
  await expect(drawer.getByRole("link", { name: /view full details|查看编辑完整详情|查看完整详情/i })).toBeVisible();
  await expect(drawer.locator(".sh-skill-drawer__identity-heading > .sh-skill-drawer__original-name")).toHaveCount(0);
  await expect(drawer.locator(".sh-skill-drawer__identity-heading").getByRole("heading", { name: /basic information|基本信息/i })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /security checks|安全检查/i })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /recheck|重新检查/i })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /AI check|AI 检查/i })).toBeVisible();
  const riskSummary = page.getByRole("region", { name: /risk summary|风险摘要/i });
  await expect(riskSummary).toBeVisible();
  await expect(riskSummary).toContainText(/1 high risk|1 个高风险项/i);
  await expect(riskSummary).toContainText(/1 pending|1 项待处理/i);

  const title = drawer.locator(".sh-skill-drawer__prototype-heading .sh-skill-drawer__pinned-title");
  const actions = drawer.locator(".sh-skill-drawer__prototype-actions");
  const actionButtons = actions.locator("button[data-prototype-action]");
  const rowGeometry = await title.evaluate((element) => {
    const titleRect = element.getBoundingClientRect();
    const actionRect = element.parentElement?.querySelector(".sh-skill-drawer__prototype-actions")?.getBoundingClientRect();
    const buttons = [...(element.parentElement?.querySelectorAll<HTMLButtonElement>(".sh-skill-drawer__prototype-actions button") ?? [])];
    return {
      actionTop: actionRect?.top ?? 0,
      titleTop: titleRect.top,
      heights: buttons.map((button) => button.getBoundingClientRect().height),
    };
  });
  expect(Math.abs(rowGeometry.actionTop - rowGeometry.titleTop)).toBeLessThan(8);
  expect(rowGeometry.heights.every((height) => Math.abs(height - rowGeometry.heights[0]!) < 1)).toBe(true);
  expect(rowGeometry.heights[0]).toBeLessThanOrEqual(34);
  expect(await actions.locator("button").count()).toBe(3);

  const order = await drawer.locator(".sh-skill-drawer__prototype-modules > .sh-skill-drawer__module h3").allTextContents();
  expect(order.at(-1)).toMatch(/source and version|来源与版本/i);
  await actionButtons.first().click();
  await expect(page.getByRole("dialog", { name: /dispatch preview|派发预览/i })).toBeVisible();
  await expect(page.getByText(/nothing is actually dispatched|不会真实派发/i)).toBeVisible();
  await page.getByRole("button", { name: /cancel preview|取消预览/i }).click();
  await expect(page.getByRole("dialog", { name: /dispatch preview|派发预览/i })).toHaveCount(0);
  await page.screenshot({ path: "test-results/drawer-prototype/prototype-v2-corners-750x719.png" });
});

test("overflow review sample bounds tags and relation scrolling to each list", async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review&drawerSample=overflow");
  const drawer = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();

  const tagList = drawer.locator(".sh-skill-drawer__prototype-tag-list");
  await expect(tagList).toBeVisible();
  await expect(tagList.locator("li").nth(2)).toHaveAttribute("title", /long/);
  const moreTags = page.getByRole("button", { name: /more tags|其余 .* 个标签/i });
  await expect(moreTags).toBeVisible();
  await moreTags.click();
  const allTagsDialog = page.getByRole("dialog", { name: /all tags|全部标签/i });
  await expect(allTagsDialog).toBeVisible();
  await expect(allTagsDialog.getByText(/multi-purpose-long-tag-for-overflow-review/i)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(allTagsDialog).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(moreTags).toBeFocused();

  const agents = drawer.locator(".sh-skill-drawer__prototype-agent-cards");
  const projects = drawer.locator(".sh-skill-drawer__prototype-project-scroll");
  await expect(agents).toHaveAttribute("tabindex", "0");
  await expect(projects).toHaveAttribute("tabindex", "0");
  await expect(agents).toHaveCSS("overflow-y", "auto");
  await expect(projects).toHaveCSS("overflow-y", "auto");
  const agentBefore = await agents.evaluate((element) => element.scrollTop);
  await projects.scrollIntoViewIfNeeded();
  const drawerScroll = drawer.locator(".sh-skill-drawer__scroll");
  const drawerBefore = await drawerScroll.evaluate((element) => element.scrollTop);
  const projectsBox = await projects.boundingBox();
  expect(projectsBox).not.toBeNull();
  await page.mouse.move(projectsBox!.x + projectsBox!.width / 2, projectsBox!.y + projectsBox!.height - 6);
  await page.mouse.wheel(0, 380);
  await expect.poll(() => projects.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await drawerScroll.evaluate((element) => element.scrollTop)).toBe(drawerBefore);
  expect(await agents.evaluate((element) => element.scrollTop)).toBe(agentBefore);
  await projects.focus();
  await page.keyboard.press("PageDown");
  await expect.poll(() => projects.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/drawer-prototype/prototype-v2-overflow-750x719.png" });
});

test("review drawer shows local safety results and translation shortcuts without network calls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review&drawerSample=translation-unconfigured");
  const drawer = page.getByTestId("drawer-panel");
  const useTranslation = drawer.getByRole("button", { name: /use existing translation as my purpose|使用已有译文作为我的用途/i });
  await expect(drawer.getByRole("button", { name: /AI translation|AI 翻译/i })).toBeVisible();
  await expect(drawer.getByRole("link", { name: /configure AI translation|配置 AI 翻译/i })).toHaveAttribute("href", /settings.*networkAi/);
  await expect(useTranslation).toBeVisible();
  await expect(useTranslation).toHaveText(/set as purpose|设为用途/i);
  const basicCheck = drawer.getByRole("button", { name: /recheck|重新检查/i });
  const securityIcons = drawer.locator(".sh-skill-drawer__prototype-security-icon");
  await expect(securityIcons).toHaveCount(2);
  await expect(securityIcons.first()).toHaveAttribute("aria-label", /basic check found 1 risks|基础检查发现/i);
  await expect(securityIcons.first()).toHaveAttribute("title", /current version|当前版本/i);
  const riskShield = drawer.locator(".sh-skill-drawer__prototype-security-icon--risk").first();
  await expect(riskShield.locator("svg path").first()).toHaveAttribute("fill", "var(--ui-warning-background)");
  await expect(riskShield.locator("svg path").first()).toHaveAttribute("stroke", "var(--ui-warning-foreground)");
  await expect(riskShield.locator("svg path").nth(1)).toHaveAttribute("stroke", "var(--ui-danger-foreground)");
  await expect(riskShield.locator("svg circle")).toHaveAttribute("fill", "var(--ui-danger-foreground)");
  await expect(securityIcons.nth(1)).toHaveAttribute("aria-label", /AI check failed|AI 检查失败/i);
  await expect(drawer.getByText(/local preview data only|仅使用本地预览数据/i)).toBeVisible();

  const dataRequests: string[] = [];
  page.on("request", (request) => {
    if (["xhr", "fetch"].includes(request.resourceType())) dataRequests.push(request.url());
  });
  await basicCheck.click();
  const riskSummary = page.getByRole("region", { name: /risk summary|风险摘要/i });
  await expect(riskSummary).toBeVisible();
  await expect(drawer.getByRole("button", { name: /AI check|AI 检查/i })).toBeEnabled();
  await expect(riskSummary).toContainText(/1 high risk|1 个高风险项/i);
  await expect(riskSummary).toContainText(/1 pending|1 项待处理/i);
  expect(dataRequests).toEqual([]);
  await page.setViewportSize({ width: 750, height: 719 });
  await page.screenshot({ path: "test-results/drawer-prototype/prototype-v3-security-750x719.png" });
  await page.setViewportSize({ width: 390, height: 719 });
  await page.screenshot({ path: "test-results/drawer-prototype/prototype-v3-security-390x719.png" });
});

test("main drawer sample exposes lifecycle, collections, relationship routes, location, and cancelable actions", async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review");
  const origin = new URL(page.url()).origin;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const drawer = page.getByTestId("drawer-panel");

  await expect(drawer.getByText(/trial|试用/i, { exact: true })).toBeVisible();
  await expect(drawer.getByText("2026-10-17")).toBeVisible();
  await expect(drawer.getByRole("button", { name: /adjust review date|调整复核日期/i })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /convert to regular|转为常规/i })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /collections|所属组合/i })).toBeVisible();
  await expect(drawer.getByText("文档工具", { exact: true })).toBeVisible();
  await expect(drawer.getByText("PDF 工作流", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /skill body location|主体位置/i })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /copy sample path|复制样例路径/i })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /open sample location|打开样例位置/i })).toBeVisible();
  await expect(drawer.getByText(/import record|导入存证/i)).toBeVisible();
  await expect(drawer.getByText(/network update source|网络更新来源/i)).toBeVisible();
  await expect(drawer.getByText(/derived sample|复用修改/i)).toBeVisible();

  const relationshipEntry = drawer.getByRole("button", { name: /open relation context: Codex CLI|打开关系上下文：Codex CLI/i });
  await relationshipEntry.click();
  const relationContext = page.getByRole("dialog", { name: /relation context: Codex CLI|关系上下文：Codex CLI/i });
  await expect(relationContext).toContainText(/centrally managed|已集中管理/i);
  await relationContext.getByRole("button", { name: /preview relationship governance|模拟打开关系治理/i }).click();
  await expect(relationContext.getByText(/relationship governance sample|关系治理样例/i)).toBeVisible();
  await expect(relationContext.getByText(/skill-pdf/)).toHaveCount(0);
  await relationContext.getByRole("button", { name: /back to relation summary|返回关系摘要/i }).click();
  await relationContext.getByRole("button", { name: /close relation preview|关闭关系预览/i }).click();

  const lifecycleButton = drawer.getByRole("button", { name: /adjust review date|调整复核日期/i });
  await lifecycleButton.click();
  const reviewEditor = page.getByRole("dialog", { name: /set review date|设置复核日期/i });
  await expect(reviewEditor.getByLabel(/review date|复核日期/i)).toHaveValue("2026-10-17");
  await page.keyboard.press("Escape");
  await expect(reviewEditor).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(lifecycleButton).toBeFocused();
  await lifecycleButton.click();
  const reopenedReviewEditor = page.getByRole("dialog", { name: /set review date|设置复核日期/i });
  await reopenedReviewEditor.getByLabel(/review date|复核日期/i).fill("2026-10-24");
  await reopenedReviewEditor.getByRole("button", { name: /save date preview|保存日期预览/i }).click();
  await expect(drawer.getByText("2026-10-24", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: /convert to regular|转为常规/i }).click();
  await expect(drawer.getByText(/regular|常规/i, { exact: true })).toBeVisible();

  const collectionEditorButton = drawer.getByRole("button", { name: /edit collections|编辑所属组合/i });
  await collectionEditorButton.click();
  const collectionEditor = page.getByRole("dialog", { name: /edit collections|所属组合预览/i });
  await collectionEditor.getByRole("checkbox", { name: "研发工具" }).check();
  await collectionEditor.getByRole("button", { name: /cancel|取消/i }).click();
  await expect(drawer.getByText("研发工具", { exact: true })).toHaveCount(0);
  await collectionEditorButton.click();
  await page.getByRole("dialog", { name: /edit collections|所属组合预览/i }).getByRole("checkbox", { name: "研发工具" }).check();
  await page.getByRole("dialog", { name: /edit collections|所属组合预览/i }).getByRole("button", { name: /save collection preview|保存组合预览/i }).click();
  await expect(drawer.getByText("研发工具", { exact: true })).toBeVisible();

  await drawer.getByRole("button", { name: /open sample location|打开样例位置/i }).click();
  const locationPreview = page.getByRole("dialog", { name: /skill body location sample|主体位置样例/i });
  await expect(locationPreview).toContainText(/no local folder will open|不会打开本机目录/i);
  await locationPreview.getByRole("button", { name: /close location preview|关闭位置预览/i }).click();
  await drawer.getByRole("button", { name: /copy sample path|复制样例路径/i }).click();
  const copyStatus = drawer.locator(".sh-skill-drawer__prototype-location [role='status']");
  await expect(copyStatus).toBeVisible();
  await expect(copyStatus).toHaveCSS("position", "static");
  await expect(copyStatus).toContainText(/sample path copied|样例路径已复制/i);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("C:\\preview\\SkillHub\\skills\\pdf-reader");

  await drawer.getByRole("button", { name: /dispatch|派发/i }).click();
  await expect(page.getByRole("dialog", { name: /dispatch preview|派发预览/i })).toBeVisible();
  await expect(page.getByText(/nothing is actually dispatched|不会真实派发/i)).toBeVisible();
  await page.getByRole("button", { name: /cancel preview|取消预览/i }).click();
  await expect(page.getByRole("dialog", { name: /dispatch preview|派发预览/i })).toHaveCount(0);
  await page.screenshot({ path: "test-results/drawer-prototype/prototype-v2-full-750x719.png" });
});

test("sample path copy reports denied clipboard access visibly and allows retry", async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 719 });
  await page.goto("/__preview/skill-library?skill=skill-pdf&drawerPrototype=review");
  const origin = new URL(page.url()).origin;
  await page.context().grantPermissions([], { origin });
  const drawer = page.getByTestId("drawer-panel");
  const copyButton = drawer.getByRole("button", { name: /copy sample path|复制样例路径/i });
  await copyButton.click();
  const copyStatus = drawer.locator(".sh-skill-drawer__prototype-location [role='status']");
  await expect(copyStatus).toBeVisible();
  await expect(copyStatus).toHaveCSS("position", "static");
  await expect(copyStatus).toContainText(/allow clipboard access and retry|允许剪贴板访问后重试/i);
  expect(await page.evaluate(() => navigator.clipboard.readText().catch(() => ""))).toBe("");
  await copyStatus.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/drawer-prototype/prototype-v3-copy-denied-750x719.png" });

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await copyButton.click();
  await expect(copyStatus).toContainText(/sample path copied|样例路径已复制/i);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("C:\\preview\\SkillHub\\skills\\pdf-reader");
});
