import { useState } from "react";
import { type SettingsFacade, settingsFixture } from "./api";
import {
  type ConnectionTestResult,
  type LlmAdminFacade,
  type LlmCapabilityState,
  type LlmProviderDraft,
  type LlmProviderPreset,
  type LlmProviderView,
} from "./llmApi";
import { SettingsPage } from "./SettingsPage";

const PREVIEW_PRESETS: LlmProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "open_ai_compatible",
    deployment: "online",
    endpoint: "https://api.deepseek.com/v1",
    requires_credential: true,
    models_hint: "deepseek-chat",
    api_docs_url: "https://api-docs.deepseek.com",
  },
  {
    id: "ollama",
    label: "Ollama",
    protocol: "open_ai_compatible",
    deployment: "local",
    endpoint: "http://127.0.0.1:11434/v1",
    requires_credential: false,
    models_hint: null,
    api_docs_url: null,
  },
];

const PREVIEW_PROVIDERS: LlmProviderView[] = [
  {
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
    credential_configured: true,
    is_default: true,
  },
  {
    config: {
      id: "ollama",
      label: "Ollama",
      protocol: "open_ai_compatible",
      deployment: "local",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b",
      credential_ref: null,
      enabled: false,
    },
    credential_configured: false,
    is_default: false,
  },
];

function previewLlmFacade(): LlmAdminFacade {
  const capabilities: LlmCapabilityState = {
    capabilities: {
      safety_check: true,
      semantic_duplicate: false,
      description_translation: false,
      online_search_assist: false,
    },
    aiOutputLanguage: "system",
  };
  return {
    async listProviders() {
      return PREVIEW_PROVIDERS;
    },
    async listPresets() {
      return PREVIEW_PRESETS;
    },
    async saveProvider() {
      return undefined;
    },
    async deleteProvider() {
      return undefined;
    },
    async setProviderEnabled() {
      return undefined;
    },
    async setDefaultProvider() {
      return undefined;
    },
    async fetchModels() {
      return ["deepseek-chat", "deepseek-reasoner"];
    },
    async testConnection(draft: LlmProviderDraft): Promise<ConnectionTestResult> {
      if (draft.endpoint.includes("127.0.0.1")) {
        // Local runtime is not running in the preview sandbox.
        return {
          endpoint: { reachable: false, latency_ms: null },
          model: null,
          model_failure_code: "llm.endpoint_unreachable",
        };
      }
      return {
        endpoint: { reachable: true, latency_ms: 42 },
        model: { ok: true, latency_ms: 118 },
        model_failure_code: null,
      };
    },
    async readCapabilityState() {
      return capabilities;
    },
    async writeCapabilityState(next: LlmCapabilityState) {
      capabilities.capabilities = next.capabilities;
      capabilities.aiOutputLanguage = next.aiOutputLanguage;
    },
  };
}

export function SettingsLlmPreview() {
  const [facade] = useState<SettingsFacade>(() => ({
    execute: async () => undefined,
    get: async () => settingsFixture(),
    llm: previewLlmFacade(),
  }));
  return <SettingsPage facade={facade} />;
}
