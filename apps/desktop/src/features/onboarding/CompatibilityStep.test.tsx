import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { CompatibilityTarget } from "../bootstrap/api";
import onboardingCss from "./onboarding.css?raw";
import { CompatibilityStep } from "./CompatibilityStep";

const targets: CompatibilityTarget[] = [
  { id: "t1", label: "codex-cli", profileId: "openai", kind: "cli", path: "C:\\Users\\Test\\.codex\\skills", availability: "available" },
  { id: "t2", label: "codex-desktop", profileId: "openai", kind: "desktop", path: "C:/Users/Test/.codex/skills", availability: "available" },
  { id: "t3", label: "claude-code", profileId: "anthropic", kind: "cli", path: "C:\\Users\\Test\\.claude\\skills", availability: "available" },
  { id: "t5", label: "grok-acp", profileId: "grok", kind: "acp", path: "C:\\Users\\Test\\.grok\\skills", availability: "available" },
  { id: "t4", label: "legacy-agent", availability: "unavailable" },
];

it("merges same-brand targets for one path and presents brand, merged kinds, and path", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <CompatibilityStep
        confirmed
        isDiscovering={false}
        selectedTargetIds={[]}
        targets={targets}
        onConfirmChange={() => undefined}
        onDiscover={() => undefined}
        onTargetSelectionChange={() => undefined}
        onSelectAllAvailable={() => undefined}
      />
    </I18nextProvider>,
  );

  expect(document.querySelectorAll(".sh-onboarding__target-card")).toHaveLength(4);
  expect(screen.getByLabelText("OpenAI · 桌面端/终端")).toBeVisible();
  expect(screen.getByText("C:\\Users\\Test\\.codex\\skills")).toBeVisible();
  expect(screen.getAllByLabelText("Claude · 终端").length).toBeGreaterThan(0);
  expect(screen.getAllByLabelText("Grok · 协议接入").length).toBeGreaterThan(0);
  expect(screen.getByText("桌面端/终端")).toBeVisible();
  expect(document.querySelector(".sh-onboarding__target-scroll")).toBeInTheDocument();
  expect(onboardingCss).toMatch(/\.sh-onboarding__target-scroll\s*\{[^}]*overflow:\s*auto/);
  expect(onboardingCss).toMatch(/\.sh-onboarding__target-scroll\s*\{[^}]*max-height:/);
});

it("keeps different paths as separate cards and toggles all logical scopes in a merged card", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onTargetSelectionChange = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18n}>
      <CompatibilityStep
        confirmed
        isDiscovering={false}
        selectedTargetIds={[]}
        targets={[
          { id: "codex-cli", label: "codex", profileId: "openai", kind: "cli", path: "C:/Users/Test/.codex/skills", availability: "available" },
          { id: "codex-desktop", label: "codex-desktop", profileId: "openai", kind: "desktop", path: "C:\\Users\\Test\\.codex\\skills", availability: "available" },
          { id: "openai-app", label: "openai-app", profileId: "openai", kind: "desktop", path: "C:/Users/Test/.openai/skills", availability: "available" },
        ]}
        onConfirmChange={() => undefined}
        onDiscover={() => undefined}
        onTargetSelectionChange={onTargetSelectionChange}
        onSelectAllAvailable={() => undefined}
      />
    </I18nextProvider>,
  );

  expect(document.querySelectorAll(".sh-onboarding__target-card")).toHaveLength(2);
  await user.click(screen.getByLabelText("OpenAI · 桌面端/终端"));
  expect(onTargetSelectionChange).toHaveBeenNthCalledWith(1, "codex-cli", true);
  expect(onTargetSelectionChange).toHaveBeenNthCalledWith(2, "codex-desktop", true);
});

it("keeps a flat list when no brand information is available", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <CompatibilityStep
        confirmed
        isDiscovering={false}
        selectedTargetIds={[]}
        targets={[
          { id: "a", label: "Codex", availability: "available" },
          { id: "b", label: "Claude", availability: "available" },
        ]}
        onConfirmChange={() => undefined}
        onDiscover={() => undefined}
        onTargetSelectionChange={() => undefined}
        onSelectAllAvailable={() => undefined}
      />
    </I18nextProvider>,
  );

  expect(screen.getAllByLabelText("Codex · Agent").length).toBeGreaterThan(0);
  expect(screen.getAllByLabelText("Claude · Agent").length).toBeGreaterThan(0);
  expect(screen.queryByText("openai")).not.toBeInTheDocument();
});
