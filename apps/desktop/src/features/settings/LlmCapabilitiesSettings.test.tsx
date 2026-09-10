import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { type LlmAdminFacade, type LlmCapabilityState, unavailableLlmFacade } from "./llmApi";
import { LlmCapabilitiesSettings } from "./LlmCapabilitiesSettings";

const ALL_OFF: LlmCapabilityState = {
  capabilities: {
    safety_check: false,
    semantic_duplicate: false,
    description_translation: false,
    online_search_assist: false,
  },
  aiOutputLanguage: "system",
};

function recordingFacade(initial: LlmCapabilityState): {
  facade: LlmAdminFacade;
  writes: LlmCapabilityState[];
} {
  const writes: LlmCapabilityState[] = [];
  const facade: LlmAdminFacade = {
    ...unavailableLlmFacade,
    async readCapabilityState() {
      return initial;
    },
    async writeCapabilityState(next) {
      writes.push(next);
    },
  };
  return { facade, writes };
}

function renderCard(facade: LlmAdminFacade, i18n: Awaited<ReturnType<typeof createSkillHubI18n>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <LlmCapabilitiesSettings facade={facade} />
      </ThemeProvider>
    </I18nextProvider>,
  );
}

const CAPABILITY_NAMES = ["AI 安全检查", "AI 语义重复分析", "描述翻译", "联网搜索辅助"] as const;

it("keeps every AI capability off until the user opts in", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade(ALL_OFF);
  renderCard(facade, i18n);

  expect(await screen.findByRole("heading", { name: "AI 能力开关" })).toBeVisible();
  for (const name of CAPABILITY_NAMES) {
    // 能力开关立即生效：以 Switch 语义暴露给辅助技术。
    const toggle = screen.getByRole("switch", { name });
    expect(toggle).not.toBeChecked();
  }
  expect(screen.getByText("默认离线")).toBeVisible();
});

it("shows each capability's data scope right next to its switch", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade(ALL_OFF);
  renderCard(facade, i18n);

  const safety = await screen.findByRole("switch", { name: "AI 安全检查" });
  const scope = safety.closest("div")!.querySelector("p");
  expect(scope).not.toBeNull();
  expect(scope).toHaveTextContent("发送范围：Skill 文件内容（敏感值遮盖后）");
});

it("writes the full merged preference set when one capability is enabled", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, writes } = recordingFacade(ALL_OFF);
  renderCard(facade, i18n);

  await user.click(await screen.findByRole("switch", { name: "AI 安全检查" }));

  expect(writes).toHaveLength(1);
  expect(writes[0]).toEqual({
    capabilities: {
      safety_check: true,
      semantic_duplicate: false,
      description_translation: false,
      online_search_assist: false,
    },
    aiOutputLanguage: "system",
  });
});

it("persists the AI output language independently of the interface language", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, writes } = recordingFacade({
    ...ALL_OFF,
    capabilities: { ...ALL_OFF.capabilities, description_translation: true },
  });
  renderCard(facade, i18n);

  await user.selectOptions(await screen.findByLabelText("AI 输出语言"), "en-US");

  expect(writes).toHaveLength(1);
  expect(writes[0]).toEqual({
    capabilities: { ...ALL_OFF.capabilities, description_translation: true },
    aiOutputLanguage: "en-US",
  });
});
