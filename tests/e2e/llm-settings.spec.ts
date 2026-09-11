import { expect, test } from "./fixtures";

async function openSettingsLlm(page: import("@playwright/test").Page) {
  await page.goto("/__preview/settings-llm");
  await page.getByRole("tab", { name: "Network & AI" }).click();
  await expect(page.getByRole("heading", { name: "LLM providers" })).toBeVisible();
}

test("llm provider rows show endpoint, model, enabled state and credential status", async ({
  page,
}) => {
  await openSettingsLlm(page);

  const deepseek = page.locator("li", { hasText: "DeepSeek" });
  await expect(deepseek.getByText("Online")).toBeVisible();
  await expect(deepseek.getByText("https://api.deepseek.com/v1")).toBeVisible();
  await expect(deepseek.getByText("deepseek-chat")).toBeVisible();
  await expect(deepseek.getByText("Enabled")).toBeVisible();
  await expect(deepseek.getByText("Credential configured")).toBeVisible();
  await expect(deepseek.getByText("Default")).toBeVisible();

  const ollama = page.locator("li", { hasText: "Ollama" });
  await expect(ollama.getByText("Local")).toBeVisible();
  await expect(ollama.getByText("Disabled")).toBeVisible();
  await expect(ollama.getByText("No credential")).toBeVisible();
});

test("the two-level connection test reports endpoint and model levels separately", async ({
  page,
}) => {
  await openSettingsLlm(page);

  const deepseek = page.locator("li", { hasText: "DeepSeek" });
  await deepseek.getByRole("button", { name: "Test connection" }).click();
  await expect(deepseek.getByText("Model connection available")).toBeVisible();

  const ollama = page.locator("li", { hasText: "Ollama" });
  await ollama.getByRole("button", { name: "Test connection" }).click();
  await expect(ollama.getByText("Service unreachable")).toBeVisible();
  // llm.endpoint_unreachable 命中错误目录的专属文案（nativeErrors.keyedMessage），
  // 而非带原始错误码的 modelFailed 回退串。
  await expect(
    ollama.getByText("The model service could not be reached. Check the API address and network settings."),
  ).toBeVisible();
  await expect(ollama.getByText("Model connection available")).not.toBeVisible();
});

test("adding a provider happens in a drawer and the saved row appears at full width", async ({
  page,
}) => {
  await openSettingsLlm(page);

  await page.getByRole("button", { name: "Add provider" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();

  await drawer.getByRole("textbox", { name: "Provider ID" }).fill("mistral");
  await drawer.getByRole("textbox", { name: "Display name" }).fill("Mistral");
  await drawer
    .getByRole("textbox", { name: "API address (Base URL)" })
    .fill("https://api.mistral.ai/v1");
  await drawer.getByRole("combobox", { name: "Model" }).fill("mistral-large-latest");
  await drawer.getByRole("textbox", { name: "API key" }).fill("sk-preview-not-a-real-key");
  await drawer.getByRole("button", { name: "Save" }).click();

  await expect(drawer).not.toBeVisible();
  const mistral = page.locator("li", { hasText: "Mistral" });
  await expect(mistral).toBeVisible();
  await expect(mistral.getByText("https://api.mistral.ai/v1")).toBeVisible();
  await expect(mistral.getByText("Credential configured")).toBeVisible();
});

test("editing keeps the stored credential private and cancel returns focus to the trigger", async ({
  page,
}) => {
  await openSettingsLlm(page);

  const ollama = page.locator("li", { hasText: "Ollama" });
  const editButton = ollama.getByRole("button", { name: "Edit" });
  await editButton.click();

  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "Edit provider" })).toBeVisible();
  await expect(drawer.getByRole("textbox", { name: "Provider ID" })).toHaveValue("ollama");
  await expect(drawer.getByRole("textbox", { name: "Provider ID" })).toBeDisabled();
  await expect(drawer.getByRole("textbox", { name: "API key" })).toHaveValue("");

  await drawer.getByRole("button", { name: "Cancel" }).click();
  await expect(drawer).not.toBeVisible();
  await expect(editButton).toBeFocused();
});

test("deleting requires confirmation and cancel keeps the provider", async ({ page }) => {
  await openSettingsLlm(page);

  const ollama = page.locator("li", { hasText: "Ollama" });
  const deleteButton = ollama.getByRole("button", { name: "Delete" });
  await deleteButton.click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Delete this provider?")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(ollama).toBeVisible();
  await expect(deleteButton).toBeFocused();

  await deleteButton.click();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("li", { hasText: "Ollama" })).not.toBeVisible();
});

test("the drawer disables the draft actions with an explanation until prereqs are met", async ({
  page,
}) => {
  await openSettingsLlm(page);

  await page.getByRole("button", { name: "Add provider" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();

  // 未填端点：获取模型列表禁用并解释原因。
  const fetchButton = drawer.getByRole("button", { name: "Fetch model list" });
  await expect(fetchButton).toBeDisabled();
  await expect(drawer.getByText(/Fill in the API address/)).toBeVisible();
  await expect(fetchButton).toHaveAttribute("aria-describedby", "llm-draft-prereq-hint");

  // 在线部署仍缺密钥：解释切换为需要 API 密钥。
  await drawer.getByRole("textbox", { name: "API address (Base URL)" }).fill("https://api.mistral.ai/v1");
  await expect(drawer.getByText(/Online providers need an API key/)).toBeVisible();
  await expect(fetchButton).toBeDisabled();

  // 填入密钥后按钮可用，解释消失。
  await drawer.getByRole("textbox", { name: "API key" }).fill("sk-preview-not-a-real-key");
  await expect(fetchButton).toBeEnabled();
  await expect(drawer.locator("#llm-draft-prereq-hint")).toHaveCount(0);
});

test("capability switches render their data scope and persist a toggle", async ({ page }) => {
  await openSettingsLlm(page);

  await expect(page.getByRole("heading", { name: "AI capabilities" })).toBeVisible();
  const safety = page.getByRole("switch", { name: "AI safety check" });
  await expect(safety).toBeChecked();
  await expect(
    page.getByText("Sends: skill file contents (after masking sensitive values)"),
  ).toBeVisible();
  await expect(page.getByText("Offline by default")).toBeVisible();

  const duplicate = page.getByRole("switch", { name: "AI semantic duplicate analysis" });
  await expect(duplicate).not.toBeChecked();
  await duplicate.click();
  await expect(duplicate).toBeChecked();

  await expect(
    page.getByRole("combobox", { name: "AI output language" }),
  ).toHaveValue("system");
});
