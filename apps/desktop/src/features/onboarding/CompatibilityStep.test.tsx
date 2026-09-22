import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { CompatibilityTarget } from "../bootstrap/api";
import { CompatibilityStep } from "./CompatibilityStep";

const targets: CompatibilityTarget[] = [
  { id: "t1", label: "codex-cli", profileId: "openai", kind: "cli", availability: "available" },
  { id: "t2", label: "codex-desktop", profileId: "openai", kind: "desktop", availability: "available" },
  { id: "t3", label: "claude-code", profileId: "anthropic", kind: "cli", availability: "available" },
  { id: "t5", label: "grok-acp", profileId: "grok", kind: "acp", availability: "available" },
  { id: "t4", label: "legacy-agent", availability: "unavailable" },
];

it("groups agent targets by brand with clients listed underneath", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <CompatibilityStep
        confirmed
        isDiscovering={false}
        selectionConfirmed={false}
        selectedTargetIds={[]}
        targets={targets}
        onConfirmChange={() => undefined}
        onDiscover={() => undefined}
        onSelectionConfirmChange={() => undefined}
        onTargetSelectionChange={() => undefined}
        onSelectAllAvailable={() => undefined}
      />
    </I18nextProvider>,
  );

  // 品牌分组标题以品牌化彩色标签呈现（规范化友好名 + 品牌特征色）
  expect(document.querySelector(".sh-onboarding__brand .sh-brand-tag--openai")).toBeInTheDocument();
  expect(document.querySelector(".sh-onboarding__brand .sh-brand-tag--anthropic")).toBeInTheDocument();
  expect(screen.getByText("其他", { exact: false })).toBeVisible();
  expect(screen.getAllByLabelText("OpenAI · 终端").length).toBeGreaterThan(0);
  expect(screen.getAllByLabelText("OpenAI · 桌面端").length).toBeGreaterThan(0);
  expect(screen.getAllByLabelText("Claude · 终端").length).toBeGreaterThan(0);
  expect(screen.getAllByLabelText("Grok · 协议接入").length).toBeGreaterThan(0);
  expect(screen.getAllByText("终端").length).toBeGreaterThan(0);
  expect(screen.getByText("桌面应用")).toBeVisible();
  expect(screen.getAllByText("协议接入").length).toBeGreaterThan(0);
});

it("keeps a flat list when no brand information is available", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <CompatibilityStep
        confirmed
        isDiscovering={false}
        selectionConfirmed={false}
        selectedTargetIds={[]}
        targets={[
          { id: "a", label: "Codex", availability: "available" },
          { id: "b", label: "Claude", availability: "available" },
        ]}
        onConfirmChange={() => undefined}
        onDiscover={() => undefined}
        onSelectionConfirmChange={() => undefined}
        onTargetSelectionChange={() => undefined}
        onSelectAllAvailable={() => undefined}
      />
    </I18nextProvider>,
  );

  expect(screen.getAllByLabelText("Codex · Agent").length).toBeGreaterThan(0);
  expect(screen.getAllByLabelText("Claude · Agent").length).toBeGreaterThan(0);
  expect(screen.queryByText("openai")).not.toBeInTheDocument();
});
