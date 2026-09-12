import { expect, test } from "./fixtures";

/**
 * T8（P1-08/P1-11）库页工具栏与通知规范验收：
 * - 卡区点击开快速抽屉，“查看”按钮跳完整详情页，选择控件不触发卡区激活；
 * - 卡片视图“选择当前页”与批量栏共用选择模型；
 * - 批量标签结果走壳层通知服务：toast 2s 退出、历史抽屉保留并可显式清空；
 * - 批量操作条激活时分页控件与其无几何重叠（1024 窄窗与 1600 宽屏各锁一条）。
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

test("batch tag results toast leaves after 2s and stays reachable in the history drawer", async ({
  page,
}) => {
  await page.goto(LIBRARY_ROUTE);
  await page.getByRole("checkbox", { name: "Select PDF Reader" }).check();
  await page.getByRole("button", { name: "Add tags" }).click();

  const dialog = page.getByRole("dialog", { name: "Add tags" });
  await dialog.getByRole("textbox", { name: "Tags" }).fill("review");
  await dialog.getByRole("button", { name: "Add tags" }).click();

  // 新契约：结果先以 toast 呈现（顶栏右侧，未读角标同步）。
  const toast = page.getByText("Batch tag update finished");
  await expect(toast).toBeVisible();
  await expect(page.getByTestId("batch-summary")).toContainText("1 succeeded");
  await expect(
    page.getByRole("button", { name: /Notifications, 1 unread/ }),
  ).toBeVisible();

  // 2s 后 toast 自动退出（轮询等待本身即断言），但记录保留在会话历史中。
  await expect(toast).toBeHidden({ timeout: 4000 });

  const bell = page.getByRole("button", { name: /Notifications/ });
  await bell.click();
  const history = page.getByRole("dialog", { name: "Notifications" });
  await expect(history).toBeVisible();
  await expect(history.getByText("Batch tag update finished")).toBeVisible();

  // 显式清理路径：清空历史后回到空态。
  await history.getByRole("button", { name: "Clear all" }).click();
  await expect(history.getByText("No notifications yet.")).toBeVisible();
  await history.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog", { name: "Notifications" })).toHaveCount(0);
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

test("wide desktop keeps library content reachable and the batch bar clear of the table", async ({
  page,
}) => {
  // >90rem（1440px）真宽屏：skills.css 的 0,2,0 规则同样覆盖 base.css 的
  // height:100%，因此宽屏与窄窗共用同一滚动归属模型——外层内容滚动、区块
  // 随内容生长。用真实几何断言锁定该行为，而不是依赖旧“内部滚动”假设。
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${LIBRARY_ROUTE}?total=80`);

  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();

  // 末列可达：区域横向滚到最右后 security 列头可见（列集恰好放下时本就可见）。
  const region = page.locator(".sh-skill-table__region");
  await region.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(page.locator("th[data-column='security']")).toBeVisible();

  // 批量条激活后滚动到底：末行与分页按钮都必须不被固定批量条遮挡。
  await page.getByRole("checkbox", { name: "Select current page" }).check();
  const batchBar = page.getByRole("complementary", { name: "Batch actions" });
  await expect(batchBar).toContainText("items selected");

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
    const rows = document.querySelectorAll<HTMLElement>(".sh-skill-table tbody tr");
    const lastRow = rows[rows.length - 1] ?? null;
    if (!bar || !button || !lastRow) return { button: false, lastRow: false };
    const barRect = bar.getBoundingClientRect();
    const intersects = (rect: DOMRect) =>
      !(rect.top >= barRect.bottom || rect.bottom <= barRect.top || rect.left >= barRect.right || rect.right <= barRect.left);
    return { button: intersects(button.getBoundingClientRect()), lastRow: intersects(lastRow.getBoundingClientRect()) };
  });
  expect(overlap.button).toBe(false);
  expect(overlap.lastRow).toBe(false);
});
