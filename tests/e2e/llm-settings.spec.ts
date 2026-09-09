import { expect, test } from "./fixtures";

test("llm provider card lists providers with credential status, badges and the default marker", async ({
  page,
}) => {
  await page.goto("/__preview/settings-llm");

  await expect(page.getByRole("heading", { name: "LLM providers" })).toBeVisible();

  const deepseek = page.locator("li", { has: page.getByText("DeepSeek", { exact: true }) });
  await expect(deepseek.getByText("Online")).toBeVisible();
  await expect(deepseek.getByText("Credential configured")).toBeVisible();
  await expect(deepseek.getByText("Default")).toBeVisible();

  const ollama = page.locator("li", { has: page.getByText("Ollama", { exact: true }) });
  await expect(ollama.getByText("Local")).toBeVisible();
  await expect(ollama.getByText("No credential")).toBeVisible();
});

test("the two-level connection test reports endpoint and model levels separately", async ({
  page,
}) => {
  await page.goto("/__preview/settings-llm");

  const deepseek = page.locator("li", { has: page.getByText("DeepSeek", { exact: true }) });
  await deepseek.getByRole("button", { name: "Test connection" }).click();
  await expect(deepseek.getByText("Model connection available")).toBeVisible();

  const ollama = page.locator("li", { has: page.getByText("Ollama", { exact: true }) });
  await ollama.getByRole("button", { name: "Test connection" }).click();
  await expect(ollama.getByText("Service unreachable")).toBeVisible();
  await expect(ollama.getByText(/Model connection failed/)).toBeVisible();
});

test("capability switches render their data scope and persist a toggle", async ({ page }) => {
  await page.goto("/__preview/settings-llm");

  await expect(page.getByRole("heading", { name: "AI capabilities" })).toBeVisible();
  const safety = page.getByRole("checkbox", { name: "AI safety check" });
  await expect(safety).toBeChecked();
  await expect(page.getByText("Sends: skill file contents (after masking sensitive values)")).toBeVisible();
  await expect(page.getByText("Offline by default")).toBeVisible();

  const duplicate = page.getByRole("checkbox", { name: "AI semantic duplicate analysis" });
  await expect(duplicate).not.toBeChecked();
  await duplicate.check();
  await expect(duplicate).toBeChecked();

  await expect(
    page.getByRole("combobox", { name: "AI output language" }),
  ).toHaveValue("system");
});
