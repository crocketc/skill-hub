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
    expect(visual.glyph).toMatch(/^(spark|orbit|copilot|knot|kite|monogram|terminal|x)$/);
    expect(visual.mark.length).toBeGreaterThan(0);
  }
});

it("gives the recognizable primary agents a dedicated non-monogram mark", () => {
  const primaryIds = [
    "anthropic",
    "codex",
    "cline",
    "cursor",
    "github-copilot",
    "google",
    "grok",
    "kimi",
    "openai",
    "opencode",
    "windsurf",
  ];

  for (const id of primaryIds) {
    expect(getAgentVisual({ id, name: id }).glyph, id).not.toBe("monogram");
  }
});

it("keeps every built-in profile on an SVG glyph rather than a plain text badge", () => {
  for (const id of profileIds) {
    expect(getAgentVisual({ id, name: id }).glyph, id).not.toBe("monogram");
  }
});

it("uses the neutral monogram fallback for an unknown agent", () => {
  expect(getAgentVisual({ id: "new-agent", name: "New Agent" })).toEqual({
    color: "#64748b",
    glyph: "monogram",
    mark: "NA",
  });
});
