import type { CSSProperties } from "react";
import type { AgentDeployment } from "./api";

interface AgentVisual {
  color: string;
}

/**
 * The adapter profiles are the source of truth for this local catalog. The
 * table deliberately uses text tags instead of vendor logo artwork; each tag
 * keeps a restrained brand accent without implying an official integration.
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
  anthropic: { color: "#d97757" },
  claude: { color: "#d97757" },
  cline: { color: "#7c3aed" },
  codebuddy: { color: "#2563eb" },
  codex: { color: "#1f6f54" },
  comate: { color: "#0f766e" },
  cursor: { color: "#475569" },
  gemini: { color: "#4285f4" },
  "github-copilot": { color: "#24292f" },
  google: { color: "#4285f4" },
  grok: { color: "#111827" },
  hermes: { color: "#c2410c" },
  kimi: { color: "#0ea5e9" },
  openai: { color: "#10a37f" },
  openclaw: { color: "#ea580c" },
  opencode: { color: "#334155" },
  qoder: { color: "#7c3aed" },
  trae: { color: "#0ea5e9" },
  windsurf: { color: "#2563eb" },
  zcode: { color: "#16a34a" },
};

export function getAgentVisual(agent: AgentDeployment): AgentVisual {
  return AGENT_VISUALS[agent.id.toLowerCase()] ?? { color: "#64748b" };
}

function AgentMark({ agent }: { agent: AgentDeployment }) {
  const visual = getAgentVisual(agent);
  const style = { "--agent-accent": visual.color } as CSSProperties;
  return (
    <span
      className="sh-skill-table__agent-deployment"
      data-agent-id={agent.id}
      style={style}
      title={agent.name}
    >
      <span className="sh-skill-table__agent-deployment-label">{agent.name}</span>
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
