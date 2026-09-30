import type { AgentDirectoryRole } from "../api/bindings";
import { useTranslation } from "react-i18next";

export function AgentDirectoryRoleBadge({ role }: { role: AgentDirectoryRole | "agent_native" }): JSX.Element | null {
  const { t } = useTranslation();
  const presentation = role === "builtin"
    ? { key: "agents.directoryRole.builtin", tone: "builtin" }
    : role === "agent_workspace"
      ? { key: "agents.directoryRole.workspace", tone: "workspace" }
      : role === "project"
        ? null
        : { key: "agents.directoryRole.user", tone: "user" };
  if (!presentation) return null;

  return (
    <span className={`sh-agent-directory-role-badge sh-agent-directory-role-badge--${presentation.tone}`}>
      {t(presentation.key as never)}
    </span>
  );
}
