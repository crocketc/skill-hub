import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand } from "../../api/bindings";
import {
  draftFromView,
  nativeLlmFacade,
  type LlmProviderDraft,
  type LlmProviderView,
} from "./llmApi";

vi.mock("../../api/bindings", () => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));

const execute = vi.mocked(executeCommand);

function view(overrides: Partial<LlmProviderView["config"]> = {}): LlmProviderView {
  return {
    config: {
      id: "glm-coding",
      label: "GLM Coding Plan",
      protocol: "open_ai_compatible",
      deployment: "online",
      endpoint: "https://open.bigmodel.cn/api/coding/paas/v4",
      model: "glm-5",
      credential_ref: { id: "llm-provider:glm-coding" },
      enabled: true,
      compatibility_profile: "glm_coding",
      ...overrides,
    },
    credential_configured: true,
    is_default: false,
  };
}

function draft(overrides: Partial<LlmProviderDraft> = {}): LlmProviderDraft {
  return {
    id: "glm-coding",
    label: "GLM Coding Plan",
    protocol: "open_ai_compatible",
    deployment: "online",
    endpoint: "https://open.bigmodel.cn/api/coding/paas/v4",
    model: "glm-5",
    credential: null,
    compatibilityProfile: "glm_coding",
    structuredOutputOverride: null,
    ...overrides,
  };
}

beforeEach(() => {
  execute.mockReset();
});

it("clears only the saved credential through the typed native command", async () => {
  execute.mockResolvedValue({
    type: "llm_provider_view",
    payload: view(),
  });

  await nativeLlmFacade.clearCredential("glm-coding");

  expect(execute).toHaveBeenCalledWith({
    type: "clear_llm_provider_credential",
    payload: { id: "glm-coding" },
  });
});

it("rebuilds an editable draft from a stored provider with its capability profile", () => {
  const rebuilt = draftFromView(view());

  expect(rebuilt.compatibilityProfile).toBe("glm_coding");
  expect(rebuilt.structuredOutputOverride).toBeNull();
  // Editing never echoes the stored credential back into the form.
  expect(rebuilt.credential).toBeNull();
  expect(rebuilt.model).toBe("glm-5");
  expect(rebuilt.endpoint).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
});

it("falls back to the conservative profile for a provider stored before profiles existed", () => {
  // The facade already migrates known legacy rows, so an absent field means a
  // hand-written configuration: never guess a vendor from the id or endpoint.
  expect(draftFromView(view({ compatibility_profile: undefined })).compatibilityProfile).toBe(
    "generic",
  );
});

it("saves the draft capability profile and keeps the secret out of the provider record", async () => {
  execute.mockResolvedValue({ type: "llm_provider_view", payload: view() });

  await nativeLlmFacade.saveProvider(draft({ credential: "sk-live-secret" }), true);

  const command = execute.mock.calls[0]![0];
  if (command.type !== "save_llm_provider") throw new Error("expected a save command");
  expect(command.payload.provider.compatibility_profile).toBe("glm_coding");
  expect(command.payload.provider.structured_output_override).toBeNull();
  // The secret travels only in the dedicated credential field, never inside the
  // provider JSON that is persisted to the database.
  expect(command.payload.credential).toBe("sk-live-secret");
  expect(JSON.stringify(command.payload.provider)).not.toContain("sk-live-secret");
});

it("carries an explicit structured-output override for a generic provider", async () => {
  execute.mockResolvedValue({ type: "llm_provider_view", payload: view() });

  await nativeLlmFacade.saveProvider(
    draft({ compatibilityProfile: "generic", structuredOutputOverride: "prompted_json" }),
    true,
  );

  const command = execute.mock.calls[0]![0];
  if (command.type !== "save_llm_provider") throw new Error("expected a save command");
  expect(command.payload.provider.compatibility_profile).toBe("generic");
  expect(command.payload.provider.structured_output_override).toBe("prompted_json");
});

it("plans model listing and connection probes with the draft capability profile", async () => {
  execute.mockResolvedValueOnce({ type: "llm_models", payload: ["glm-5"] });
  await expect(nativeLlmFacade.fetchModels(draft())).resolves.toEqual(["glm-5"]);
  const fetchCommand = execute.mock.calls[0]![0];
  if (fetchCommand.type !== "fetch_llm_models") throw new Error("expected a model fetch");
  expect(fetchCommand.payload.provider).toEqual({
    kind: "draft",
    payload: { provider: expect.objectContaining({ compatibility_profile: "glm_coding" }) },
  });

  execute.mockResolvedValueOnce({
    type: "connection_test",
    payload: {
      endpoint: { reachable: true, latency_ms: 12 },
      model: { ok: true, latency_ms: 30 },
      model_failure_code: null,
      structured: { ok: false, latency_ms: 45 },
      structured_failure_code: "llm.structured_unavailable",
    },
  });
  const report = await nativeLlmFacade.testConnection(draft());
  expect(report.structured).toEqual({ ok: false, latency_ms: 45 });
  const testCommand = execute.mock.calls[1]![0];
  if (testCommand.type !== "test_llm_connection") throw new Error("expected a probe");
  expect(testCommand.payload.provider).toEqual({
    kind: "draft",
    payload: { provider: expect.objectContaining({ compatibility_profile: "glm_coding" }) },
  });
});

it("plans a model listing even before a model has been typed", async () => {
  execute.mockResolvedValue({ type: "llm_models", payload: [] });

  // The model id is discovered *by* listing, so an empty field must not block it.
  await expect(nativeLlmFacade.fetchModels(draft({ model: "" }))).resolves.toEqual([]);

  const command = execute.mock.calls[0]![0];
  if (command.type !== "fetch_llm_models") throw new Error("expected a model fetch");
  expect(command.payload.credential).toBeNull();
});
