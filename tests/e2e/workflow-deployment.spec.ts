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

async function expectNoRootHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

// 单目标流程壳（ImportShell section[aria-labelledby]）的可访问名。
const SINGLE_FLOW_REGION = "Preview before changing Agent targets";

/**
 * 流程自己的持久状态区（ImportShell 内 role=status 的段落）。
 * Task 4 起全局通知（notice-*）也是 role=status 的 live region，
 * 状态断言必须收窄到流程壳内，避免严格模式解析到多个 live region。
 */
function flowStatus(page: Page, regionName: string) {
  return page.getByRole("region", { name: regionName }).getByRole("status");
}

function conflictRow(page: Page, skillName: string, targetName: string) {
  return page.getByTestId("disposition-row").filter({ hasText: skillName }).filter({ hasText: targetName });
}

test.describe("deployment flow shell", () => {
  test("rechecks a saved single-Skill selection with the keyboard at a narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto("/__preview/deployment?scenario=recent-single");

    const recent = page.getByRole("region", { name: "Recent dispatch selections" });
    await expect(recent).toBeVisible();
    await expect(recent).toContainText("Earlier confirmations and exclusions are not reused.");
    const recheck = recent.getByRole("button", { name: "Recheck" });
    await recheck.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("heading", { name: "Planned additions" })).toBeVisible();
    await expect(page.getByTestId("deployment-target-grid")).toHaveCount(0);
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByTestId("deployment-target-grid").getByLabel("Preview Agent 1")).toBeChecked();
    await expectNoRootHorizontalOverflow(page);
  });

  test("rechecks all Skills in a saved batch and updates the batch scope", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=recent-batch");

    const recent = page.getByRole("region", { name: "Recent dispatch selections" });
    await expect(recent.getByRole("button", { name: "Recheck" })).toBeVisible();
    await recent.getByRole("button", { name: "Recheck" }).click();

    await expect(page.getByRole("heading", { name: "Planned additions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Add 2 Skills" })).toBeVisible();
  });

  test("returns from a single preview without committing and retains the target choice", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=conflict-single");
    await page.getByLabel("Preview Agent 1").check();
    await page.getByRole("button", { name: "Preview" }).click();

    await expect(page.getByRole("heading", { name: "Planned additions" })).toBeVisible();
    await expect(page.getByTestId("deployment-target-grid")).toHaveCount(0);
    await page.getByRole("button", { name: "Back" }).click();

    await expect(page.getByLabel("Preview Agent 1")).toBeChecked();
    await expect(page.getByTestId("deployment-result")).toHaveCount(0);
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByRole("heading", { name: "Planned additions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm and add" })).toBeVisible();
  });

  test("returns from a batch preview without committing and retains the target choice", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=conflict-batch");
    await page.getByLabel("Preview Agent 1").check();
    await page.getByRole("button", { name: "Preview" }).click();

    await expect(page.getByRole("heading", { name: "Planned additions" })).toBeVisible();
    await expect(page.getByTestId("deployment-target-grid")).toHaveCount(0);
    await page.getByRole("button", { name: "Back" }).click();

    await expect(page.getByLabel("Preview Agent 1")).toBeChecked();
    await expect(page.getByTestId("batch-summary")).toHaveCount(0);
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByRole("heading", { name: "Planned additions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm and add" })).toBeVisible();
  });

  test("creates a missing directory and continues the single dispatch flow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=pending-single");

    const createAndAdd = page.getByRole("button", { name: "Create and add" });
    await expect(createAndAdd).toHaveClass(/sh-button--primary/);
    await createAndAdd.click();
    await expect(page.getByRole("heading", { name: "Create the Skill directory?" })).toBeVisible();
    await page.getByRole("button", { name: "Create directory" }).click();

    await expect(page.getByLabel("Preview Agent 1")).toBeChecked();
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("button", { name: "Confirm and add" }).click();
    await expect(page.getByTestId("deployment-result")).toHaveCount(1);
  });

  test("keeps the shared-directory chip inside its row and centers the target path", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/__preview/deployment?scenario=path-layout");

    const card = page.locator('.sh-deployment-target-card[data-agent-card="true"]').first();
    const chip = card.locator(".sh-agent-card__shared-chip");
    const path = card.locator(".sh-deployment-target-card__path-region small").first();
    await expect(card).toBeVisible();
    await expect(chip).toBeVisible();
    await expect(path).toHaveAttribute("title", "C:\\Users\\demo\\very-long-preview-directory-segment\\agent-skills\\with\\an\\extremely\\long\\suffix\\preview-skill-1");

    const measure = () => card.evaluate((element) => {
      const label = element.querySelector(".sh-deployment-target-card__path-label")!;
      const chipElement = element.querySelector(".sh-agent-card__shared-chip")!;
      const region = element.querySelector(".sh-deployment-target-card__path-region")!;
      const pathElement = region.querySelector("small")!;
      const range = document.createRange();
      range.selectNodeContents(pathElement);
      const labelRect = label.getBoundingClientRect();
      const chipRect = chipElement.getBoundingClientRect();
      const regionRect = region.getBoundingClientRect();
      const pathRect = pathElement.getBoundingClientRect();
      const textRect = range.getBoundingClientRect();
      return {
        chipBottom: chipRect.bottom,
        chipTop: chipRect.top,
        labelBottom: labelRect.bottom,
        labelTop: labelRect.top,
        pathCenter: (pathRect.top + pathRect.bottom) / 2,
        regionCenter: (regionRect.top + regionRect.bottom) / 2,
        textCenter: (textRect.top + textRect.bottom) / 2,
        textClientWidth: pathElement.clientWidth,
        textScrollWidth: pathElement.scrollWidth,
      };
    });

    const wide = await measure();
    expect.soft(wide.chipTop).toBeGreaterThanOrEqual(wide.labelTop);
    expect.soft(wide.chipBottom).toBeLessThanOrEqual(wide.labelBottom);
    expect.soft(Math.abs(wide.textCenter - wide.regionCenter)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath("deployment-agent-path-wide.png"), fullPage: true });

    await page.setViewportSize({ width: 560, height: 900 });
    const narrow = await measure();
    expect.soft(narrow.chipTop).toBeGreaterThanOrEqual(narrow.labelTop);
    expect.soft(narrow.chipBottom).toBeLessThanOrEqual(narrow.labelBottom);
    expect.soft(Math.abs(narrow.textCenter - narrow.regionCenter)).toBeLessThanOrEqual(1);
    expect(narrow.textScrollWidth).toBeGreaterThan(narrow.textClientWidth);
    await expectNoRootHorizontalOverflow(page);
    await page.screenshot({ path: test.info().outputPath("deployment-agent-path-narrow.png"), fullPage: true });
  });

  test("exposes the unified step rail and a stable footer for the single flow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment");

    const rail = page.getByRole("list", { name: "Addition steps" });
    await expect(rail).toBeVisible();
    const steps = rail.getByRole("listitem");
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(0)).toHaveAttribute("aria-current", "step");
    await expect(steps.nth(0)).toContainText("Select targets");
    await expect(steps.nth(3)).toContainText("Results");

    // 流程全程只有一个 footer 操作区；主操作随阶段变化但位置稳定。
    const footer = page.locator("footer");
    await expect(footer).toHaveCount(1);
    const previewButton = page.getByRole("button", { name: "Preview" });
    await expect(previewButton).toBeDisabled();
    await page.getByLabel("Preview Agent 1").check();
    await expect(previewButton).toBeEnabled();
    await expect(footer.getByRole("button", { name: "Preview" })).toBeVisible();
    // 选择阶段：状态区播报当前阶段。
    await expect(flowStatus(page, SINGLE_FLOW_REGION)).toContainText("Select the targets to add");

    await previewButton.click();
    const commitButton = page.getByRole("button", { name: "Confirm and add" });
    await expect(footer.getByRole("button", { name: "Confirm and add" })).toBeVisible();
    await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");

    await commitButton.click();
    await expect(page.getByTestId("deployment-result")).toHaveCount(1);
    await expect(steps.nth(3)).toHaveAttribute("aria-current", "step");
    // 结果状态断言收窄到流程壳自己的状态区：提交成功还会触发全局
    // notice-success（role=status）toast，页面级 getByRole("status") 有歧义。
    await expect(flowStatus(page, SINGLE_FLOW_REGION)).toContainText("Adding finished");
  });

  test("keeps blocked pairs visible without letting them hold back the rest", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=partial");

    await page.getByLabel("Preview Agent 1").check();
    await page.getByLabel("Preview Agent 2").check();
    await page.getByRole("button", { name: "Preview" }).click();

    // 15.6：受阻 pair 进入「Cannot execute」组并给出原因；可执行项照常提交。
    const blockedGroup = page.getByTestId("disposition-group").filter({ hasText: "Cannot execute" });
    await expect(blockedGroup).toBeVisible();
    await expect(
      blockedGroup.getByText("The target directory is currently unreachable. Check the disk or network connection and retry."),
    ).toBeVisible();
    await expect(page.getByTestId("disposition-group").filter({ hasText: "Execute as selected" })).toBeVisible();

    const commitButton = page.getByRole("button", { name: "Confirm and add" });
    await expect(commitButton).toBeEnabled();
    await commitButton.click();

    await expect(page.getByText("Adding finished with failed targets")).toBeVisible();
    // blocked pair 投影为失败结果，但文案如实说明「未执行、保持原状」。
    await expect(page.getByText("This target was not executed and stays as it is.")).toBeVisible();
    const retry = page.getByRole("button", { name: "Retry failed targets" });
    await expect(retry).toBeVisible();
    await expect(page.locator("footer").getByRole("button", { name: "Retry failed targets" })).toBeVisible();

    // 恢复路径：重试只带回失败目标的选择。
    await retry.click();
    await expect(page.getByLabel("Preview Agent 2")).toBeChecked();
    await expect(page.getByLabel("Preview Agent 1")).not.toBeChecked();
  });

  test("requires an explicit copy confirmation when link deployment is unavailable", async ({ page }) => {
    // 15.6：链接受阻不静默降级——未确认前主操作是「Regenerate final preview」，
    // 不提供直接提交；确认后必须二次预览（服务端指纹校验）才能提交。
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=fallback");

    await page.getByLabel("Preview Agent 1").check();
    await page.getByLabel("Preview Agent 2").check();
    await page.getByRole("button", { name: "Preview" }).click();

    const copyGroup = page.getByTestId("disposition-group").filter({ hasText: "Full-copy dispatch is recommended" });
    await expect(copyGroup).toBeVisible();
    await expect(
      copyGroup.getByText("This account cannot create links. You can choose full-copy dispatch instead."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm and add" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Regenerate final preview" })).toBeVisible();

    await copyGroup.getByRole("checkbox", { name: "Preview Skill · Preview Agent 1" }).check();
    await expect(copyGroup.getByTestId("confirmed-copy")).toBeVisible();
    await page.getByRole("button", { name: "Regenerate final preview" }).click();

    // 二次预览后确认被保留（指纹一致），提交解锁且无需再次确认。
    await expect(copyGroup.getByTestId("confirmed-copy")).toBeVisible();
    const commitButton = page.getByRole("button", { name: "Confirm and add" });
    await expect(commitButton).toBeEnabled();
    await commitButton.click();

    await expect(page.getByText("Adding finished", { exact: true })).toBeVisible();
    await expect(page.getByTestId("deployment-result")).toHaveCount(2);
  });

  test("keeps the target discovery failure alert reachable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=unavailable");

    await expect(page.getByRole("alert")).toContainText(/failed/i);
    await expect(flowStatus(page, SINGLE_FLOW_REGION)).toContainText(/failed/i);
  });

  test("shows why read-only and unsupported targets cannot be selected", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=target-eligibility");

    const grid = page.getByTestId("deployment-target-grid");
    const readOnly = grid.getByTestId("deployment-target-card").filter({ hasText: "Read-only target" });
    const unsupported = grid.getByTestId("deployment-target-card").filter({ hasText: "Unsupported target" });
    await expect(readOnly).toContainText("This target directory is not writable. Check the current account permissions or choose another target.");
    await expect(unsupported).toContainText("This target has no supported dispatch mode.");
    await expect(grid.getByRole("checkbox", { name: "Read-only target" })).toHaveCount(0);
    await expect(grid.getByRole("checkbox", { name: "Unsupported target" })).toHaveCount(0);
    await expect(grid.getByLabel("Writable target")).toBeEnabled();
  });
});

test.describe("batch deployment flow", () => {
  test("creates a missing directory and continues the batch dispatch flow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=pending-batch");

    const createAndAdd = page.getByRole("button", { name: "Create and add" });
    await expect(createAndAdd).toHaveClass(/sh-button--primary/);
    await createAndAdd.click();
    await expect(page.getByRole("heading", { name: "Create the Skill directory?" })).toBeVisible();
    await page.getByRole("button", { name: "Create directory" }).click();

    await expect(page.getByLabel("Preview Agent 1")).toBeChecked();
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("button", { name: "Confirm and add" }).click();
    await expect(page.getByTestId("batch-summary")).toContainText("8 succeeded");
  });

  test("uses the same read-only and supported-mode eligibility as the single flow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=batch-target-eligibility");

    const grid = page.getByTestId("deployment-target-grid");
    const readOnly = grid.getByTestId("deployment-target-card").filter({ hasText: "Read-only target" });
    const unsupported = grid.getByTestId("deployment-target-card").filter({ hasText: "Unsupported target" });
    await expect(readOnly).toContainText("This target directory is not writable. Check the current account permissions or choose another target.");
    await expect(unsupported).toContainText("This target has no supported dispatch mode.");
    await expect(grid.getByRole("checkbox", { name: "Read-only target" })).toHaveCount(0);
    await expect(grid.getByRole("checkbox", { name: "Unsupported target" })).toHaveCount(0);
    await expect(grid.getByLabel("Writable target")).toBeEnabled();
    await grid.getByLabel("Writable target").check();
    await expect(page.getByRole("button", { name: "Preview" })).toBeEnabled();
  });

  test("keeps the non-atomic risk adjacent to the commit and guards unavailable targets", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=batch");

    await expect(page.getByRole("heading", { name: "Add 8 Skills" })).toBeVisible();
    await expect(page.getByLabel("Unavailable target")).toHaveCount(0);

    const footer = page.locator("footer");
    await expect(footer).toHaveCount(1);
    // 选择阶段：非原子风险已经在 footer 操作区内。
    await expect(footer).toContainText(/not atomic/i);

    await page.getByLabel("Preview Agent 1").check();
    await page.getByRole("button", { name: "Preview" }).click();
    const commitButton = page.getByRole("button", { name: "Confirm and add" });
    await expect(commitButton).toBeEnabled();
    // 提交动作与非原子风险提示必须同处一个 footer 操作区（相邻）。
    await expect(footer).toContainText(/not atomic/i);
    await expect(footer.getByRole("button", { name: "Confirm and add" })).toBeVisible();
    // DEV-18-A：计划区主文案是展示名，裸 Skill UUID 不出现在首屏。
    await expect(page.getByText("Preview Skill 8")).toBeVisible();
    await expect(page.getByText("preview-skill-8").first()).toBeHidden();
  });

  test("confirms the copy fallback per reason group and regenerates before commit", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=batch-fallback");

    await expect(page.getByRole("heading", { name: "Add 2 Skills" })).toBeVisible();
    await page.getByLabel("Preview Agent 1").check();
    await page.getByRole("button", { name: "Preview" }).click();

    // 五桶汇总如实呈现：未确认的回退计入「Still blocked」，不计为复制。
    await expect(page.getByText("Links 0 · Full copies 0 · No change 0 · Replaced 0 · Renamed 0 · Conflict skipped 0 · Excluded 0 · Still blocked 2")).toBeVisible();

    const copyGroup = page.getByTestId("disposition-group").filter({ hasText: "Full-copy dispatch is recommended" });
    await expect(copyGroup).toBeVisible();
    await page.getByRole("checkbox", { name: "Confirm copy fallback for the whole group" }).check();
    await expect(copyGroup.getByTestId("confirmed-copy")).toHaveCount(2);

    // 确认后必须重新生成最终预览；确认经指纹校验被保留。
    await page.getByRole("button", { name: "Regenerate final preview" }).click();
    await expect(page.getByText("Links 0 · Full copies 2 · No change 0 · Replaced 0 · Renamed 0 · Conflict skipped 0 · Excluded 0 · Still blocked 0")).toBeVisible();
    await expect(copyGroup.getByTestId("confirmed-copy")).toHaveCount(2);

    await page.getByRole("button", { name: "Confirm and add" }).click();
    await expect(page.getByText("Adding finished", { exact: true })).toBeVisible();
    await expect(page.getByTestId("batch-summary")).toContainText("2 succeeded");
  });

  test("excludes an individual pair and reports it as skipped after commit", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=batch");

    await page.getByLabel("Preview Agent 1").check();
    await page.getByRole("button", { name: "Preview" }).click();

    const group = page.getByTestId("disposition-group").filter({ hasText: "Execute as selected" });
    await expect(group.getByTestId("disposition-row")).toHaveCount(8);
    await group.getByRole("checkbox", { name: "Preview Skill 1 · Preview Agent 1" }).uncheck();

    // 排除与确认一样改变提交范围：必须经「Regenerate final preview」落地。
    await page.getByRole("button", { name: "Regenerate final preview" }).click();
    await expect(page.getByText("Links 0 · Full copies 7 · No change 0 · Replaced 0 · Renamed 0 · Conflict skipped 0 · Excluded 1 · Still blocked 0")).toBeVisible();

    await page.getByRole("button", { name: "Confirm and add" }).click();
    await expect(page.getByText("Adding finished", { exact: true })).toBeVisible();
    const summary = page.getByTestId("batch-summary");
    await expect(summary).toContainText("7 succeeded");
    await expect(summary).toContainText("1 skipped");
    await expect(summary.getByTestId("batch-outcome-skipped")).toHaveCount(1);
  });

  test("keeps batch partial success and failed target details visible", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=batch-partial");
    await page.getByLabel("Preview Agent 1").check();
    await page.getByLabel("Preview Agent 2").check();
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("button", { name: "Confirm and add" }).click();

    const summary = page.getByTestId("batch-summary");
    await expect(summary).toContainText("8 succeeded");
    await expect(summary).toContainText("8 failed");
    const failed = summary.getByTestId("batch-outcome-failed");
    await expect(failed).toHaveCount(8);
    await expect(failed.first()).toContainText("Preview Skill 1 · Preview Agent 2");
    await expect(failed.first()).toContainText("This target was not executed and stays as it is.");
    // 成功项以汇总计数呈现；失败目标逐项展开，不能把部分成功说成全批完成。
    await expect(summary.getByTestId("batch-outcome-succeeded")).toHaveCount(0);
  });

  test("retries only failed targets from a partial batch before a new preview", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=batch-partial");
    await page.getByLabel("Preview Agent 1").check();
    await page.getByLabel("Preview Agent 2").check();
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("button", { name: "Confirm and add" }).click();

    const summary = page.getByTestId("batch-summary");
    await expect(summary).toContainText("8 succeeded");
    await expect(summary).toContainText("8 failed");
    await page.getByRole("button", { name: "Retry failed targets" }).click();

    // 重试只重新预览失败目标；成功目标不重放，且仍须用户再次确认提交。
    await expect(page.getByRole("heading", { name: "Add 8 Skills" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Planned additions" })).toBeVisible();
    const retryPairs = page.getByTestId("disposition-row");
    await expect(retryPairs).toHaveCount(8);
    await expect(retryPairs.filter({ hasText: "Preview Agent 2" })).toHaveCount(8);
    await expect(retryPairs.filter({ hasText: "Preview Agent 1" })).toHaveCount(0);
    await expect(page.getByTestId("deployment-target-grid")).toHaveCount(0);
    // 预览仍报告目标不可达，不能绕过新事实直接提交。
    await expect(page.getByRole("button", { name: "Confirm and add" })).toBeDisabled();
  });

  test("keeps the commit unreachable when the batch preview fails", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=batch-preview-fail");

    await page.getByLabel("Preview Agent 1").check();
    await page.getByRole("button", { name: "Preview" }).click();

    // 一次 IPC 预览整体失败：告警诚实呈现，计划区与提交入口都不出现。
    await expect(page.getByRole("alert")).toContainText("not writable");
    await expect(page.getByRole("button", { name: "Confirm and add" })).toHaveCount(0);
    await expect(page.getByTestId("disposition-group")).toHaveCount(0);
  });
});

test.describe("deployment conflict parity", () => {
  const flows = [
    {
      name: "single-skill",
      scenario: "conflict-single",
      rows: [
        ["Preview Skill", "Preview Agent 1"],
        ["Preview Skill", "Preview Agent 2"],
        ["Preview Skill", "Preview Agent 3"],
      ] as const,
      targets: ["Preview Agent 1", "Preview Agent 2", "Preview Agent 3"],
    },
    {
      name: "batch",
      scenario: "conflict-batch",
      rows: [
        ["Preview Skill 1", "Preview Agent 1"],
        ["Preview Skill 2", "Preview Agent 1"],
        ["Preview Skill 3", "Preview Agent 1"],
      ] as const,
      targets: ["Preview Agent 1"],
    },
  ];

  for (const flow of flows) {
    test(`shows matching replace, rename and skip receipts in the ${flow.name} flow`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/__preview/deployment?scenario=${flow.scenario}`);
      for (const target of flow.targets) await page.getByLabel(target).check();
      await page.getByRole("button", { name: "Preview" }).click();

      const [replaceSkill, replaceTarget] = flow.rows[0];
      const [renameSkill, renameTarget] = flow.rows[1];
      const [skipSkill, skipTarget] = flow.rows[2];
      const replaceRow = conflictRow(page, replaceSkill, replaceTarget);
      const renameRow = conflictRow(page, renameSkill, renameTarget);
      const skipRow = conflictRow(page, skipSkill, skipTarget);
      await expect(replaceRow).toHaveCount(1);
      await expect(renameRow).toHaveCount(1);
      await expect(skipRow.getByRole("radio", { name: "Skip this target" })).toBeChecked();
      await expect(replaceRow).toContainText("Dispatch consumer");

      await replaceRow.getByRole("radio", { name: "Replace the managed Skill at the target" }).check();
      await expect(page.getByRole("button", { name: "Confirm and add" })).toBeDisabled();
      await replaceRow.getByRole("checkbox", {
        name: "I reviewed the shared-directory consumers and understand they may be affected.",
      }).check();

      await renameRow.getByRole("radio", { name: "Rename and dispatch as a new Skill" }).check();
      const newName = renameRow.getByRole("textbox", { name: /New name/ });
      await newName.fill("preview-reader-renamed");
      await renameRow.getByRole("checkbox", {
        name: "I reviewed the shared-directory consumers and understand they may be affected.",
      }).check();
      await expect(page.getByRole("button", { name: "Confirm and add" })).toBeEnabled();

      if (flow.name === "batch") {
        await expect(page.getByText(/Replaced 1 · Renamed 1 · Conflict skipped 1/)).toBeVisible();
      }
      await page.getByRole("button", { name: "Confirm and add" }).click();

      await expect(page.getByText("deployment.results.status.message.skipped")).toHaveCount(0);
      if (flow.name === "batch") {
        const summary = page.getByTestId("batch-summary");
        await expect(summary).toContainText("2 succeeded");
        await expect(summary).toContainText("1 skipped");
        await expect(summary.getByTestId("batch-outcome-skipped")).toContainText("Preview Skill 3 · Preview Agent 1");
      } else {
        const resultRows = page.getByTestId("deployment-result");
        await expect(resultRows).toHaveCount(3);
        const replacedResult = resultRows.filter({ hasText: "Replaced “Existing Skill" });
        const renamedResult = resultRows.filter({ hasText: "preview-reader-renamed" });
        const skippedResult = resultRows.filter({ hasText: "Preview Agent 3" });
        await expect(replacedResult).toContainText("Replaced “Existing Skill");
        await expect(renamedResult).toContainText("Dispatched successfully as the new name “preview-reader-renamed”.");
        await expect(skippedResult).toContainText("Skipped");
      }
    });
  }

  for (const flow of [
    { name: "single-skill", scenario: "conflict-stale-single", skill: "Preview Skill" },
    { name: "batch", scenario: "conflict-stale-batch", skill: "Preview Skill 1" },
  ]) {
    test(`requires a fresh preview after the target changes in the ${flow.name} flow`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/__preview/deployment?scenario=${flow.scenario}`);
      await page.getByLabel("Preview Agent 1").check();
      await page.getByRole("button", { name: "Preview" }).click();

      const row = conflictRow(page, flow.skill, "Preview Agent 1");
      await expect(row.getByRole("radio", { name: "Replace the managed Skill at the target" })).toBeVisible();
      await row.getByRole("radio", { name: "Replace the managed Skill at the target" }).check();
      await row.getByRole("checkbox", {
        name: "I reviewed the shared-directory consumers and understand they may be affected.",
      }).check();
      await page.getByRole("button", { name: "Confirm and add" }).click();

      await expect(page.locator(".sh-data-state[role='alert']")).toContainText("The target changed while being added.");
      if (flow.name === "single-skill") await expect(page.getByTestId("deployment-result")).toHaveCount(0);
      const refresh = page.getByRole("button", { name: "Regenerate final preview" });
      await expect(refresh).toBeEnabled();
      await refresh.click();

      const refreshedRow = conflictRow(page, flow.skill, "Preview Agent 1");
      await expect(refreshedRow).toContainText("Updated occupant after target drift");
      await expect(refreshedRow.getByRole("radio", { name: "Skip this target" })).toBeChecked();
      await expect(refreshedRow.getByRole("radio", { name: "Replace the managed Skill at the target" })).toHaveCount(0);
      await page.getByRole("button", { name: "Confirm and add" }).click();
      if (flow.name === "batch") {
        const summary = page.getByTestId("batch-summary");
        await expect(summary).toContainText("1 skipped");
        await expect(summary.getByTestId("batch-outcome-skipped")).toContainText("Preview Skill 1 · Preview Agent 1");
      } else {
        await expect(page.getByTestId("deployment-result")).toHaveCount(1);
        await expect(page.getByTestId("deployment-result")).toContainText("Skipped");
      }
    });
  }

  test("makes replaced original content available from the recovery page", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=conflict-single");
    await page.getByLabel("Preview Agent 1").check();
    await page.getByRole("button", { name: "Preview" }).click();

    const row = conflictRow(page, "Preview Skill", "Preview Agent 1");
    await row.getByRole("radio", { name: "Replace the managed Skill at the target" }).check();
    await row.getByRole("checkbox", {
      name: "I reviewed the shared-directory consumers and understand they may be affected.",
    }).check();
    await page.getByRole("button", { name: "Confirm and add" }).click();
    await expect(page.getByTestId("deployment-result")).toContainText("Replaced “Existing Skill");

    await page.goto("/__preview/recovery");
    await page.getByRole("tab", { name: "Replaced content" }).click();
    await expect(page.getByText("preview-original-skill")).toBeVisible();
    await page.getByRole("button", { name: "Restore this content" }).click();
    const confirmation = page.getByRole("alertdialog");
    await confirmation.getByRole("button", { name: "Confirm restore" }).click();
    await expect(page.getByText("No replaced content can be restored right now.")).toBeVisible();
  });
});

test.describe("removal confirmations", () => {
  test("defaults to keeping copies with grouped details and keeps every choice adjustable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/removal?scenario=impact");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // 打开时焦点进入流程标题。
    await expect(dialog.getByRole("heading", { name: /Delete PDF Reader from the library/ })).toBeFocused();
    // W1-2：影响载荷带未完成草稿（draft_count>0）——影响矩阵出现草稿维度，
    // 确认说明区追加草稿级联说明；一次操作同时覆盖两个判据。
    await expect(dialog.getByText("Unfinished edit drafts: 2")).toBeVisible();
    await expect(
      dialog.getByText("Deleting also removes the skill's unfinished edit drafts."),
    ).toBeVisible();
    // 2026-10-08 弹窗重设计：摘要优先，各组明细默认收起；完整拷贝默认预勾
    // 「保留为独立拷贝」，因此确认按钮带默认值即可用；逐项改选在组内单选完成。
    const summary = dialog.getByRole("region", { name: "Deletion summary" });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("Skill library: the Skill's record, contents and version history will be deleted");
    await expect(summary).toContainText("1 links:");
    await expect(summary).toContainText("1 full copies:");
    const confirm = page.getByRole("button", { name: "Confirm deletion from library" });
    await expect(confirm).toBeEnabled();
    await dialog.locator("details > summary").filter({ hasText: "Full copies" }).click();
    await dialog.getByRole("radio", { name: /Delete the copy too/ }).first().check();
    await expect(confirm).toBeEnabled();
  });

  test("defaults batch deletion safely, keeps the risk adjacent, and requires the second click", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/removal?scenario=batch");

    const dialog = page.getByRole("dialog");
    const proceed = page.getByRole("button", { name: "Continue deletion" });
    await expect(proceed).toBeEnabled();
    const summary = dialog.getByRole("region", { name: "Deletion summary" });
    await expect(summary).toContainText("2 Skills:");
    await expect(summary).toContainText("1 links:");
    await expect(summary).toContainText("1 full copies:");
    await expect(dialog.getByText("The link file here will be removed")).toBeVisible();
    const keepCopy = dialog.getByRole("radio", { name: /Keep as an independent copy/ });
    await expect(keepCopy).toBeChecked();
    await dialog.getByRole("radio", { name: /Delete the copy too/ }).check();
    await expect(proceed).toBeEnabled();

    // 非原子批量风险与删除动作相邻（同一 footer 操作区）。
    const actions = dialog.locator("footer");
    await expect(actions).toContainText(/not atomic/i);
    await expect(actions.getByRole("button", { name: "Continue deletion" })).toBeVisible();

    await proceed.click();
    await expect(page.getByRole("button", { name: /Click again to confirm deleting 2 Skills/ })).toBeVisible();
  });

  test("routes shared full-copy release through the unified disposition flow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/removal?scenario=undeploy-shared");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Shared directory");
    await expect(dialog).toContainText("Full copy");

    const preview = dialog.getByRole("button", { name: "Preview release" });
    await expect(preview).toBeDisabled();
    await dialog.getByRole("checkbox", { name: /Shared directory.*Full copy/ }).check();
    await dialog.getByRole("radio", { name: "Keep as an independent copy" }).check();
    await expect(preview).toBeEnabled();
  });

  // K2/G-10：删除影响查询失败必须可见失败并停止流程——错误进 alert、
  // 确认对话框（含确认入口）不出现，绝不静默或回退。
  test("shows the deletion load failure visibly without any confirm entry", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/removal?scenario=load-failed");

    await expect(page.getByRole("alert")).toContainText(
      "Usage relationship target details could not be verified, so removal was not prepared.",
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Confirm deletion from library/ })).toHaveCount(0);
  });
});

test.describe("deployment width matrix", () => {
  // 风险分层：默认主题与 grok-night 跑全宽度矩阵。
  const WIDTH_THEMES: ReadonlyArray<{ name: string; theme: string | null }> = [
    { name: "default theme", theme: null },
    { name: "grok-night", theme: "grok-night" },
  ];

  for (const width of WIDTHS) {
    test(`keeps the single flow free of root overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/deployment?scenario=partial");
      await page.getByLabel("Preview Agent 1").check();
      await page.getByLabel("Preview Agent 2").check();
      await page.getByRole("button", { name: "Preview" }).click();
      await page.getByRole("button", { name: "Confirm and add" }).click();
      await expect(page.getByText("Adding finished with failed targets")).toBeVisible();
      await expectNoRootHorizontalOverflow(page);
    });

    for (const { name, theme } of WIDTH_THEMES) {
      test(`keeps the 60-skill batch free of root overflow at ${width}px in ${name}`, async ({ page }) => {
        if (theme) {
          await page.addInitScript((value) => {
            window.localStorage.setItem("skillhub.appearance", value);
          }, theme);
        }
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/__preview/deployment?scenario=batch-bulk");
        await expect(page.getByRole("heading", { name: "Add 60 Skills" })).toBeVisible();
        await expectNoRootHorizontalOverflow(page);
      });
    }

    test(`keeps the removal dialogs free of root overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/removal?scenario=batch-bulk");
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectNoRootHorizontalOverflow(page);
    });
  }

  test("keeps long target paths readable at the minimum height", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto("/__preview/deployment?scenario=batch-bulk");
    await page.getByLabel("Preview Agent 1").check();
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByRole("heading", { name: "Planned additions" })).toBeVisible();
    // 面板是唯一滚动所有者：footer 操作区保持可见且不遮挡焦点。
    await expect(page.getByRole("button", { name: "Confirm and add" })).toBeVisible();
    await expectNoRootHorizontalOverflow(page);
  });
});

test.describe("deployment 9-theme matrix at 1280x900", () => {
  for (const theme of THEMES) {
    test(`renders flow controls, focus and status without overflow in ${theme}`, async ({ page }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem("skillhub.appearance", value);
      }, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/__preview/deployment");

      await expectNoRootHorizontalOverflow(page);
      await expect(page.getByRole("list", { name: "Addition steps" })).toBeVisible();

      await page.getByLabel("Preview Agent 1").check();
      await page.getByRole("button", { name: "Preview" }).click();
      const commitButton = page.getByRole("button", { name: "Confirm and add" });
      await expect(commitButton).toBeVisible();
      await commitButton.focus();
      const focused = await page.evaluate(() => document.activeElement?.tagName ?? "");
      expect(focused).toBe("BUTTON");
      await expect(flowStatus(page, SINGLE_FLOW_REGION)).toBeVisible();

      await page.goto("/__preview/removal?scenario=batch");
      await expectNoRootHorizontalOverflow(page);
      await expect(page.getByRole("dialog").getByRole("heading", { name: "Review batch deletion impact" })).toBeVisible();
      await expect(page.getByRole("dialog").locator("footer")).toContainText(/not atomic/i);
    });
  }
});
