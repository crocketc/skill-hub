import { expect, test, type Page } from "./fixtures";

const THEMES = [
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

const WIDTHS = [800, 1024, 1280, 1440] as const;

/** Root-level horizontal overflow guard shared by every size check. */
async function expectNoRootHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function openPending(page: Page, query = "") {
  await page.goto(`/__preview/pending${query}`);
  await expect(page.getByRole("heading", { name: "Close the loop on pending items" })).toBeVisible();
}

/** Expand every collapsed work group so per-item rows become reachable. */
async function expandPendingGroups(page: Page) {
  for (let guard = 0; guard < 120; guard += 1) {
    const toggle = page.getByRole("button", { name: /^Show item details/ }).first();
    if ((await toggle.count()) === 0) return;
    await toggle.click();
  }
  throw new Error("Pending groups never finished expanding");
}

test("keeps work grouped by processing ownership with honest counts before expanding", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPending(page);

  // 紧凑页头给出两种诚实的数量：底层事项数与需处理数/建议数。
  await expect(page.getByText(/4 pending items/)).toBeVisible();
  await expect(page.getByText(/4 items need action/)).toBeVisible();

  // 分类导航带真实计数；历史入口锚点保持可达。
  const categories = page.getByRole("group", { name: "All" });
  await expect(categories.getByRole("button", { name: "All 4" })).toBeVisible();
  await expect(categories.getByRole("button", { name: "Skill review 3" })).toBeVisible();
  await expect(categories.getByRole("button", { name: "Recovery 1" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Handled history/ })).toHaveAttribute("href", "#pending-history-heading");

  // 组行收拢即可读：事项数、对象数、对象名摘要与最高风险。
  const securityGroup = page.locator(".sh-pending-group").filter({
    has: page.getByRole("button", { name: "Show item details: Security and basic checks" }),
  });
  await expect(securityGroup.getByText("2 pending item(s)")).toBeVisible();
  await expect(securityGroup.getByText("2 related object(s)")).toBeVisible();
  await expect(securityGroup.getByText("pdf-reader", { exact: true }).first()).toBeVisible();
  await expect(securityGroup.getByText("web-clipper", { exact: true })).toBeVisible();
  await expect(securityGroup.getByText("High risk")).toBeVisible();
  // 高风险原因常显并携带精准深链，无需展开。
  const reasons = securityGroup.getByRole("list", { name: "High-risk reasons (1)" });
  await expect(reasons.getByText("pdf-reader")).toBeVisible();
  await expect(reasons.getByRole("link", { name: "Open task" })).toHaveAttribute("href", "/library/pdf-reader/security");
  // 未展开时逐项选择与操作不可达。
  await expect(securityGroup.getByRole("checkbox", { name: "Select pdf-reader" })).toHaveCount(0);
  await expectNoRootHorizontalOverflow(page);
});

test("exposes risk, impact, and suggested actions per item after expanding", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPending(page);
  await expandPendingGroups(page);

  const finding = page.locator(".sh-pending-item").filter({ hasText: "Affects 3 deployment relations" });
  await expect(finding.getByRole("group", { name: "Suggested actions for pdf-reader" })).toBeVisible();
  await expect(finding.getByRole("link", { name: "Open task" })).toHaveAttribute("href", "/library/pdf-reader/security");
  // 安全发现没有暂缓/忽略契约，不得在总览出现可借道的批量操作。
  await expect(finding.getByRole("button", { name: "Defer" })).toHaveCount(0);
  await expect(finding.getByRole("button", { name: "Ignore" })).toHaveCount(0);

  const trial = page.locator(".sh-pending-item").filter({ hasText: "Due 2026-09-30" });
  await expect(trial.getByText("Affects 2 deployment relations")).toBeVisible();
  await expect(trial.getByRole("button", { name: "Make regular" })).toBeVisible();
  await expect(trial.getByRole("button", { name: "Defer" })).toBeVisible();
});

test("hands Skill review batches to the library with the exact Skill list and return path", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPending(page);

  // 批量入口只收编可批量检查的 Skill；高风险发现留在逐项工作台。
  const batchLink = page.getByRole("link", { name: "Batch check in Skill Library (1)" });
  await expect(batchLink).toBeVisible();
  await batchLink.click();

  await expect(page).toHaveURL(/\/library$/);
  const state = await page.evaluate(
    () => (window.history.state as { usr?: { pendingReview?: { skillIds: string[]; intent: string; returnTo: string } } })?.usr?.pendingReview,
  );
  expect(state).toEqual({ skillIds: ["web-clipper"], intent: "security_check", returnTo: "/pending" });
});

test("keeps the batch bar from covering the last item or its focus at 50+ items", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await openPending(page, "?items=60");
  await expandPendingGroups(page);

  const bar = page.locator(".sh-pending-batch--anchored");
  await expect(bar).toBeVisible();

  const lastItem = page.locator(".sh-pending-item").last();
  const focusTarget = lastItem.getByRole("link", { name: "Open task" }).first();
  await focusTarget.focus();

  const buttonBox = await focusTarget.boundingBox();
  const barBox = await bar.boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(barBox).not.toBeNull();
  // 批量区钉在滚动区顶部，聚焦的末项按钮滚动到批量区下方，完整可见。
  expect(barBox!.y).toBeLessThan(150);
  expect(buttonBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height - 1);
  expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(900);
  await expectNoRootHorizontalOverflow(page);
});

test("keeps the last item reachable with only 600px of viewport height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await openPending(page, "?items=60");
  await expandPendingGroups(page);

  const bar = page.locator(".sh-pending-batch--anchored");
  const lastItem = page.locator(".sh-pending-item").last();
  const focusTarget = lastItem.getByRole("link", { name: "Open task" }).first();
  await focusTarget.focus();

  const buttonBox = await focusTarget.boundingBox();
  const barBox = await bar.boundingBox();
  expect(barBox!.y).toBeLessThan(150);
  expect(buttonBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height - 1);
  expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(600);
  await expectNoRootHorizontalOverflow(page);
});

test("reports a failed action inline and keeps the list usable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPending(page, "?actionError=1");
  await expandPendingGroups(page);

  const firstItem = page.locator(".sh-pending-item").filter({ hasText: "Due 2026-09-30" });
  await firstItem.getByRole("button", { name: "Defer" }).first().click();

  // 统一执行反馈：失败同时进通知中心（danger toast）与页面行内提示，两者同源；
  // 因此 alert 有两处，行内提示用专用类名定位，toast 用通知的 testid 定位。
  await expect(page.locator(".sh-pending__action-error")).toContainText("The operation failed");
  await expect(page.getByTestId("notice-danger")).toContainText("The operation failed");
  await expect(page.getByTestId("notice-danger")).not.toContainText("[object Object]");
  await expect(page.getByText("pdf-reader", { exact: true }).first()).toBeVisible();
  // 失败不锁死工作台：仍可选择事项并继续批量操作。
  await page.getByRole("checkbox", { name: "Select release-notes" }).check();
  await expect(page.getByRole("button", { name: "Defer selected for 7 days" })).toBeEnabled();
});

test("batch ignore keeps its confirmation and cancel path", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPending(page);
  await expandPendingGroups(page);

  await page.getByRole("checkbox", { name: "Select release-notes" }).check();
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.getByRole("button", { name: "Ignore selected permanently" }).click();

  const dialog = page.getByRole("alertdialog", { name: "Permanently ignore the selected items?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("pdf-reader", { exact: true }).first()).toBeVisible();
});

test("merges Agent compatibility work into one shared-directory card with brand logos and type badges", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPending(page, "?items=20");

  await page.getByRole("button", { name: "Agent compatibility" }).click();
  // 共享目录是独立实体：成员事项归并为一张卡，不按品牌重复出卡。
  const toggle = page.getByRole("button", { name: "Show item details: Agent shared directory" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const group = page.locator(".sh-pending-group").filter({ has: toggle });
  await expect(group.getByText("2 pending item(s)")).toBeVisible();
  await expect(group.getByText("1 related object(s)")).toBeVisible();

  // 品牌 logo + 用户可理解展示类型徽标（统一 presenter，无技术标识）。
  const presentation = page.locator('[aria-label="Agent shared directory；Claude · Terminal；OpenAI · Desktop app"]');
  await expect(presentation).toBeVisible();
  await expect(group.locator('img[src$="anthropic.svg"]')).toHaveCount(1);
  await expect(group.locator('img[src$="openai.svg"]')).toHaveCount(1);
  await expect(page.getByText("agent-2", { exact: true })).toHaveCount(0);
  await expectNoRootHorizontalOverflow(page);
});

test.describe("pending width matrix", () => {
  for (const width of WIDTHS) {
    test(`keeps the pending workbench free of root overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPending(page, "?items=60");
      await expectNoRootHorizontalOverflow(page);
      const select = page.getByRole("combobox", { name: "Specific item" });
      await expect(select).toBeVisible();
      await select.selectOption("recovery");
      // 筛选后只剩恢复归属：技能复核对象不再出现，恢复工作台入口可见。
      await expect(page.getByText("Skill 3", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Recovery", exact: true })).toBeVisible();
      await expectNoRootHorizontalOverflow(page);
    });
  }
});

test.describe("pending 9-theme matrix at 1280x900", () => {
  for (const theme of THEMES) {
    test(`renders key controls and focus without overflow in ${theme}`, async ({ page }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem("skillhub.appearance", value);
      }, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openPending(page, "?items=20");

      await expectNoRootHorizontalOverflow(page);
      await expect(page.getByRole("group", { name: "Batch disposition" })).toBeVisible();

      // Full-width workbench: the anchored batch bar spans the content area.
      const barBox = await page.locator(".sh-pending-batch--anchored").boundingBox();
      expect(barBox).not.toBeNull();
      expect(barBox!.width).toBeGreaterThan(700);

      // Risk stays icon + text; the text is theme independent.
      await expect(page.getByText("High risk").first()).toBeVisible();

      // Keyboard focus remains visible on an item action after expanding groups.
      await expandPendingGroups(page);
      await page.locator(".sh-pending-item").nth(1).getByRole("link", { name: "Open task" }).focus();
      const focused = await page.evaluate(() => document.activeElement?.tagName ?? "");
      expect(["A", "BUTTON", "SELECT", "INPUT"]).toContain(focused);
    });
  }
});


test("keeps setup suggestions separate from required work and links to the exact settings section", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPending(page, "?setup=1");
  await expandPendingGroups(page);

  const ai = page.locator(".sh-pending-item").filter({ hasText: "Configure AI" });
  await expect(ai.getByRole("link", { name: "Open task" })).toHaveAttribute("href", "/settings?section=networkAi");
  await expect(ai.getByRole("button", { name: "Confirm recovery" })).toHaveCount(0);
  await expect(page.getByText(/2 suggestions/).first()).toBeVisible();
  await expectNoRootHorizontalOverflow(page);
});
