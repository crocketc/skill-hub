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

it("keeps every AI capability off until the user opts in", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade } = recordingFacade(ALL_OFF);
  renderCard(facade, i18n);

  expect(await screen.findByRole("heading", { name: "AI 能力开关" })).toBeVisible();
  for (const name of ["AI 安全检查", "AI 语义重复分析", "描述翻译", "联网搜索辅助"]) {
    expect(screen.getByLabelText(name)).not.toBeChecked();
  }
  expect(screen.getByText("默认离线")).toBeVisible();
});

it("writes the full merged preference set when one capability is enabled", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { facade, writes } = recordingFacade(ALL_OFF);
  renderCard(facade, i18n);

  await user.click(await screen.findByLabelText("AI 安全检查"));

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
