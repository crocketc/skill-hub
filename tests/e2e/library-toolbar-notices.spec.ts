import { expect, test } from "./fixtures";

/**
 * T8（P1-08/P1-11）库页工具栏与通知规范验收：
 * - 卡区点击开快速抽屉，“查看”按钮跳完整详情页，选择控件不触发卡区激活；
 * - 卡片视图“选择当前页”与批量栏共用选择模型；
 * - 批量标签结果常驻通知：不自动消退、可显式关闭；
 * - 批量操作条激活时分页控件与其无几何重叠。
 */

const LIBRARY_ROUTE = "/__preview/skill-library";

test("card body activation opens the quick drawer and the view button routes to full details", async ({ page }) => {
  await page.goto(LIBRARY_ROUTE);

  // 卡区激活（点击标题）→ 快速抽屉。
  await page.getByRole("heading", { name: "PDF Reader" }).click();
  const drawer = page.getByTestId("skill-quick-drawer");
  await expect(drawer).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toHaveCount(0);

  // “查看”按钮 → 完整详情页路由。
  await page.getByRole("button", { name: "View PDF Reader" }).click();
  await expect(page).toHaveURL(/\/__preview\/skill-detail\/skill-pdf/);
});

test("selection controls never trigger card activation", async ({ page }) => {
  await page.goto(LIBRARY_ROUTE);

  await page.getByRole("checkbox", { name: "Select PDF Reader" }).check();
  const batchBar = page.getByRole("complementary", { name: "Batch actions" });
  await expect(batchBar).toContainText("1 item selected");
  await expect(page.getByTestId("skill-quick-drawer")).toHaveCount(0);
});

test("card view current-page select-all matches the batch bar", async ({ page }) => {
  await page.goto(`${LIBRARY_ROUTE}?total=80`);
  await expect(page.getByTestId("skill-card-skill-pdf")).toBeVisible();

  await page.getByRole("checkbox", { name: "Select current page" }).check();
  const batchBar = page.getByRole("complementary", { name: "Batch actions" });
  await expect(batchBar).toContainText("25 items selected on this page");

  // 取消一张卡片 → 计数与选择模型同步收缩。
  await page.getByRole("checkbox", { name: "Select PDF Reader" }).uncheck();
  await expect(batchBar).toContainText("24 items selected");
});

test("batch tag results land in a persistent notice with an explicit close", async ({ page }) => {
  await page.goto(LIBRARY_ROUTE);
  await page.getByRole("checkbox", { name: "Select PDF Reader" }).check();
  await page.getByRole("button", { name: "Add tags" }).click();

  const dialog = page.getByRole("dialog", { name: "Add tags" });
  await dialog.getByRole("textbox", { name: "Tags" }).fill("review");
  await dialog.getByRole("button", { name: "Add tags" }).click();

  // 批量危险操作的结果常驻：超过自动消退时长后仍在（该等待即断言本身）。
  await expect(page.getByText("Batch tag update finished")).toBeVisible();
  await expect(page.getByTestId("batch-summary")).toContainText("1 succeeded");
  await page.waitForTimeout(6600);
  await expect(page.getByText("Batch tag update finished")).toBeVisible();

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("region", { name: "Notifications" })).toHaveCount(0);
});

test("batch bar never covers the card pagination", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.goto(`${LIBRARY_ROUTE}?total=80`);
  await expect(page.getByTestId("skill-card-skill-pdf")).toBeVisible();

  await page.getByRole("checkbox", { name: "Select current page" }).check();
  // 最坏情况：滚动容器滚到底，分页按钮处于其可达的最低位置。
  const content = page.locator(".sh-app-shell__content");
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const next = page.getByRole("button", { name: "Next page" });
  await expect(next).toBeVisible();

  const overlap = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".sh-skill-library__batch-bar");
    const button = Array.from(document.querySelectorAll("button")).find((element) =>
      element.textContent?.includes("Next"),
    );
    if (!bar || !button) return false;
    const a = bar.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    return !(b.top >= a.bottom || b.bottom <= a.top || b.left >= a.right || b.right <= a.left);
  });
  expect(overlap).toBe(false);
});
