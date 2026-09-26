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

test.describe("deployment flow shell", () => {
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

    const copyGroup = page.getByTestId("disposition-group").filter({ hasText: "Recommend copy instead" });
    await expect(copyGroup).toBeVisible();
    await expect(
      copyGroup.getByText("This account may not create directory links. Copy deployment is available instead."),
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
});

test.describe("batch deployment flow", () => {
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
    await expect(page.getByText("Link 0 · Copy 0 · No change 0 · Excluded 0 · Still blocked 2")).toBeVisible();

    const copyGroup = page.getByTestId("disposition-group").filter({ hasText: "Recommend copy instead" });
    await expect(copyGroup).toBeVisible();
    await page.getByRole("checkbox", { name: "Confirm copy fallback for the whole group" }).check();
    await expect(copyGroup.getByTestId("confirmed-copy")).toHaveCount(2);

    // 确认后必须重新生成最终预览；确认经指纹校验被保留。
    await page.getByRole("button", { name: "Regenerate final preview" }).click();
    await expect(page.getByText("Link 0 · Copy 2 · No change 0 · Excluded 0 · Still blocked 0")).toBeVisible();
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
    await expect(page.getByText("Link 0 · Copy 7 · No change 0 · Excluded 1 · Still blocked 0")).toBeVisible();

    await page.getByRole("button", { name: "Confirm and add" }).click();
    await expect(page.getByText("Adding finished", { exact: true })).toBeVisible();
    const summary = page.getByTestId("batch-summary");
    await expect(summary).toContainText("7 succeeded");
    await expect(summary).toContainText("1 skipped");
    await expect(summary.getByTestId("batch-outcome-skipped")).toHaveCount(1);
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

test.describe("removal confirmations", () => {
  test("requires a per-deployment choice before deletion and keeps the impact readable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/removal?scenario=impact");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // 打开时焦点进入流程标题。
    await expect(dialog.getByRole("heading", { name: /Delete PDF Reader from the library/ })).toBeFocused();
    const confirm = page.getByRole("button", { name: "Confirm deletion from library" });
    await expect(confirm).toBeDisabled();
    // DEV-97：单目标确认的选项可达名是「Target copy handling：规范化目标路径」。
    await dialog.getByRole("combobox", { name: /Target copy handling：.*\.codex/ }).selectOption("remove_deployment");
    await dialog.getByRole("combobox", { name: /Target copy handling：.*\.claude/ }).selectOption("keep_deployed");
    await expect(confirm).toBeEnabled();
  });

  test("keeps the batch risk next to the forced-deletion action and requires the second click", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/removal?scenario=batch");

    const dialog = page.getByRole("dialog");
    const proceed = page.getByRole("button", { name: "Continue deletion" });
    await expect(proceed).toBeDisabled();
    await dialog.getByRole("combobox", { name: /Target copy handling: Codex CLI/ }).selectOption("remove_deployment");
    await expect(proceed).toBeEnabled();

    // 非原子批量风险与强制删除动作相邻（同一 footer 操作区）。
    const actions = dialog.locator("footer");
    await expect(actions).toContainText(/not atomic/i);
    await expect(actions.getByRole("button", { name: "Continue deletion" })).toBeVisible();

    await proceed.click();
    await expect(page.getByRole("button", { name: /Click again to confirm deleting 2 Skills/ })).toBeVisible();
  });

  test("shows the shared-target undeploy notice and guards the confirm", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/removal?scenario=undeploy-shared");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("This target is shared");
    await expect(page.getByRole("button", { name: "Confirm removal from target" })).toBeDisabled();
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
