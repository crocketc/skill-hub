import { expect, test } from "./fixtures";

test("the saved-translation loop retranslates the description on demand", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf");

  // 转正后原文与译文收纳进「概览」元数据面板的次级展示，评审布局默认展开。
  const panel = page.locator(".sh-metadata-panel");
  const translationField = panel.locator("section.sh-metadata-panel__editable", {
    has: page.getByRole("heading", { name: "Translation text" }),
  });

  // 库内已保存的模型译文与出处事实可见；原文与译文分开展示。
  // 出处事实经评审态 presenter 映射为用户可读措辞，不裸露内部模型标识。
  await expect(translationField.locator("p")).toHaveText("模型译文");
  await expect(page.getByText("示例译文")).toBeVisible();
  await expect(page.getByText("当前内容", { exact: true })).toBeVisible();

  // 真实流接线轮（149c7065）：重翻译不再弹「未配置 AI」说明框，而是发送真实
  // translate_description intent；预览门面模拟后端成功回写，译文随之刷新。
  // 「用户已修订先确认替换」的分支由组件层测试覆盖。
  await panel.getByRole("button", { name: "Translate description again" }).click();
  await expect(page.getByText("Retranslated description (zh-CN)")).toBeVisible();
});

test("the semantic duplicate analysis reports AI candidates as advisory", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf");
  await page.getByRole("link", { name: "使用去向" }).click();

  // 真实流接线轮（149c7065）：确定性候选常显（来自 getInsights，不依赖 AI）；
  // 预览门面 isAiAvailable 返回 true（已配置供应商），AI 分析按钮可点并返回
  // 真实报告，结果如实标注来源且声明仅供参考。
  const duplicates = page.locator("#review-usage-body");
  await expect(duplicates.getByRole("heading", { name: "Deterministic duplicate candidates" })).toBeVisible();
  await expect(duplicates.getByText("PDF Reader（副本）")).toBeVisible();
  await duplicates.getByRole("button", { name: "Run analysis" }).click();
  await expect(
    duplicates.getByText("Source: deterministic candidates + AI semantic analysis"),
  ).toBeVisible();
  await expect(duplicates.getByText("PDF Text Extractor")).toBeVisible();
  await expect(
    duplicates.getByText(/Results are advisory only; merging, deleting or archiving/),
  ).toBeVisible();
});

test("the LLM security check runs on demand and surfaces AI findings", async ({ page }) => {
  await page.goto("/__preview/security-llm");

  const llmCard = page.locator("section", { has: page.getByRole("heading", { name: "LLM security check" }) });
  await expect(llmCard.getByText("Not checked")).toBeVisible();

  await page.getByRole("button", { name: "Run AI check" }).click();
  await expect(llmCard.getByText("Failed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI check findings" })).toBeVisible();
  await expect(page.getByText("Instructions ask the model to exfiltrate environment variables.")).toBeVisible();
  await expect(page.getByText("prompt-injection-risk")).toHaveCount(0);
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
  await page.getByRole("button", { name: "Read candidates from this source" }).click();
  await expect(page.getByRole("button", { name: "Analyze conflicts" })).toBeVisible();
  await page.getByRole("button", { name: "Select all importable candidates" }).click();
  await page.getByRole("button", { name: "Analyze conflicts" }).click();

  // 可选预检：显示对象范围，可跳过或运行；两个对象分别报告通过与失败。
  await expect(page.getByRole("heading", { name: "AI pre-check (optional)" })).toBeVisible();
  await expect(page.getByText("Objects in this pre-check: 2")).toBeVisible();
  await page.getByRole("button", { name: "Run AI pre-check" }).click();
  await expect(page.getByText("Service preview · model preview-model · 2 object(s)")).toBeVisible();
  await expect(page.getByText("Passed", { exact: true })).toBeVisible();
  // P0-06：结构化错误码必须翻译为可读文案，而不是展示裸错误码。
  await expect(
    page.getByText(
      "Pre-check failed for this object; others are unaffected: The model service request timed out. Check the network and try again.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/llm\.request_timeout/)).toHaveCount(0);
  // AI 建议不会自动变成写操作；导入决定仍归用户。
  await expect(page.getByText(/AI suggestions are never turned into write operations automatically/)).toBeVisible();
});
