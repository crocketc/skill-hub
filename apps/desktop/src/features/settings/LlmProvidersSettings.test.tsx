import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
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

function mockReducedMotion() {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  fetchModelsError?: unknown;
  testConnectionError?: unknown;
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
      if (options.fetchModelsError !== undefined) throw options.fetchModelsError;
      return ["deepseek-chat", "deepseek-reasoner"];
    },
    async testConnection(draft) {
      connectionTests.push(draft);
      if (options.testConnectionError !== undefined) throw options.testConnectionError;
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

it("renders every provider as a full-width entity row with endpoint, model and enabled state", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ providers: PROVIDERS });
  renderCard(facade, i18n);

  const rows = await screen.findAllByRole("listitem");
  expect(rows).toHaveLength(2);

  const deepseek = within(rows[0]!);
  expect(deepseek.getByText("https://api.deepseek.com/v1")).toBeVisible();
  expect(deepseek.getByText("deepseek-chat")).toBeVisible();
  expect(deepseek.getByText("在线")).toBeVisible();
  expect(deepseek.getByText("已启用")).toBeVisible();
  expect(deepseek.getByText("默认")).toBeVisible();
  expect(deepseek.getByText("凭据已配置")).toBeVisible();

  const ollama = within(rows[1]!);
  expect(ollama.getByText("http://127.0.0.1:11434/v1")).toBeVisible();
  expect(ollama.getByText("已停用")).toBeVisible();
  expect(ollama.getByRole("button", { name: "启用" })).toBeVisible();
});

it("saves a draft through the facade and never sends the credential anywhere else", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, saves } = recordingFacade();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.type(await screen.findByRole("textbox", { name: "供应商 ID" }), "deepseek");
  await user.type(screen.getByRole("textbox", { name: "API 地址（Base URL）" }), "https://api.deepseek.com/v1");
  await user.type(screen.getByRole("combobox", { name: "模型" }), "deepseek-chat");
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

it("opens the add form in a drawer and returns focus to the trigger on cancel", async () => {
  mockReducedMotion();
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ providers: PROVIDERS });
  renderCard(facade, i18n);

  const trigger = await screen.findByRole("button", { name: "新增供应商" });
  await user.click(trigger);

  const drawer = screen.getByRole("dialog");
  expect(drawer).toBeVisible();
  expect(within(drawer).getByRole("heading", { name: "供应商配置" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "取消" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

it("opens edit in the drawer with prefilled identity and an empty credential", async () => {
  mockReducedMotion();
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ providers: PROVIDERS });
  renderCard(facade, i18n);

  const row = (await screen.findByText("DeepSeek")).closest("li")!;
  const editButton = within(row).getByRole("button", { name: "编辑" });
  await user.click(editButton);

  const drawer = screen.getByRole("dialog");
  expect(within(drawer).getByRole("heading", { name: "编辑供应商" })).toBeVisible();

  const providerId = within(drawer).getByRole("textbox", { name: "供应商 ID" }) as HTMLInputElement;
  expect(providerId).toHaveValue("deepseek");
  expect(providerId).toBeDisabled();
  expect(within(drawer).getByRole("textbox", { name: "API 地址（Base URL）" })).toHaveValue(
    "https://api.deepseek.com/v1",
  );
  expect(within(drawer).getByRole("combobox", { name: "模型" })).toHaveValue("deepseek-chat");
  // 凭据不回显：即使系统凭据存储中已配置，输入框也保持为空。
  expect(within(drawer).getByLabelText("API 密钥")).toHaveValue("");
});

it("keeps the stored credential when saving an edit without typing a new one", async () => {
  mockReducedMotion();
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, saves } = recordingFacade({ providers: PROVIDERS });
  renderCard(facade, i18n);

  const row = (await screen.findByText("Ollama")).closest("li")!;
  await user.click(within(row).getByRole("button", { name: "编辑" }));

  await user.type(await screen.findByRole("combobox", { name: "模型" }), "-instruct");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0]).toEqual({
    draft: {
      id: "ollama",
      label: "Ollama",
      protocol: "open_ai_compatible",
      deployment: "local",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b-instruct",
      credential: null,
    },
    replaceCredential: false,
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("applies a preset to prefill endpoint and protocol but still requires the model", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, saves } = recordingFacade();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.selectOptions(screen.getByLabelText("从预设选择"), "deepseek");
  expect(screen.getByRole("textbox", { name: "API 地址（Base URL）" })).toHaveValue("https://api.deepseek.com/v1");

  await user.type(screen.getByRole("combobox", { name: "模型" }), "deepseek-chat");
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
    screen.getByText("模型服务拒绝了凭据，请重新检查 API 密钥。"),
  ).toBeVisible();
  expect(screen.queryByText("模型连接可用")).not.toBeInTheDocument();
});

it("shows the endpoint-unreachable scenario as separate statuses without a success claim", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({
    providers: [PROVIDERS[0]],
    testResult: {
      endpoint: { reachable: false, latency_ms: null },
      model: null,
      model_failure_code: "llm.endpoint_unreachable",
    },
  });
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "测试连接" }));

  const report = await screen.findByText("服务不可达").then((node) => node.closest("ul"));
  expect(report).not.toBeNull();
  expect(
    within(report!).getByText("无法连接到模型服务，请检查 API 地址和网络设置。"),
  ).toBeVisible();
  // 两级结果不合并：服务失败时不得出现任何“可达/可用”成功文案。
  expect(screen.queryByText("服务可达")).not.toBeInTheDocument();
  expect(screen.queryByText("模型连接可用")).not.toBeInTheDocument();
  // 状态不只靠颜色：每一级状态带装饰图标。
  expect(report!.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
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

it("requires confirmation before deleting and keeps the provider on cancel", async () => {
  mockReducedMotion();
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ providers: [PROVIDERS[1]] });
  let deleteCalls = 0;
  facade.deleteProvider = Object.assign(async () => {
    deleteCalls += 1;
  }, {});
  renderCard(facade, i18n);

  const row = (await screen.findByText("Ollama")).closest("li")!;
  const deleteButton = within(row).getByRole("button", { name: "删除" });
  await user.click(deleteButton);

  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText("删除此供应商？")).toBeVisible();
  expect(deleteCalls).toBe(0);

  await user.click(within(dialog).getByRole("button", { name: "取消" }));

  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(deleteCalls).toBe(0);
  expect(screen.getByText("Ollama")).toBeVisible();
  // 取消后焦点返回删除触发器。
  expect(deleteButton).toHaveFocus();
});

it("deletes the provider after explicit confirmation", async () => {
  mockReducedMotion();
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ providers: [PROVIDERS[1]] });
  let deleteCalls = 0;
  facade.deleteProvider = Object.assign(async () => {
    deleteCalls += 1;
  }, {});
  renderCard(facade, i18n);

  const row = (await screen.findByText("Ollama")).closest("li")!;
  await user.click(within(row).getByRole("button", { name: "删除" }));

  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }),
  );

  await waitFor(() => expect(deleteCalls).toBe(1));
});

it("keeps the provider row and shows a readable error when deletion fails", async () => {
  mockReducedMotion();
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ providers: [PROVIDERS[1]] });
  facade.deleteProvider = Object.assign(async () => {
    throw { code: "llm.provider_in_use", severity: "error", params: {}, actions: [] };
  }, {});
  renderCard(facade, i18n);

  const row = (await screen.findByText("Ollama")).closest("li")!;
  await user.click(within(row).getByRole("button", { name: "删除" }));

  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }),
  );

  expect(await screen.findByText(/操作失败（llm\.provider_in_use）/)).toBeVisible();
  expect(screen.getByText("Ollama")).toBeVisible();
});

it("offers a confirmed credential-only clear action and shows success", async () => {
  mockReducedMotion();
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ providers: [PROVIDERS[0]] });
  let clearCalls = 0;
  const clearable = Object.assign(facade, {
    async clearCredential() {
      clearCalls += 1;
    },
  });
  renderCard(clearable, i18n);

  const row = (await screen.findByText("DeepSeek")).closest("li")!;
  await user.click(within(row).getByRole("button", { name: "清除凭据" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText("清除已保存的凭据？")).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "清除凭据" }));

  await waitFor(() => expect(clearCalls).toBe(1));
  expect(await screen.findByRole("status")).toHaveTextContent("凭据已清除");
  expect(screen.getByText("DeepSeek")).toBeVisible();
});

it("keeps the provider row and shows a failure when clearing the credential fails", async () => {
  mockReducedMotion();
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ providers: [PROVIDERS[0]] });
  const clearable = Object.assign(facade, {
    async clearCredential() {
      throw { code: "llm.credential_delete_failed", severity: "error", params: {}, actions: [] };
    },
  });
  renderCard(clearable, i18n);

  const row = (await screen.findByText("DeepSeek")).closest("li")!;
  await user.click(within(row).getByRole("button", { name: "清除凭据" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "清除凭据" }),
  );

  expect(await screen.findByText(/操作失败（llm\.credential_delete_failed）/)).toBeVisible();
  expect(screen.getByText("DeepSeek")).toBeVisible();
});

const STRUCTURED_NATIVE_ERROR = {
  code: "network.disabled",
  severity: "error",
  params: {},
  actions: [],
};

async function openFilledDraftForm(i18n: Awaited<ReturnType<typeof createSkillHubI18n>>, facade: LlmAdminFacade) {
  const user = userEvent.setup();
  renderCard(facade, i18n);
  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.type(screen.getByRole("textbox", { name: "供应商 ID" }), "deepseek");
  await user.type(screen.getByRole("textbox", { name: "API 地址（Base URL）" }), "https://api.deepseek.com/v1");
  await user.type(screen.getByRole("combobox", { name: "模型" }), "deepseek-chat");
  await user.type(screen.getByLabelText("API 密钥"), "sk-acceptance-not-real");
  return user;
}

it("shows a readable localized error instead of [object Object] when fetching models fails", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ fetchModelsError: STRUCTURED_NATIVE_ERROR });
  const user = await openFilledDraftForm(i18n, facade);

  await user.click(screen.getByRole("button", { name: "获取模型列表" }));

  expect(
    await screen.findByText("网络功能已关闭；需要在设置中开启后才能联网操作。"),
  ).toBeVisible();
  expect(screen.queryByText(/object Object/i)).not.toBeInTheDocument();
});

it("shows a localized unconfigured message when model listing has no LLM runtime", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({
    fetchModelsError: { code: "llm.not_configured", severity: "info", params: {}, actions: [] },
  });
  const user = await openFilledDraftForm(i18n, facade);

  await user.click(screen.getByRole("button", { name: "获取模型列表" }));

  expect(await screen.findByText("尚未配置可用的 LLM 供应商，请先添加并启用供应商。"))
    .toBeVisible();
  expect(screen.queryByText(/settings\.llm\./)).not.toBeInTheDocument();
  expect(screen.queryByText(/object Object/i)).not.toBeInTheDocument();
});

it("explains that a cleared credential must be entered again when model listing fails", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({
    fetchModelsError: { code: "credential.unavailable", severity: "error", params: {}, actions: [] },
  });
  const user = await openFilledDraftForm(i18n, facade);

  await user.click(screen.getByRole("button", { name: "获取模型列表" }));

  expect(await screen.findByText("凭据不可用，可能已被清除；请重新输入 API 密钥。"))
    .toBeVisible();
  expect(screen.queryByText(/settings\.llm\./)).not.toBeInTheDocument();
});

it("keeps the draft and tells the user to fill the model manually when fetching models fails", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ fetchModelsError: STRUCTURED_NATIVE_ERROR });
  const user = await openFilledDraftForm(i18n, facade);

  await user.click(screen.getByRole("button", { name: "获取模型列表" }));

  expect(await screen.findByText(/可手动填写模型/)).toBeVisible();
  expect(screen.getByRole("textbox", { name: "API 地址（Base URL）" })).toHaveValue("https://api.deepseek.com/v1");
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveValue("deepseek-chat");
  expect(screen.getByLabelText("API 密钥")).toHaveValue("sk-acceptance-not-real");
});

it("clears the failure hint after a successful retry fetches the model list", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  let calls = 0;
  const { facade } = recordingFacade();
  facade.fetchModels = Object.assign(async () => {
    calls += 1;
    if (calls === 1) throw STRUCTURED_NATIVE_ERROR;
    return ["deepseek-chat"];
  }, {});
  const user = await openFilledDraftForm(i18n, facade);

  await user.click(screen.getByRole("button", { name: "获取模型列表" }));
  expect(await screen.findByText(/可手动填写模型/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "获取模型列表" }));

  await waitFor(() =>
    expect(screen.queryByText(/可手动填写模型/)).not.toBeInTheDocument(),
  );
  expect(screen.queryByText(/操作失败/)).not.toBeInTheDocument();
});

it("reports a readable error instead of [object Object] when the draft connection test fails", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({
    testConnectionError: {
      code: "llm.auth_failed",
      severity: "error",
      params: {},
      actions: [],
    },
  });
  const user = await openFilledDraftForm(i18n, facade);

  await user.click(screen.getByRole("button", { name: "测试此配置" }));

  expect(await screen.findByText("模型服务拒绝了凭据，请重新检查 API 密钥。"))
    .toBeVisible();
  expect(screen.queryByText(/操作失败（llm\.auth_failed）/)).not.toBeInTheDocument();
  expect(screen.queryByText(/object Object/i)).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "API 地址（Base URL）" })).toHaveValue("https://api.deepseek.com/v1");
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveValue("deepseek-chat");
});

it("clears the rendered draft test result when the model field changes", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({
    testResult: {
      endpoint: { reachable: true, latency_ms: 42 },
      model: { ok: true, latency_ms: 88 },
    },
  });
  const user = await openFilledDraftForm(i18n, facade);

  await user.click(screen.getByRole("button", { name: "测试此配置" }));
  expect(await screen.findByText(/模型连接可用/)).toBeVisible();

  // 模型变了，旧的测试结果不再可信——必须立即清除，不能留着误导保存。
  await user.type(screen.getByRole("combobox", { name: "模型" }), "-v2");

  expect(screen.queryByText(/模型连接可用/)).not.toBeInTheDocument();
  expect(screen.queryByText(/服务可达/)).not.toBeInTheDocument();
});

it("reports localized required-field messages instead of the browser validation bubble", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, saves } = recordingFacade();
  const user = userEvent.setup();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByText("请填写供应商 ID。")).toBeVisible();
  expect(screen.getByText("请填写API 地址（Base URL）。")).toBeVisible();
  expect(screen.getByText("请填写模型。")).toBeVisible();
  expect(screen.queryByText(/fill out this field/i)).not.toBeInTheDocument();
  expect(saves).toHaveLength(0);

  // 每个字段各自标记无效，并把键盘焦点送到第一个无效字段。
  const providerId = screen.getByRole("textbox", { name: "供应商 ID" });
  expect(providerId).toHaveFocus();
  expect(providerId).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("textbox", { name: "API 地址（Base URL）" })).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveAttribute("aria-invalid", "true");
});

// P1-03 LLM 表单状态机：先填地址、密钥，才可获取模型/测试此配置；
// 前置不足时按钮禁用并解释原因；local 部署豁免密钥；编辑沿用已存凭据；
// 测试结果必须在抽屉内渲染；手填模型路径保持完整。

it("disables the draft actions until the endpoint is filled and explains why", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade();
  const user = userEvent.setup();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));

  const fetchButton = within(screen.getByRole("dialog")).getByRole("button", { name: "获取模型列表" });
  const testButton = within(screen.getByRole("dialog")).getByRole("button", { name: "测试此配置" });
  expect(fetchButton).toBeDisabled();
  expect(testButton).toBeDisabled();

  // 禁用并解释：解释文本常驻，按钮通过 aria-describedby 指向它。
  const hint = within(screen.getByRole("dialog")).getByText("先填写 API 地址（Base URL），才能获取模型列表或测试此配置。");
  expect(hint).toHaveAttribute("id", "llm-draft-prereq-hint");
  expect(fetchButton).toHaveAttribute("aria-describedby", "llm-draft-prereq-hint");
  expect(testButton).toHaveAttribute("aria-describedby", "llm-draft-prereq-hint");
  expect(fetchButton).toHaveAttribute("title", hint.textContent!);
});

it("keeps the draft actions disabled with a credential explanation until the key is filled", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade();
  const user = userEvent.setup();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.type(screen.getByRole("textbox", { name: "API 地址（Base URL）" }), "https://api.deepseek.com/v1");

  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "获取模型列表" })).toBeDisabled();
  expect(
    within(screen.getByRole("dialog")).getByText(
      "在线供应商需要先填写 API 密钥（或使用已保存凭据），才能获取模型列表或测试此配置。",
    ),
  ).toBeVisible();
  expect(
    screen.queryByText("先填写 API 地址（Base URL），才能获取模型列表或测试此配置。"),
  ).not.toBeInTheDocument();

  await user.type(screen.getByLabelText("API 密钥"), "sk-acceptance-not-real");

  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "获取模型列表" })).toBeEnabled();
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "测试此配置" })).toBeEnabled();
  expect(screen.getByRole("dialog").querySelector("#llm-draft-prereq-hint")).toBeNull();
});

it("fetches models into the datalist and renders the two-level test result inside the drawer", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({
    testResult: {
      endpoint: { reachable: true, latency_ms: 42 },
      model: { ok: true, latency_ms: 118 },
      model_failure_code: null,
    },
  });
  const fetchCalls: LlmProviderDraft[] = [];
  facade.fetchModels = Object.assign(async (draft: LlmProviderDraft) => {
    fetchCalls.push(draft);
    return ["deepseek-chat", "deepseek-reasoner"];
  }, {});
  const user = userEvent.setup();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.type(screen.getByRole("textbox", { name: "API 地址（Base URL）" }), "https://api.deepseek.com/v1");
  await user.type(screen.getByLabelText("API 密钥"), "sk-acceptance-not-real");

  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "获取模型列表" }));
  await waitFor(() => expect(fetchCalls).toHaveLength(1));
  const drawer = screen.getByRole("dialog");
  expect(drawer.querySelector('#llm-model-options option[value="deepseek-chat"]')).not.toBeNull();
  expect(drawer.querySelector('#llm-model-options option[value="deepseek-reasoner"]')).not.toBeNull();

  // 测试此配置无需保存：两级结果直接渲染在抽屉内。
  await user.click(within(drawer).getByRole("button", { name: "测试此配置" }));
  expect(await within(drawer).findByText("服务可达 (42 ms)")).toBeVisible();
  expect(within(drawer).getByText("模型连接可用")).toBeVisible();
});

it("announces the in-progress state while the draft connection test runs", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade();
  let resolveTest: (result: ConnectionTestResult) => void = () => {};
  facade.testConnection = Object.assign(
    () =>
      new Promise<ConnectionTestResult>((resolve) => {
        resolveTest = resolve;
      }),
    {},
  );
  const user = userEvent.setup();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.type(screen.getByRole("textbox", { name: "API 地址（Base URL）" }), "https://api.deepseek.com/v1");
  await user.type(screen.getByLabelText("API 密钥"), "sk-acceptance-not-real");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "测试此配置" }));

  expect(await within(screen.getByRole("dialog")).findByText("正在测试此配置…")).toBeVisible();

  resolveTest({
    endpoint: { reachable: true, latency_ms: 10 },
    model: { ok: true, latency_ms: 20 },
    model_failure_code: null,
  });
  expect(await within(screen.getByRole("dialog")).findByText("服务可达 (10 ms)")).toBeVisible();
});

it("enables the draft actions for a local deployment without a credential", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade();
  const user = userEvent.setup();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.selectOptions(screen.getByLabelText("从预设选择"), "ollama");

  expect(screen.getByRole("textbox", { name: "API 地址（Base URL）" })).toHaveValue("http://127.0.0.1:11434/v1");
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "获取模型列表" })).toBeEnabled();
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "测试此配置" })).toBeEnabled();
  expect(screen.getByRole("dialog").querySelector("#llm-draft-prereq-hint")).toBeNull();
});

it("treats an edit with a stored credential as ready without retyping the key", async () => {
  mockReducedMotion();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({ providers: [PROVIDERS[0]] });
  const user = userEvent.setup();
  renderCard(facade, i18n);

  const row = (await screen.findByText("DeepSeek")).closest("li")!;
  await user.click(within(row).getByRole("button", { name: "编辑" }));

  const drawer = screen.getByRole("dialog");
  expect(within(drawer).getByLabelText("API 密钥")).toHaveValue("");
  expect(within(drawer).getByRole("button", { name: "获取模型列表" })).toBeEnabled();
  expect(within(drawer).getByRole("button", { name: "测试此配置" })).toBeEnabled();
  expect(within(drawer).queryByText("在线供应商需要先填写 API 密钥（或使用已保存凭据），才能获取模型列表或测试此配置。"))
    .not.toBeInTheDocument();
});

it("keeps the manual model path intact after a failed fetch and still saves the draft", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, saves } = recordingFacade({ fetchModelsError: STRUCTURED_NATIVE_ERROR });
  const user = await openFilledDraftForm(i18n, facade);

  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "获取模型列表" }));

  // 失败信息与手填提示都出现在抽屉内，草稿不被清除。
  expect(await within(screen.getByRole("dialog")).findByText(/网络功能已关闭/)).toBeVisible();
  expect(await within(screen.getByRole("dialog")).findByText(/可手动填写模型/)).toBeVisible();
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveValue("deepseek-chat");

  await user.type(screen.getByRole("textbox", { name: "供应商 ID" }), "-prod");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0]!.draft.id).toBe("deepseek-prod");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

// M-13：预设选择必须如实显示所选厂商与推导信息；只有"自定义"才显示手动配置；
// 接口格式（协议族）在抽屉内可选且仅限后端支持的协议；切换不清空无关字段。

function summaryValue(drawer: HTMLElement, term: string): string | undefined {
  const termNode = within(drawer).getByText(term);
  const row = termNode.closest("div") ?? termNode.parentElement;
  return row?.querySelector("dd")?.textContent ?? undefined;
}

it("shows the chosen preset with vendor, protocol, derived endpoint and suggested models", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  const presetSelect = screen.getByLabelText("从预设选择") as HTMLSelectElement;
  await user.selectOptions(presetSelect, "deepseek");

  // 下拉不再回到"手动填写"占位：所选厂商保持可见。
  expect(presetSelect.value).toBe("deepseek");

  const drawer = screen.getByRole("dialog");
  expect(summaryValue(drawer, "厂商")).toBe("DeepSeek");
  expect(summaryValue(drawer, "请求协议")).toBe("OpenAI 兼容（Chat Completions）");
  expect(summaryValue(drawer, "推导端点")).toBe("https://api.deepseek.com/v1");
  // 预设不携带模型目录（需求 5.42）：建议模型给可执行的下一步而不是编造列表。
  expect(summaryValue(drawer, "建议模型")).toContain("获取模型列表");
  expect(within(drawer).queryByText(/手动配置：/)).not.toBeInTheDocument();
});

it("shows the manual-configuration note only while no preset is selected", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));

  const drawer = screen.getByRole("dialog");
  const presetSelect = screen.getByLabelText("从预设选择") as HTMLSelectElement;
  expect(presetSelect.value).toBe("");
  expect(within(drawer).getByText(/手动配置：/)).toBeVisible();
  expect(within(drawer).queryByText("推导端点")).not.toBeInTheDocument();

  await user.selectOptions(presetSelect, "deepseek");
  expect(within(drawer).queryByText(/手动配置：/)).not.toBeInTheDocument();
});

it("offers every backend-supported protocol family in the drawer and keeps typed fields on switch", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, saves } = recordingFacade();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.type(screen.getByRole("textbox", { name: "供应商 ID" }), "gateway");
  await user.type(screen.getByRole("textbox", { name: "API 地址（Base URL）" }), "https://gateway.test");
  await user.type(screen.getByRole("combobox", { name: "模型" }), "gw-chat");
  await user.type(screen.getByLabelText("API 密钥"), "sk-acceptance-not-real");

  const protocolSelect = screen.getByRole("combobox", { name: "接口格式" }) as HTMLSelectElement;
  const values = Array.from(protocolSelect.options).map((option) => option.value);
  expect(values).toEqual(["open_ai", "open_ai_compatible", "anthropic", "gemini", "azure_open_ai"]);

  await user.selectOptions(protocolSelect, "anthropic");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0]!.draft.protocol).toBe("anthropic");
  // 切换接口格式不清空用户已输入的无关字段。
  expect(saves[0]!.draft.endpoint).toBe("https://gateway.test");
  expect(saves[0]!.draft.model).toBe("gw-chat");
  expect(saves[0]!.draft.credential).toBe("sk-acceptance-not-real");
});

it("clears a stale draft test result when the protocol family changes", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({
    testResult: {
      endpoint: { reachable: true, latency_ms: 42 },
      model: { ok: true, latency_ms: 88 },
    },
  });
  const user2 = await openFilledDraftForm(i18n, facade);

  await user2.click(screen.getByRole("button", { name: "测试此配置" }));
  expect(await screen.findByText(/模型连接可用/)).toBeVisible();

  await user.selectOptions(screen.getByRole("combobox", { name: "接口格式" }), "anthropic");

  expect(screen.queryByText(/模型连接可用/)).not.toBeInTheDocument();
  expect(screen.queryByText(/服务可达/)).not.toBeInTheDocument();
});

it("keeps a typed credential and model when a preset is applied afterwards", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, saves } = recordingFacade();
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "新增供应商" }));
  await user.type(screen.getByRole("textbox", { name: "供应商 ID" }), "deepseek");
  await user.type(screen.getByRole("combobox", { name: "模型" }), "deepseek-chat");
  await user.type(screen.getByLabelText("API 密钥"), "sk-acceptance-not-real");

  await user.selectOptions(screen.getByLabelText("从预设选择"), "deepseek");

  // 预设补齐端点/协议/部署方式，但不吞掉用户已输入的模型与密钥。
  expect(screen.getByRole("textbox", { name: "API 地址（Base URL）" })).toHaveValue("https://api.deepseek.com/v1");
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveValue("deepseek-chat");
  expect(screen.getByLabelText("API 密钥")).toHaveValue("sk-acceptance-not-real");

  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0]!.draft).toMatchObject({
    protocol: "open_ai_compatible",
    deployment: "online",
    endpoint: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    credential: "sk-acceptance-not-real",
  });
});

it("surfaces a protocol mismatch with the localized protocol copy instead of a raw code", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({
    providers: [PROVIDERS[0]],
    testResult: {
      endpoint: { reachable: true, latency_ms: 20 },
      model: { ok: false, latency_ms: null },
      model_failure_code: "llm.protocol_incompatible",
    },
  });
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "测试连接" }));

  expect(await screen.findByText("服务可达 (20 ms)")).toBeVisible();
  expect(screen.getByText("模型服务协议不兼容，请检查供应商配置。")).toBeVisible();
  expect(screen.queryByText(/llm\.protocol_incompatible/)).not.toBeInTheDocument();
});

// M-05：无法映射的失败码不进入主文案（避免中英混排），折叠进可选诊断详情。
it("keeps unkeyed model failure codes out of the message and collapses them into diagnostics", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade({
    providers: [PROVIDERS[0]],
    testResult: {
      endpoint: { reachable: true, latency_ms: 20 },
      model: { ok: false, latency_ms: null },
      model_failure_code: "gateway.model_disabled_vendor_suffix",
    },
  });
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("button", { name: "测试连接" }));

  const message = await screen.findByText(/模型连接失败/);
  expect(message.textContent).not.toContain("gateway.model_disabled_vendor_suffix");
  const details = message.parentElement?.querySelector("details");
  expect(details).not.toBeNull();
  expect(details!.textContent).toContain("gateway.model_disabled_vendor_suffix");
});
