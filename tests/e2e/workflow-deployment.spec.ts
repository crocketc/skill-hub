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

test.describe("deployment flow shell", () => {
  test("exposes the unified step rail and a stable footer for the single flow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment");

    const rail = page.getByRole("list", { name: "Deployment steps" });
    await expect(rail).toBeVisible();
    const steps = rail.getByRole("listitem");
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(0)).toHaveAttribute("aria-current", "step");
    await expect(steps.nth(0)).toContainText("Select targets");
    await expect(steps.nth(3)).toContainText("Results");

    // 流程全程只有一个 footer 操作区；主操作随阶段变化但位置稳定。
    const footer = page.locator("footer");
    await expect(footer).toHaveCount(1);
    const previewButton = page.getByRole("button", { name: "Preview deployment" });
    await expect(previewButton).toBeDisabled();
    await page.getByLabel("Preview Agent 1").check();
    await expect(previewButton).toBeEnabled();
    await expect(footer.getByRole("button", { name: "Preview deployment" })).toBeVisible();
    // 选择阶段：状态区播报当前阶段。
    await expect(page.getByRole("status")).toContainText("Select the targets to deploy");

    await previewButton.click();
    const commitButton = page.getByRole("button", { name: "Commit deployment" });
    await expect(footer.getByRole("button", { name: "Commit deployment" })).toBeVisible();
    await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");

    await commitButton.click();
    await expect(page.getByTestId("deployment-result")).toHaveCount(1);
    await expect(steps.nth(3)).toHaveAttribute("aria-current", "step");
    await expect(page.getByRole("status")).toContainText("Deployment finished");
  });

  test("reports partial failure with its own status and keeps the retry in the footer", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=partial");

    await page.getByLabel("Preview Agent 1").check();
    await page.getByRole("button", { name: "Preview deployment" }).click();
    await page.getByRole("button", { name: "Commit deployment" }).click();

    await expect(page.getByText("Deployment finished with failed targets")).toBeVisible();
    const retry = page.getByRole("button", { name: "Retry failed targets" });
    await expect(retry).toBeVisible();
    await expect(page.locator("footer").getByRole("button", { name: "Retry failed targets" })).toBeVisible();
  });

  test("keeps the target discovery failure alert reachable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=unavailable");

    await expect(page.getByRole("alert")).toContainText(/failed/i);
    await expect(page.getByRole("status")).toContainText(/failed/i);
  });
});

test.describe("batch deployment flow", () => {
  test("keeps the non-atomic risk adjacent to the commit and guards unavailable targets", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=batch");

    await expect(page.getByRole("heading", { name: "Deploy 8 Skills" })).toBeVisible();
    await expect(page.getByLabel("Unavailable target")).toBeDisabled();

    const footer = page.locator("footer");
    await expect(footer).toHaveCount(1);
    // 选择阶段：非原子风险已经在 footer 操作区内。
    await expect(footer).toContainText(/not atomic/i);

    await page.getByLabel("Preview Agent 1").check();
    await page.getByRole("button", { name: "Preview deployment" }).click();
    const commitButton = page.getByRole("button", { name: "Commit deployment" });
    await expect(commitButton).toBeEnabled();
    // 提交动作与非原子风险提示必须同处一个 footer 操作区（相邻）。
    await expect(footer).toContainText(/not atomic/i);
    await expect(footer.getByRole("button", { name: "Commit deployment" })).toBeVisible();
    await expect(page.getByText("preview-skill-8")).toBeVisible();
  });

  test("blocks the commit when a batch preview fails", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/deployment?scenario=batch-preview-fail");

    await page.getByLabel("Preview Agent 1").check();
    await page.getByRole("button", { name: "Preview deployment" }).click();

    await expect(page.getByRole("alert")).toContainText("preview-skill-2");
    await expect(page.getByRole("button", { name: "Commit deployment" })).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("commit is blocked");
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
    await dialog.getByRole("combobox", { name: /Deployment handling：Codex CLI/ }).selectOption("remove_deployment");
    await dialog.getByRole("combobox", { name: /Deployment handling：Claude Code/ }).selectOption("keep_deployed");
    await expect(confirm).toBeEnabled();
  });

  test("keeps the batch risk next to the forced-deletion action and requires the second click", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/removal?scenario=batch");

    const dialog = page.getByRole("dialog");
    const proceed = page.getByRole("button", { name: "Continue to force deletion" });
    await expect(proceed).toBeDisabled();
    await dialog.getByRole("combobox", { name: /Deployment handling: Codex CLI/ }).selectOption("remove_deployment");
    await expect(proceed).toBeEnabled();

    // 非原子批量风险与强制删除动作相邻（同一 footer 操作区）。
    const actions = dialog.locator("footer");
    await expect(actions).toContainText(/not atomic/i);
    await expect(actions.getByRole("button", { name: "Continue to force deletion" })).toBeVisible();

    await proceed.click();
    await expect(page.getByRole("button", { name: /Click again to confirm deleting 2 Skills/ })).toBeVisible();
  });

  test("shows the shared-target undeploy notice and guards the confirm", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__preview/removal?scenario=undeploy-shared");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("This target is shared");
    await expect(page.getByRole("button", { name: "Confirm undeploy" })).toBeDisabled();
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
      await page.getByRole("button", { name: "Preview deployment" }).click();
      await page.getByRole("button", { name: "Commit deployment" }).click();
      await expect(page.getByText("Deployment finished with failed targets")).toBeVisible();
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
        await expect(page.getByRole("heading", { name: "Deploy 60 Skills" })).toBeVisible();
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
    await page.getByRole("button", { name: "Preview deployment" }).click();
    await expect(page.getByRole("heading", { name: "Deployment plan" })).toBeVisible();
    // 面板是唯一滚动所有者：footer 操作区保持可见且不遮挡焦点。
    await expect(page.getByRole("button", { name: "Commit deployment" })).toBeVisible();
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
      await expect(page.getByRole("list", { name: "Deployment steps" })).toBeVisible();

      await page.getByLabel("Preview Agent 1").check();
      await page.getByRole("button", { name: "Preview deployment" }).click();
      const commitButton = page.getByRole("button", { name: "Commit deployment" });
      await expect(commitButton).toBeVisible();
      await commitButton.focus();
      const focused = await page.evaluate(() => document.activeElement?.tagName ?? "");
      expect(focused).toBe("BUTTON");
      await expect(page.getByRole("status")).toBeVisible();

      await page.goto("/__preview/removal?scenario=batch");
      await expectNoRootHorizontalOverflow(page);
      await expect(page.getByRole("dialog").getByRole("heading", { name: "Review batch deletion impact" })).toBeVisible();
      await expect(page.getByRole("dialog").locator("footer")).toContainText(/not atomic/i);
    });
  }
});
