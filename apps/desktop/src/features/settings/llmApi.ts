import {
  executeCommand,
  queryApplication,
  type ConnectionTestResult,
  type DesktopPreferences,
  type LlmCapabilitySettings,
  type LlmDeployment,
  type LlmProtocolFamily,
  type LlmProviderConfig,
  type LlmProviderPreset,
  type LlmProviderView,
} from "../../api/bindings";

export type {
  ConnectionTestResult,
  LlmCapabilitySettings,
  LlmDeployment,
  LlmProtocolFamily,
  LlmProviderConfig,
  LlmProviderPreset,
  LlmProviderView,
};

/** What the settings form collects. The credential value is transported to
 * the OS store through `save_llm_provider` only and never persisted anywhere
 * else by the UI. */
export type LlmProviderDraft = {
  id: string;
  label: string;
  protocol: LlmProtocolFamily;
  deployment: LlmDeployment;
  endpoint: string;
  model: string;
  credential: string | null;
};

export type LlmCapabilityState = {
  capabilities: LlmCapabilitySettings;
  aiOutputLanguage: string;
};

export interface LlmAdminFacade {
  listProviders(): Promise<LlmProviderView[]>;
  listPresets(): Promise<LlmProviderPreset[]>;
  saveProvider(draft: LlmProviderDraft, replaceCredential: boolean): Promise<void>;
  clearCredential(id: string): Promise<void>;
  deleteProvider(id: string): Promise<void>;
  setProviderEnabled(id: string, enabled: boolean): Promise<void>;
  setDefaultProvider(id: string | null): Promise<void>;
  fetchModels(draft: LlmProviderDraft): Promise<string[]>;
  testConnection(draft: LlmProviderDraft): Promise<ConnectionTestResult>;
  readCapabilityState(): Promise<LlmCapabilityState>;
  writeCapabilityState(next: LlmCapabilityState): Promise<void>;
}

function providerConfig(draft: LlmProviderDraft): LlmProviderConfig {
  const needsCredential = draft.credential !== null || !deploymentNeedsNoCredential(draft);
  return {
    id: draft.id,
    label: draft.label === "" ? null : draft.label,
    protocol: draft.protocol,
    deployment: draft.deployment,
    endpoint: draft.endpoint,
    model: draft.model,
    credential_ref: needsCredential ? { id: `llm-provider:${draft.id}` } : null,
  };
}

function deploymentNeedsNoCredential(draft: LlmProviderDraft): boolean {
  // Local runtimes (Ollama, LM Studio) need no secret; only a Local deployment
  // skips the credential reference.
  return draft.deployment === "local" && draft.credential === null;
}

export const unavailableLlmFacade: LlmAdminFacade = {
  async listProviders() {
    throw new Error("LLM administration is unavailable in this context.");
  },
  async listPresets() {
    throw new Error("LLM administration is unavailable in this context.");
  },
  async saveProvider() {
    throw new Error("LLM administration is unavailable in this context.");
  },
  async clearCredential() {
    throw new Error("LLM administration is unavailable in this context.");
  },
  async deleteProvider() {
    throw new Error("LLM administration is unavailable in this context.");
  },
  async setProviderEnabled() {
    throw new Error("LLM administration is unavailable in this context.");
  },
  async setDefaultProvider() {
    throw new Error("LLM administration is unavailable in this context.");
  },
  async fetchModels() {
    throw new Error("LLM administration is unavailable in this context.");
  },
  async testConnection() {
    throw new Error("LLM administration is unavailable in this context.");
  },
  async readCapabilityState() {
    throw new Error("LLM administration is unavailable in this context.");
  },
  async writeCapabilityState() {
    throw new Error("LLM administration is unavailable in this context.");
  },
};

async function preferences(): Promise<DesktopPreferences> {
  const result = await queryApplication({ type: "get_desktop_preferences" });
  if (result.type !== "desktop_preferences") {
    throw new Error("get_desktop_preferences returned an unexpected native result.");
  }
  return result.payload;
}

/** Production binding: typed Tauri commands only; no component touches the
 * network or the credential store directly. */
export const nativeLlmFacade: LlmAdminFacade = {
  async listProviders() {
    const result = await queryApplication({ type: "list_llm_providers" });
    if (result.type !== "llm_providers") {
      throw new Error("list_llm_providers returned an unexpected native result.");
    }
    return result.payload;
  },
  async listPresets() {
    const result = await queryApplication({ type: "list_llm_provider_presets" });
    if (result.type !== "llm_provider_presets") {
      throw new Error("list_llm_provider_presets returned an unexpected native result.");
    }
    return result.payload;
  },
  async saveProvider(draft, replaceCredential) {
    const result = await executeCommand({
      type: "save_llm_provider",
      payload: {
        provider: providerConfig(draft),
        credential: replaceCredential ? draft.credential : null,
      },
    });
    if (result.type !== "llm_provider_view") {
      throw new Error("save_llm_provider returned an unexpected native result.");
    }
  },
  async clearCredential(id) {
    const result = await executeCommand({
      type: "clear_llm_provider_credential",
      payload: { id },
    });
    if (result.type !== "llm_provider_view") {
      throw new Error("clear_llm_provider_credential returned an unexpected native result.");
    }
  },
  async deleteProvider(id) {
    await executeCommand({ type: "delete_llm_provider", payload: { id } });
  },
  async setProviderEnabled(id, enabled) {
    await executeCommand({ type: "set_llm_provider_enabled", payload: { id, enabled } });
  },
  async setDefaultProvider(id) {
    await executeCommand({ type: "set_default_llm_provider", payload: { id } });
  },
  async fetchModels(draft) {
    const result = await executeCommand({
      type: "fetch_llm_models",
      payload: {
        provider: { kind: "draft", payload: { provider: providerConfig(draft) } },
        credential: draft.credential,
      },
    });
    if (result.type !== "llm_models") {
      throw new Error("fetch_llm_models returned an unexpected native result.");
    }
    return result.payload;
  },
  async testConnection(draft) {
    const result = await executeCommand({
      type: "test_llm_connection",
      payload: {
        provider: { kind: "draft", payload: { provider: providerConfig(draft) } },
        credential: draft.credential,
      },
    });
    if (result.type !== "connection_test") {
      throw new Error("test_llm_connection returned an unexpected native result.");
    }
    return result.payload;
  },
  async readCapabilityState() {
    const value = await preferences();
    return {
      capabilities: value.llm_capabilities ?? {},
      aiOutputLanguage: value.ai_output_language ?? "system",
    };
  },
  async writeCapabilityState(next) {
    const current = await preferences();
    const merged: DesktopPreferences = {
      ...current,
      llm_capabilities: next.capabilities,
      ai_output_language: next.aiOutputLanguage,
    };
    await executeCommand({ type: "set_desktop_preferences", payload: merged });
  },
};
