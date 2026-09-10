import { expect, test } from "./fixtures";

test("skill library search narrows results and recovers from an empty filter", async ({ page }) => {
  await page.goto("/__preview/skill-library");

  // T3-B：默认卡片视图下搜索同样即时收窄结果。
  const search = page.getByRole("searchbox", { name: "Search skills" });
  await search.fill("PDF");
  await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "DOCX Writer" })).not.toBeVisible();

  await search.fill("does-not-exist");
  await expect(page.getByText("No skills match the current filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
});

test("skill library defaults to card view and switches to tagged card grouping", async ({ page }) => {
  await page.goto("/__preview/skill-library");

  // T3-B：普通用户默认进入增强卡片视图（共享 SkillCard 语义）。
  await expect(page.getByTestId("skill-cards")).toBeVisible();
  await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
  // 整卡不可点击：打开详情是操作区里的独立按钮。
  await expect(page.getByRole("button", { name: "View PDF Reader" })).toBeVisible();

  await page.getByRole("combobox", { name: "Group by" }).selectOption("tags");
  await expect(page.getByRole("heading", { name: "documents", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "pdf", exact: true })).toBeVisible();
});

test("skill library keeps the professional table reachable with selection", async ({ page }) => {
  await page.goto("/__preview/skill-library");

  await page.getByRole("combobox", { name: "View mode" }).selectOption("table");
  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select PDF Reader" }).check();
  const batchBar = page.getByRole("complementary", { name: "Batch actions" });
  await expect(batchBar).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Start export" })).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Run security check" })).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Delete selected Skills" })).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Export", exact: true })).not.toBeVisible();
});

test("selected skills expose separated batch actions in the default card view", async ({ page }) => {
  await page.goto("/__preview/skill-library");

  await page.getByRole("checkbox", { name: "Select PDF Reader" }).check();
  const batchBar = page.getByRole("complementary", { name: "Batch actions" });
  await expect(batchBar).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Start export" })).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Run security check" })).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Delete selected Skills" })).toBeVisible();
  await expect(batchBar.getByRole("button", { name: "Export", exact: true })).not.toBeVisible();
});

test("quick drawer opens full detail and the version section", async ({ page }) => {
  await page.goto("/__preview/skill-library");

  // T3-B：卡片操作区的“查看”按钮沿用打开前确认的抽屉语义。
  await page.getByRole("button", { name: "View PDF Reader" }).click();
  await expect(page.getByRole("dialog", { name: "PDF Reader" })).toBeVisible();
  await page.getByRole("link", { name: "View and edit full details" }).click();

  await expect(page).toHaveURL(/\/__preview\/skill-detail\/skill-pdf/);
  await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
  // T3-C：详情页导航已重组为五信息区，版本章节位于"生命周期"分区。
  await page.getByRole("link", { name: "Lifecycle" }).click();
  await expect(page).toHaveURL(/#zone-lifecycle$/);
  await expect(page.getByRole("button", { name: /Export this skill/ })).toBeVisible();
});
