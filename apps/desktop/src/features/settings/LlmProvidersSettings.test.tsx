import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import {
  type ConnectionTestResult,
  type LlmAdminFacade,
  type LlmProviderDraft,
  type LlmProviderPreset,
  type LlmProviderView,
  unavailableLlmFacade,
} from "./llmApi";
import { LlmProvidersSettings } from "./LlmProvidersSettings";

const PRESETS: LlmProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "open_ai_compatible",
    deployment: "online",
    endpoint: "https://api.deepseek.com/v1",
    requires_credential: true,
    models_hint: null,
    api_docs_url: null,
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

const PROVIDERS: LlmProviderView[] = [
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

type Recording = {
  facade: LlmAdminFacade;
  saves: Array<{ draft: LlmProviderDraft; replaceCredential: boolean }>;
  connectionTests: LlmProviderDraft[];
  testResult?: ConnectionTestResult;
};

function recordingFacade(options: {
  providers?: LlmProviderView[];
  presets?: LlmProviderPreset[];
  testResult?: ConnectionTestResult;
} = {}): Recording {
  const saves: Array<{ draft: LlmProviderDraft; replaceCredential: boolean }> = [];
  const connectionTests: LlmProviderDraft[] = [];
  const facade: LlmAdminFacade = {
    ...unavailableLlmFacade,
    async listProviders() {
      return options.providers ?? [];
    },
    async listPresets() {
      return options.presets ?? PRESETS;
    },
    async saveProvider(draft, replaceCredential) {
      saves.push({ draft, replaceCredential });
    },
    async fetchModels() {
      return ["deepseek-chat", "deepseek-reasoner"];
    },
    async testConnection(draft) {
      connectionTests.push(draft);
      return (
        options.testResult ?? {
          endpoint: { reachable: true, latency_ms: 42 },
          model: { ok: false, latency_ms: null },
          model_failure_code: "llm.auth_failed",
        }
      );
    },
  };
  return { facade, saves, connectionTests, testResult: options.testResult };
}

function renderCard(facade: LlmAdminFacade, i18n: Awaited<ReturnType<typeof createSkillHubI18n>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <LlmProvidersSettings facade={facade} />
      </ThemeProvider>
    </I18nextProvider>,
  );
}

it("lists providers with credential status, deployment badge and default marker", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ providers: PROVIDERS });
  renderCard(facade, i18n);

  const deepseek = await screen.findByText("DeepSeek");
  expect(within(deepseek.closest("li")!).getByText("在线")).toBeVisible();
  expect(within(deepseek.closest("li")!).getByText("凭据已配置")).toBeVisible();
  expect(within(deepseek.closest("li")!).getByText("默认")).toBeVisible();

  const ollama = screen.getByText("Ollama");
  expect(within(ollama.closest("li")!).getByText("本地")).toBeVisible();
  expect(within(ollama.closest("li")!).getByText("未配置凭据")).toBeVisible();
  expect(within(ollama.closest("li")!).getByRole("button", { name: "启用" })).toBeVisible();
});

it("saves a draft through the facade and never sends the credential anywhere else", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, saves } = recordingFacade();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.type(screen.getByLabelText("供应商 ID"), "deepseek");
  await user.type(screen.getByLabelText("API 地址（Base URL）"), "https://api.deepseek.com/v1");
  await user.type(screen.getByLabelText("模型"), "deepseek-chat");
  await user.type(screen.getByLabelText("API 密钥"), "sk-fixture-not-a-real-key");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0]).toEqual({
    draft: {
      id: "deepseek",
      label: "",
      protocol: "open_ai_compatible",
      deployment: "online",
      endpoint: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      credential: "sk-fixture-not-a-real-key",
    },
    replaceCredential: true,
  });
  expect(await screen.findByText("尚未配置 LLM 供应商。")).toBeVisible();
});

it("applies a preset to prefill endpoint and protocol but still requires the model", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, saves } = recordingFacade();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.selectOptions(screen.getByLabelText("从预设选择"), "deepseek");
  expect(screen.getByLabelText("API 地址（Base URL）")).toHaveValue("https://api.deepseek.com/v1");

  await user.type(screen.getByLabelText("模型"), "deepseek-chat");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0].draft).toMatchObject({
    id: "deepseek",
    endpoint: "https://api.deepseek.com/v1",
    protocol: "open_ai_compatible",
    deployment: "online",
  });
});

it("reports the two connection levels and only claims model availability on model success", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({
    providers: [PROVIDERS[0]],
    testResult: {
      endpoint: { reachable: true, latency_ms: 42 },
      model: { ok: false, latency_ms: null },
      model_failure_code: "llm.auth_failed",
    },
  });
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "测试连接" }));

  expect(await screen.findByText("服务可达 (42 ms)")).toBeVisible();
  expect(
    screen.getByText("模型连接失败（llm.auth_failed）；仅服务可达不代表模型可用"),
  ).toBeVisible();
  expect(screen.queryByText("模型连接可用")).not.toBeInTheDocument();
});

it("shows model connection available only when the model level passes", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({
    providers: [PROVIDERS[0]],
    testResult: {
      endpoint: { reachable: true, latency_ms: 30 },
      model: { ok: true, latency_ms: 118 },
      model_failure_code: null,
    },
  });
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "测试连接" }));

  expect(await screen.findByText("模型连接可用")).toBeVisible();
});
