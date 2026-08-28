import type { CSSProperties } from "react";
import type { AgentDeployment } from "./api";

interface AgentVisual {
  color: string;
  mark: string;
}

const AGENT_VISUALS: Record<string, AgentVisual> = {
  anthropic: { color: "#d97757", mark: "✳" },
  claude: { color: "#d97757", mark: "✳" },
  cline: { color: "#7c3aed", mark: "⌁" },
  codebuddy: { color: "#2563eb", mark: "CB" },
  codex: { color: "#1f6f54", mark: "CX" },
  comate: { color: "#0f766e", mark: "Co" },
  cursor: { color: "#64748b", mark: "◌" },
  gemini: { color: "#4285f4", mark: "✦" },
  "github-copilot": { color: "#24292f", mark: "●" },
  google: { color: "#4285f4", mark: "G" },
  grok: { color: "#111827", mark: "x" },
  hermes: { color: "#c2410c", mark: "H" },
  kimi: { color: "#0ea5e9", mark: "K" },
  openai: { color: "#10a37f", mark: "AI" },
  openclaw: { color: "#ea580c", mark: "OC" },
  opencode: { color: "#334155", mark: "O" },
  qoder: { color: "#7c3aed", mark: "Q" },
  trae: { color: "#0ea5e9", mark: "T" },
  windsurf: { color: "#2563eb", mark: "≋" },
  zcode: { color: "#16a34a", mark: "Z" },
};

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return name.trim().slice(0, 2).toUpperCase() || "?";
}

function visualFor(agent: AgentDeployment): AgentVisual {
  return AGENT_VISUALS[agent.id.toLowerCase()] ?? { color: "#64748b", mark: initials(agent.name) };
}

function AgentMark({ agent }: { agent: AgentDeployment }) {
  const visual = visualFor(agent);
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
      <span aria-hidden="true" className="sh-skill-table__agent-deployment-mark">{visual.mark}</span>
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
