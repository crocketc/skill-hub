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

it("keeps the supported adapter profiles mapped to stable brand accents", () => {
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

  expect(screen.getByText("Codex")).toHaveClass(
    "sh-skill-table__agent-deployment-label",
  );
  expect(screen.getByText("Claude")).toHaveClass(
    "sh-skill-table__agent-deployment-label",
  );
  expect(container.querySelectorAll("svg")).toHaveLength(0);
});

it("uses compact display names and summarizes agents after the seventh tag", () => {
  const { container } = render(
    <AgentDeploymentIcons
      agents={Array.from({ length: 10 }, (_, index) => ({
        id: index === 0 ? "codex" : `agent-${index + 1}`,
        name: index === 0 ? "OpenAI Codex" : `Very Long Agent Name ${index + 1}`,
      }))}
      ariaLabel="Agent deployments: 10"
    />,
  );

  expect(screen.queryByText("OpenAI Codex")).not.toBeInTheDocument();
  expect(screen.getByText("Codex")).toBeVisible();
  expect(container.querySelectorAll("[data-agent-id]")).toHaveLength(7);
  expect(screen.getByText("+3")).toBeVisible();
  expect(container.querySelectorAll("[data-agent-row]")).toHaveLength(2);
  expect(container.querySelector('[data-agent-row="0"]')?.querySelectorAll("[data-agent-id]")).toHaveLength(4);
  expect(container.querySelector('[data-agent-row="1"]')?.querySelectorAll("[data-agent-id]")).toHaveLength(3);
});

it("keeps the compact deployment column sizing", () => {
  expect(baseCss).toMatch(
    /\.sh-skill-table\s+\[data-column="agent_deployments"\]\s*\{[^}]*width:\s*14rem/,
  );
  expect(baseCss).toMatch(
    /\.sh-skill-table__agent-deployment-label\s*\{[^}]*font-size:\s*0\.65rem/,
  );
});

it("aligns deployment icons with the agent deployment column header", () => {
  expect(baseCss).toMatch(
    /\.sh-skill-table__agent-deployments\s*\{[^}]*justify-items:\s*start/,
  );
  expect(baseCss).toMatch(
    /\.sh-skill-table__agent-deployment-row\s*\{[^}]*justify-content:\s*flex-start/,
  );
});
