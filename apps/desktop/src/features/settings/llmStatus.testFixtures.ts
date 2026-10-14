import type { LlmRuntimeStatus } from "./llmApi";

export function createReadyLlmStatusFacade(
  overrides: Partial<LlmRuntimeStatus> = {},
) {
  return {
    async readRuntimeStatus(): Promise<LlmRuntimeStatus> {
      return {
        provider: {
          id: "provider-test",
          deployment: "online",
          endpoint_configured: true,
          model_configured: true,
          credential_configured: true,
          last_connection_test: {
            service_ok: true,
            model_ok: true,
            structured_ok: true,
            tested_at: "2026-10-15T00:00:00Z",
          },
        },
        capabilities: {
          safety_check: true,
          semantic_duplicate: true,
          description_translation: true,
          online_search_assist: true,
        },
        ai_output_language: "system",
        runner_available: true,
        ...overrides,
      };
    },
  };
}
