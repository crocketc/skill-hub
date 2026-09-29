import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { CompatibilityTarget } from "../bootstrap/api";
import type { AgentDirectoryProjection } from "../../api/bindings";
import onboardingCss from "./onboarding.css?raw";
import { CompatibilityStep, selectableCompatibilityTargetIds } from "./CompatibilityStep";

const targets: CompatibilityTarget[] = [
  { id: "t1", label: "codex-cli", profileId: "openai", kind: "cli", path: "C:\\Users\\Test\\.codex\\skills", availability: "available" },
  { id: "t2", label: "codex-desktop", profileId: "openai", kind: "desktop", path: "C:/Users/Test/.codex/skills", availability: "available" },
  { id: "t3", label: "claude-code", profileId: "anthropic", kind: "cli", path: "C:\\Users\\Test\\.claude\\skills", availability: "available" },
  { id: "t5", label: "grok-acp", profileId: "grok", kind: "acp", path: "C:\\Users\\Test\\.grok\\skills", availability: "available" },
  { id: "t4", label: "legacy-agent", availability: "unavailable" },
];

const directoryProjection: AgentDirectoryProjection = {
  directories: [
    {
      role: "shared_directory",
      identity: { kind: "verified_physical", value: "physical-shared" },
      path: "C:/Users/Test/.agents/skills",
      status: "existing",
      exists: true,
      readable: true,
      writable: false,
      available: true,
      members: [
        { logical_target_id: "shared-openai", brand: "openai", client_id: "codex", kind: "cli", availability: { status: "existing", exists: true, available: true, readable: true, writable: false }, capabilities: { deployment: { copy: false, symlink: false, junction: false }, modes: [], preferred_mode: null }, deployment_status: "not_deployed", managed_deployment_relation_count: 0, managed_deployment_count: 0 },
        { logical_target_id: "shared-anthropic", brand: "anthropic", client_id: "claude", kind: "desktop", availability: { status: "existing", exists: true, available: true, readable: true, writable: false }, capabilities: { deployment: { copy: false, symlink: false, junction: false }, modes: [], preferred_mode: null }, deployment_status: "not_deployed", managed_deployment_relation_count: 0, managed_deployment_count: 0 },
      ],
    },
    {
      role: "agent_native",
      identity: { kind: "verified_physical", value: "physical-codex" },
      path: "C:/Users/Test/.codex/skills",
      status: "existing",
      exists: true,
      readable: true,
      writable: true,
      available: true,
      members: [
        { logical_target_id: "codex-cli", brand: "openai", client_id: "codex-code", kind: "cli", availability: { status: "existing", exists: true, available: true, readable: true, writable: true }, capabilities: { deployment: { copy: true, symlink: true, junction: true }, modes: ["managed_copy"], preferred_mode: "managed_copy" }, deployment_status: "not_deployed", managed_deployment_relation_count: 0, managed_deployment_count: 0 },
        { logical_target_id: "codex-desktop", brand: "openai", client_id: "codex-app", kind: "desktop", availability: { status: "existing", exists: true, available: true, readable: true, writable: true }, capabilities: { deployment: { copy: true, symlink: true, junction: true }, modes: ["managed_copy"], preferred_mode: "managed_copy" }, deployment_status: "not_deployed", managed_deployment_relation_count: 0, managed_deployment_count: 0 },
      ],
    },
    {
      role: "agent_native",
      identity: { kind: "verified_physical", value: "physical-openai-other" },
      path: "C:/Users/Test/.codex/skills",
      status: "existing",
      exists: true,
      readable: true,
      writable: true,
      available: true,
      members: [
        { logical_target_id: "codex-project", brand: "openai", client_id: "codex-project", kind: "desktop", availability: { status: "existing", exists: true, available: true, readable: true, writable: true }, capabilities: { deployment: { copy: true, symlink: false, junction: false }, modes: ["managed_copy"], preferred_mode: "managed_copy" }, deployment_status: "not_deployed", managed_deployment_relation_count: 0, managed_deployment_count: 0 },
      ],
    },
  ],
};

const projectedTargets: CompatibilityTarget[] = [
  { id: "shared-openai", label: "codex", path: "C:/Users/Test/.agents/skills", availability: "available" },
  { id: "shared-anthropic", label: "claude", path: "C:/Users/Test/.agents/skills", availability: "available" },
  { id: "codex-cli", label: "codex-code", path: "C:/Users/Test/.codex/skills", availability: "available" },
  { id: "codex-desktop", label: "codex-app", path: "C:/Users/Test/.codex/skills", availability: "available" },
  { id: "codex-project", label: "codex-project", path: "C:/Users/Test/.codex/skills", availability: "available" },
  { id: "unrecognized-root", label: "unrecognized", availability: "unavailable" },
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

it("uses projected physical identities, shared membership, and expands selected cards to each scope once", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onTargetSelectionChange = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18n}>
      <CompatibilityStep
        confirmed
        isDiscovering={false}
        selectedTargetIds={[]}
        targets={projectedTargets}
        projection={directoryProjection}
        onConfirmChange={() => undefined}
        onDiscover={() => undefined}
        onTargetSelectionChange={onTargetSelectionChange}
        onSelectAllAvailable={() => undefined}
      />
    </I18nextProvider>,
  );

  expect(document.querySelectorAll(".sh-onboarding__target-card")).toHaveLength(3);
  expect(screen.getByLabelText("Agent Skills · 共享目录")).toBeVisible();
  expect(screen.getByLabelText("OpenAI · 桌面端/终端")).toBeVisible();
  expect(screen.getAllByLabelText("OpenAI · 桌面端")).toHaveLength(2);
  await user.click(screen.getByLabelText("Agent Skills · 共享目录"));
  expect(onTargetSelectionChange.mock.calls).toEqual([
    ["shared-openai", true],
    ["shared-anthropic", true],
  ]);
  expect(selectableCompatibilityTargetIds(projectedTargets, directoryProjection)).toEqual([
    "shared-openai",
    "shared-anthropic",
    "codex-cli",
    "codex-desktop",
    "codex-project",
  ]);
});
