import { expect, it } from "vitest";
import {
  AGENT_PROFILE_IDS,
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
    expect(visual.glyph).toMatch(/^(spark|orbit|copilot|knot|monogram|x)$/);
    expect(visual.mark.length).toBeGreaterThan(0);
  }
});

it("uses the neutral monogram fallback for an unknown agent", () => {
  expect(getAgentVisual({ id: "new-agent", name: "New Agent" })).toEqual({
    color: "#64748b",
    glyph: "monogram",
    mark: "NA",
  });
});
