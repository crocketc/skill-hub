import type { CSSProperties } from "react";
import type { AgentDeployment } from "./api";

interface AgentVisual {
  color: string;
  glyph: "spark" | "orbit" | "copilot" | "knot" | "kite" | "monogram" | "terminal" | "x";
  mark: string;
}

/**
 * The adapter profiles are the source of truth for this local catalog. There
 * are no checked-in vendor logo assets, so the table uses small, original SVG
 * marks with the profile's brand color instead of fetching images at runtime.
 */
export const AGENT_PROFILE_IDS = [
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

const AGENT_VISUALS: Record<string, AgentVisual> = {
  anthropic: { color: "#d97757", glyph: "spark", mark: "✳" },
  claude: { color: "#d97757", glyph: "spark", mark: "✳" },
  cline: { color: "#7c3aed", glyph: "orbit", mark: "C" },
  codebuddy: { color: "#2563eb", glyph: "spark", mark: "CB" },
  codex: { color: "#1f6f54", glyph: "knot", mark: "CX" },
  comate: { color: "#0f766e", glyph: "knot", mark: "Co" },
  cursor: { color: "#64748b", glyph: "orbit", mark: "C" },
  gemini: { color: "#4285f4", glyph: "spark", mark: "✦" },
  "github-copilot": { color: "#24292f", glyph: "copilot", mark: "●" },
  google: { color: "#4285f4", glyph: "spark", mark: "✦" },
  grok: { color: "#111827", glyph: "x", mark: "x" },
  hermes: { color: "#c2410c", glyph: "kite", mark: "H" },
  kimi: { color: "#0ea5e9", glyph: "kite", mark: "K" },
  openai: { color: "#10a37f", glyph: "knot", mark: "AI" },
  openclaw: { color: "#ea580c", glyph: "copilot", mark: "OC" },
  opencode: { color: "#334155", glyph: "terminal", mark: "O" },
  qoder: { color: "#7c3aed", glyph: "orbit", mark: "Q" },
  trae: { color: "#0ea5e9", glyph: "spark", mark: "T" },
  windsurf: { color: "#2563eb", glyph: "orbit", mark: "≋" },
  zcode: { color: "#16a34a", glyph: "terminal", mark: "Z" },
};

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return name.trim().slice(0, 2).toUpperCase() || "?";
}

export function getAgentVisual(agent: AgentDeployment): AgentVisual {
  return AGENT_VISUALS[agent.id.toLowerCase()] ?? { color: "#64748b", glyph: "monogram", mark: initials(agent.name) };
}

function AgentGlyph({ visual }: { visual: AgentVisual }) {
  const common = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.8 };
  if (visual.glyph === "spark") {
    return <svg aria-hidden="true" className="sh-skill-table__agent-deployment-mark" viewBox="0 0 24 24"><path {...common} d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9 4.9 19.1" /></svg>;
  }
  if (visual.glyph === "orbit") {
    return <svg aria-hidden="true" className="sh-skill-table__agent-deployment-mark" viewBox="0 0 24 24"><ellipse {...common} cx="12" cy="12" rx="9" ry="4.5" transform="rotate(-25 12 12)" /><circle cx="12" cy="12" fill="currentColor" r="2.2" /></svg>;
  }
  if (visual.glyph === "copilot") {
    return <svg aria-hidden="true" className="sh-skill-table__agent-deployment-mark" viewBox="0 0 24 24"><path {...common} d="M5.5 10.5c0-3 2.3-5 6.5-5s6.5 2 6.5 5v5c0 1.7-1.3 3-3 3H8.5c-1.7 0-3-1.3-3-3z" /><circle cx="9" cy="12" fill="currentColor" r="1.2" /><circle cx="15" cy="12" fill="currentColor" r="1.2" /></svg>;
  }
  if (visual.glyph === "knot") {
    return <svg aria-hidden="true" className="sh-skill-table__agent-deployment-mark" viewBox="0 0 24 24"><path {...common} d="M9 6.2a3.7 3.7 0 1 0 0 7.4h6a3.7 3.7 0 1 1 0 7.4M15 6.2a3.7 3.7 0 1 1 0 7.4H9a3.7 3.7 0 1 0 0 7.4" /></svg>;
  }
  if (visual.glyph === "kite") {
    return <svg aria-hidden="true" className="sh-skill-table__agent-deployment-mark" viewBox="0 0 24 24"><path {...common} d="m12 3 6.5 7.5L12 17 5.5 10.5zM12 17v4M12 19c1.6 0 2.4-1.2 3.4-1.2M12 21c-1.6 0-2.4-1.2-3.4-1.2" /></svg>;
  }
  if (visual.glyph === "terminal") {
    return <svg aria-hidden="true" className="sh-skill-table__agent-deployment-mark" viewBox="0 0 24 24"><rect {...common} height="14" rx="2.5" width="17" x="3.5" y="5" /><path {...common} d="m7 10 2.5 2L7 14M12 14h4" /></svg>;
  }
  if (visual.glyph === "x") {
    return <svg aria-hidden="true" className="sh-skill-table__agent-deployment-mark" viewBox="0 0 24 24"><path {...common} d="m6 6 12 12M18 6 6 18" /></svg>;
  }
  return <svg aria-hidden="true" className="sh-skill-table__agent-deployment-mark" viewBox="0 0 24 24"><text fill="currentColor" fontSize={visual.mark.length > 1 ? 8 : 12} fontWeight="700" textAnchor="middle" x="12" y="16">{visual.mark}</text></svg>;
}

function AgentMark({ agent }: { agent: AgentDeployment }) {
  const visual = getAgentVisual(agent);
  const style = { "--agent-accent": visual.color } as CSSProperties;
  return (
    <span
      aria-label={agent.name}
      className="sh-skill-table__agent-deployment"
      data-agent-id={agent.id}
      role="img"
      style={style}
      title={agent.name}
    >
      <AgentGlyph visual={visual} />
    </span>
  );
}

export interface AgentDeploymentIconsProps {
  agents: AgentDeployment[];
  ariaLabel: string;
}

export function AgentDeploymentIcons({ agents, ariaLabel }: AgentDeploymentIconsProps) {
  const visibleAgents = agents.slice(0, 10);
  if (visibleAgents.length === 0) return <span className="sh-skill-table__agent-deployments-empty">—</span>;
  const rows = [visibleAgents.slice(0, 5), visibleAgents.slice(5, 10)].filter((row) => row.length > 0);
  return (
    <div aria-label={ariaLabel} className="sh-skill-table__agent-deployments">
      {rows.map((row, index) => (
        <div className="sh-skill-table__agent-deployment-row" data-agent-row={index} key={index}>
          {row.map((agent) => <AgentMark agent={agent} key={agent.id} />)}
        </div>
      ))}
    </div>
  );
}
