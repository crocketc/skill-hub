import { expect, test } from "./fixtures";

test("the saved-translation loop retranslates the description on demand", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf#metadata");

  // P1-12：原文与译文收纳为次级展示，展开后可见出处事实与译文。
  await page.getByText("Original text and translation").click();

  // 库内已保存的模型译文与出处事实可见；原文与译文分开展示。
  const translationField = page.locator("section.sh-metadata-panel__editable", {
    has: page.getByRole("heading", { name: "Translation text" }),
  });
  await expect(translationField.locator("p")).toHaveText("模型译文");
  await expect(page.getByText("local-fixture")).toBeVisible();

  // 用户主动重新翻译后，元数据刷新为新生成的译文。
  await page.getByRole("button", { name: "Translate description again" }).click();
  await expect(translationField.locator("p")).toHaveText("Retranslated description (zh-CN)");
  await expect(page.getByText("preview-model")).toBeVisible();
});

test("the semantic duplicate analysis reports AI candidates as advisory", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf#connections");

  // P1-12：确定性候选常显，AI 分析是可选增强层。
  await expect(
    page.getByRole("heading", { name: "Deterministic duplicate candidates" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Optional AI semantic analysis" })).toBeVisible();

  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.getByText("Source: deterministic candidates + AI semantic analysis")).toBeVisible();
  await expect(page.getByText("PDF Text Extractor")).toBeVisible();
  // AI 结果只做提示：合并/删除/归档始终需要用户另行确认。
  await expect(page.getByText(/merging, deleting or archiving always requires your separate confirmation/)).toBeVisible();
});

test("the LLM security check runs on demand and surfaces AI findings", async ({ page }) => {
  await page.goto("/__preview/security-llm");

  const llmCard = page.locator("section", { has: page.getByRole("heading", { name: "LLM security check" }) });
  await expect(llmCard.getByText("Not checked")).toBeVisible();

  await page.getByRole("button", { name: "Run AI check" }).click();
  await expect(llmCard.getByText("Failed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI check findings" })).toBeVisible();
  await expect(page.getByText("prompt-injection-risk")).toBeVisible();
});

test("AI-assisted online search marks extended hits and keeps the plain query results", async ({
  page,
}) => {
  await page.goto("/__preview/discovery-online");

  // 默认关闭 AI 辅助：普通搜索不出现扩展命中标记。
  await page.getByLabel("Search skills.sh").fill("pdf");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("PDF Reader")).toBeVisible();
  await expect(page.getByTestId("assist-skills.sh/community/pdf-tools")).toHaveCount(0);

  // 开启 AI 辅助：原文未变，扩展命中有标记，并给出明确提示。
  await page.getByLabel("AI search assist").check();
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("status")).toContainText('AI extended query "pdf extraction tables" added 1 hits');
  await expect(page.getByTestId("assist-skills.sh/community/pdf-tools")).toBeVisible();
  await expect(page.getByText("PDF Reader")).toBeVisible();
});

test("the import wizard offers an optional AI pre-check with per-object outcomes", async ({
  page,
}) => {
  await page.goto("/__preview/import-wizard");

  // 走真实向导步骤到冲突处理阶段：来源 → 候选 → 冲突分析。
  await page.getByLabel("Source", { exact: true }).fill("C:/skills/fixture");
  await page.getByRole("button", { name: "Parse source" }).click();
  await page.getByRole("button", { name: "Continue to candidate selection" }).click();
  await page.getByRole("button", { name: "Select all importable candidates" }).click();
  await page.getByRole("button", { name: "Analyze conflicts" }).click();

  // 可选预检：显示对象范围，可跳过或运行；两个对象分别报告通过与失败。
  await expect(page.getByRole("heading", { name: "AI pre-check (optional)" })).toBeVisible();
  await expect(page.getByText("Objects in this pre-check: 2")).toBeVisible();
  await page.getByRole("button", { name: "Run AI pre-check" }).click();
  await expect(page.getByText("Service preview · model preview-model · 2 object(s)")).toBeVisible();
  await expect(page.getByText("Passed", { exact: true })).toBeVisible();
  await expect(page.getByText(/Pre-check failed \(llm.request_timeout\)/)).toBeVisible();
  // AI 建议不会自动变成写操作；导入决定仍归用户。
  await expect(page.getByText(/AI suggestions are never turned into write operations automatically/)).toBeVisible();
});
