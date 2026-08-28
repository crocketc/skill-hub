import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import baseCss from "../../styles/base.css?raw";
import {
  AGENT_PROFILE_IDS,
  AgentDeploymentIcons,
  getAgentVisual,
} from "./AgentDeploymentIcons";

const profileIds = [
  "anthropic",
  "cline",
  "codebuddy",
  "codex",
  "comate",
  "cursor",
  "github-copilot",
  "google",
  "grok",
  "hermes",
  "kimi",
  "openai",
  "openclaw",
  "opencode",
  "qoder",
  "trae",
  "windsurf",
  "zcode",
] as const;

it("keeps the supported adapter profiles mapped to stable local icon visuals", () => {
  expect(AGENT_PROFILE_IDS).toEqual(profileIds);

  for (const id of profileIds) {
    const visual = getAgentVisual({ id, name: id });
    expect(visual.color).toMatch(/^#/);
  }
});

it("keeps every built-in profile on a distinct brand accent", () => {
  for (const id of profileIds) {
    expect(getAgentVisual({ id, name: id }).color, id).not.toBe("#64748b");
  }
});

it("uses the neutral monogram fallback for an unknown agent", () => {
  expect(getAgentVisual({ id: "new-agent", name: "New Agent" })).toEqual({
    color: "#64748b",
  });
});

it("renders deployment names as brand-colored text tags without logo glyphs", () => {
  const { container } = render(
    <AgentDeploymentIcons
      agents={[
        { id: "codex", name: "OpenAI Codex" },
        { id: "anthropic", name: "Claude Code" },
      ]}
      ariaLabel="Agent deployments: 2"
    />,
  );

  expect(screen.getByText("OpenAI Codex")).toHaveClass(
    "sh-skill-table__agent-deployment-label",
  );
  expect(screen.getByText("Claude Code")).toHaveClass(
    "sh-skill-table__agent-deployment-label",
  );
  expect(container.querySelectorAll("svg")).toHaveLength(0);
});

it("aligns deployment icons with the agent deployment column header", () => {
  expect(baseCss).toMatch(
    /\.sh-skill-table__agent-deployments\s*\{[^}]*justify-items:\s*start/,
  );
  expect(baseCss).toMatch(
    /\.sh-skill-table__agent-deployment-row\s*\{[^}]*justify-content:\s*flex-start/,
  );
});
