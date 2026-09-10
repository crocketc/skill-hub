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

/** 长文本夹具：120 字符名称、超长端点/模型与长错误码，用于布局验收。 */
const LONG_PROVIDER: LlmProviderView = {
  config: {
    id: "long-provider",
    label: "A".repeat(120),
    protocol: "open_ai_compatible",
    deployment: "online",
    endpoint: "https://gateway.internal.example-microsoft-azure-openai-partner-stack-host/enterprise/v2/deployments/very-long-deployment-name/rest",
    model: "org-team-subscription-enterprise-gateway-model-variant-preview-2026-09-full-context-window",
    credential_ref: { id: "llm-provider:long-provider" },
    enabled: true,
  },
  credential_configured: true,
  is_default: false,
};

/** DEV-only harness knob: ?scenario=long-text 追加长文本供应商。 */
function wantsLongScenario(): boolean {
  return new URLSearchParams(window.location.search).get("scenario") === "long-text";
}

function previewLlmFacade(): LlmAdminFacade {
  const longScenario = wantsLongScenario();
  let providers: LlmProviderView[] = longScenario
    ? [...PREVIEW_PROVIDERS, LONG_PROVIDER]
    : PREVIEW_PROVIDERS;
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
      return providers;
    },
    async listPresets() {
      return PREVIEW_PRESETS;
    },
    async saveProvider(draft: LlmProviderDraft) {
      const existing = providers.find((provider) => provider.config.id === draft.id);
      const config = {
        id: draft.id,
        label: draft.label === "" ? null : draft.label,
        protocol: draft.protocol,
        deployment: draft.deployment,
        endpoint: draft.endpoint,
        model: draft.model,
        credential_ref:
          existing?.config.credential_ref ??
          (draft.deployment === "local" ? null : { id: `llm-provider:${draft.id}` }),
      };
      providers = existing
        ? providers.map((provider) =>
            provider.config.id === draft.id ? { ...provider, config } : provider,
          )
        : [
            ...providers,
            {
              config,
              credential_configured: draft.credential !== null,
              is_default: providers.length === 0,
            },
          ];
    },
    async deleteProvider(id: string) {
      providers = providers.filter((provider) => provider.config.id !== id);
    },
    async setProviderEnabled(id: string, enabled: boolean) {
      providers = providers.map((provider) =>
        provider.config.id === id
          ? { ...provider, config: { ...provider.config, enabled } }
          : provider,
      );
    },
    async setDefaultProvider(id: string | null) {
      providers = providers.map((provider) => ({
        ...provider,
        is_default: provider.config.id === id,
      }));
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
      if (longScenario && draft.id === "long-provider") {
        return {
          endpoint: { reachable: false, latency_ms: null },
          model: null,
          model_failure_code: "llm.provider_not_found_or_unauthorized_very_long_code_suffix",
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
