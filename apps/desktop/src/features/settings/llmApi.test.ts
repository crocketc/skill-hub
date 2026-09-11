import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand } from "../../api/bindings";
import { nativeLlmFacade } from "./llmApi";

vi.mock("../../api/bindings", () => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));

const execute = vi.mocked(executeCommand);

beforeEach(() => {
  execute.mockReset();
});

it("clears only the saved credential through the typed native command", async () => {
  execute.mockResolvedValue({
    type: "llm_provider_view",
    payload: {
      config: {
        id: "deepseek",
        label: "DeepSeek",
        protocol: "open_ai_compatible",
        deployment: "online",
        endpoint: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        credential_ref: { id: "llm-provider:deepseek" },
        enabled: true,
      },
      credential_configured: false,
      is_default: true,
    },
  });

  await nativeLlmFacade.clearCredential("deepseek");

  expect(execute).toHaveBeenCalledWith({
    type: "clear_llm_provider_credential",
    payload: { id: "deepseek" },
  });
});
