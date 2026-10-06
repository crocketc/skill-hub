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

  // 用户主动重翻译：评审原型未接 AI 服务，入口打开数据范围说明框且不发送
  // 内容；按需重翻译的完整链路（夹具 preview-model 刷新路径）由组件层测试
  // 覆盖，待 AI 接线后回到 E2E。
  await panel.getByRole("button", { name: "Translate description again" }).click();
  const aiNotice = page.getByRole("dialog");
  await expect(aiNotice).toContainText("此原型未配置 AI 服务");
  await aiNotice.getByRole("button", { name: "关闭" }).click();
});

test("the semantic duplicate analysis reports AI candidates as advisory", async ({ page }) => {
  await page.goto("/__preview/skill-detail/skill-pdf");
  await page.getByRole("link", { name: "使用去向" }).click();

  // 转正后确定性候选与可选 AI 分析收纳进「使用去向」的补充面板：
  // 确定性候选常显，AI 层是可选增强且只做提示。
  const duplicates = page.locator("#review-usage-body");
  await expect(duplicates.getByRole("heading", { name: "可能重复的技能" })).toBeVisible();
  await expect(
    duplicates.getByText("PDF Text Extractor · 内容比对候选，尚未确认重复。"),
  ).toBeVisible();

  // 已知缺口（评审原型）：AI 相似性分析未接入提供商配置，按钮如实禁用；
  // "AI 结果仅辅助证据、合并/删除/归档需另行确认"的结果提示语义待真实
  // AI 接线后在 E2E 恢复（组件层测试先行覆盖）。
  await expect(duplicates.getByRole("button", { name: "AI 相似性分析" })).toBeDisabled();
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
