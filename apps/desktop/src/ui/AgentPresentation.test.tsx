import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import type { ClientKind } from "../api/bindings";
import { createSkillHubI18n } from "../i18n";
import { AgentPresentation } from "./AgentPresentation";

async function renderPresentation(props: ComponentProps<typeof AgentPresentation>) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <AgentPresentation {...props} />
    </I18nextProvider>,
  );
}

it("combines a real brand logo with a user-facing platform type", async () => {
  const { container } = await renderPresentation({ agentId: "codebuddy.code", brand: "CodeBuddy" });

  expect(screen.getByText("CodeBuddy")).toBeVisible();
  expect(screen.getByText("终端")).toBeVisible();
  expect(container.querySelector("img"))
    .toHaveAttribute("src", "/brand/agents/lobehub/codebuddy.svg");
  expect(screen.queryByText("codebuddy.code")).not.toBeInTheDocument();
});

it("does not expose technical instance names next to the brand and platform type", async () => {
  await renderPresentation({
    agentId: "anthropic.claude-code",
    brand: "Claude",
    instance: "claude-code",
    kinds: ["cli"],
  });

  expect(screen.getByText("Claude")).toBeVisible();
  expect(screen.getByText("终端")).toBeVisible();
  expect(screen.queryByText("anthropic.claude-code")).not.toBeInTheDocument();
  expect(screen.queryByText("claude-code")).not.toBeInTheDocument();
});

it("deduplicates explicit platform kinds while preserving their user-facing order", async () => {
  await renderPresentation({
    brand: "ZCode",
    kinds: ["desktop", "cli", "desktop"] satisfies ClientKind[],
  });

  expect(screen.getByText("桌面端/终端")).toBeVisible();
});

it("uses an honest neutral fallback for unknown brands and types", async () => {
  const { container } = await renderPresentation({ brand: "Acme Robotics", agentId: "acme.custom" });

  expect(screen.getByText("Acme Robotics")).toBeVisible();
  expect(screen.getByText("Agent")).toBeVisible();
  expect(container.querySelector(".sh-brand-tag--neutral")).toBeInTheDocument();
  expect(screen.queryByText("acme.custom")).not.toBeInTheDocument();
});

it.each([
  ["pi.coding-agent", "Pi", "终端"],
  ["hermes.agent", "Hermes", "终端"],
  ["openclaw.agent", "OpenClaw", "后台服务"],
  ["google.antigravity.app", "Gemini", "桌面端"],
  ["google.antigravity.sdk", "Gemini", "后台服务"],
  ["cline.sdk", "Cline", "后台服务"],
  ["github-copilot.cloud", "GitHub Copilot", "后台服务"],
])("maps known client %s to its catalog brand and user-facing kind", async (agentId, brand, kindLabel) => {
  await renderPresentation({ agentId });

  expect(screen.getByText(brand)).toBeVisible();
  expect(screen.getByText(kindLabel)).toBeVisible();
  expect(screen.queryByText(agentId)).not.toBeInTheDocument();
});

it("keeps the shared directory as a standalone user-facing entity", async () => {
  const { container } = await renderPresentation({
    agentId: "agent-skills.shared-directory",
    kinds: ["shared_directory"],
    sharedDirectory: true,
  });

  expect(screen.getByText("Agent共享目录")).toBeVisible();
  expect(container.querySelector(".sh-brand-tag")).toBeNull();
  expect(container.querySelector(".sh-agent-presentation__vercel-logo")).toBeInTheDocument();
  expect(screen.queryByText("agent-skills.shared-directory")).not.toBeInTheDocument();
});

it("makes one shared directory the brand and recognised vendors its visible types", async () => {
  const { container } = await renderPresentation({
    agentId: "agent-skills.shared-directory",
    sharedDirectory: true,
    sharedAgentBrands: ["anthropic", "codex"],
    sharedAgentBrandKinds: { anthropic: ["desktop"], codex: ["cli"] },
  });

  expect(screen.getByText("Agent共享目录")).toBeVisible();
  expect(screen.getByTitle("Claude · 桌面端")).toBeInTheDocument();
  expect(screen.getByTitle("Codex · 终端")).toBeInTheDocument();
  expect(container.querySelector(".sh-agent-presentation")).toHaveAttribute(
    "aria-label",
    "Agent共享目录；Claude · 桌面端；Codex · 终端",
  );
  expect(container.querySelector(".sh-agent-presentation")?.getAttribute("aria-label"))
    .not.toMatch(/agent-skills|anthropic|codex\./i);
});

it("wraps a bounded set of shared logos and exposes the remaining brands in a readable overflow badge", async () => {
  const { container } = await renderPresentation({
    agentId: "agent-skills.shared-directory",
    sharedDirectory: true,
    sharedAgentBrands: ["anthropic", "codex", "cursor", "google", "kimi", "windsurf"],
    sharedAgentBrandKinds: {
      anthropic: ["desktop"],
      codex: ["cli"],
      cursor: ["ide_extension"],
      google: ["web"],
      kimi: ["desktop"],
      windsurf: ["desktop"],
    },
  });

  expect(container.querySelectorAll(".sh-agent-presentation__shared-brands .sh-brand-tag")).toHaveLength(4);
  expect(container.querySelector(".sh-agent-presentation__shared-brand-overflow")).toHaveTextContent("+2");
  expect(container.querySelector(".sh-agent-presentation__shared-brand-overflow")).toHaveAttribute(
    "title",
    "Kimi · 桌面端 / Windsurf · 桌面端",
  );
});

it("uses an icon-only compact presentation while retaining the full accessible identity", async () => {
  const { container } = await renderPresentation({
    agentId: "anthropic.claude-code",
    brand: "Claude",
    kinds: ["cli"],
    density: "compact",
  });

  expect(container.querySelector(".sh-agent-presentation--compact img")).toBeVisible();
  expect(screen.queryByText("Claude")).not.toBeInTheDocument();
  expect(screen.queryByText("终端")).not.toBeInTheDocument();
  expect(container.querySelector(".sh-agent-presentation--compact")).toHaveAttribute(
    "aria-label",
    "Claude · 终端",
  );
  expect(container.querySelector(".sh-agent-presentation--compact")).toHaveAttribute(
    "title",
    "Claude · 终端",
  );
});
