import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

test.use({ locale: "zh-CN" });

test("governance board stays compact, switches views with selection, and opens the existing impact preview", async ({
  page,
}) => {
  const screenshots = path.resolve(process.cwd(), "test-results/ui/relationship-governance");
  mkdirSync(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/relationship-governance");

  await expect(page.getByRole("note")).toContainText("预览数据");
  const board = page.getByTestId("governance-board");
  await expect(board).toBeVisible();
  await expect(page.getByTestId("governance-board-column-manageable-count")).toHaveText("1");
  await expect(page.getByTestId("governance-board-column-verification-count")).toHaveText("2");
  await expect(page.getByTestId("governance-board-column-blocked-count")).toHaveText("1");
  await expect(page.getByTestId("governance-board-column-settled-count")).toHaveText("2");
  await expect(page.getByTestId("governance-row")).toHaveCount(6);

  const canvas = page.getByTestId("governance-row-list");
  const wideCanvas = await canvas.boundingBox();
  expect(wideCanvas?.height).toBeGreaterThan(250);
  await page.screenshot({
    path: path.join(screenshots, "relationship-governance-board-1440x900.png"),
    fullPage: false,
  });

  const selection = page.getByRole("checkbox", { name: "选择关系 PDF 文档提取" }).first();
  await selection.check();
  await page.getByRole("button", { name: "表格" }).click();
  await expect(page).toHaveURL(/view=table/);
  await expect(page.getByTestId("governance-header-relation")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "选择关系 PDF 文档提取" }).first()).toBeChecked();
  await page.getByRole("button", { name: "看板" }).click();
  await expect(page.getByTestId("governance-board-column-manageable")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "选择关系 PDF 文档提取" }).first()).toBeChecked();

  await page.setViewportSize({ width: 900, height: 600 });
  const narrowCanvas = await canvas.boundingBox();
  await expect(page.getByTestId("governance-board-column-manageable")).toBeVisible();
  await page.screenshot({
    path: path.join(screenshots, "relationship-governance-board-900x600.png"),
    fullPage: false,
  });
  expect(narrowCanvas?.height).toBeGreaterThan(180);

  await page.getByTestId("governance-action-preview:centralize-pdf").click();
  await expect(page.getByRole("dialog", { name: "纳入集中库管理预览" })).toBeVisible();
  await expect(page.getByTestId("governance-centralize-explain")).toContainText("保留当前位置");
  await expect(page.getByTestId("removal-impact-facts")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认执行" })).toBeVisible();
});

test("retained source-copy deep links keep one settled row and use its real status", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/relationship-governance?scope=source_copy&status=retained");

  await expect(page.getByTestId("governance-board-column-settled-count")).toHaveText("1");
  await expect(page.getByTestId("governance-row")).toHaveCount(1);
  await expect(page.getByTestId("governance-row")).toContainText("已保留");
  await expect(page.getByTestId("governance-row")).not.toContainText("已由集中库管理");
});
