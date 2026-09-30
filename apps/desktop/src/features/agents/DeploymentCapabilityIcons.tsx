import type { AgentDirectoryView } from "./api";
import "./deploymentCapabilityIcons.css";

export function DeploymentCapabilityIcons({
  directory,
  note,
  noteTitle,
  t,
}: {
  directory?: AgentDirectoryView;
  note?: string;
  noteTitle?: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}): JSX.Element | null {
  if (!directory) return null;
  const methods = [
    ["copy", "⧉", directory.supportedModes.includes("managed_copy") && !directory.builtin],
    ["link", "↗", (directory.supportedModes.includes("symbolic_link") || directory.supportedModes.includes("directory_junction")) && !directory.builtin],
  ] as const;
  return (
    <div aria-label={String(t("agents.deploymentMethods.label"))} className="sh-agent-card__deployment-footer">
      <div className="sh-agent-card__deployment-methods">
      {methods.map(([mode, symbol, supported]) => {
        const text = String(t(`agents.deploymentMethods.${mode}.${supported ? "supported" : "unsupported"}`));
        return (
          <span
            aria-label={text}
            className={`sh-agent-card__deployment-method ${supported ? "is-supported" : "is-unsupported"}`}
            key={mode}
            title={text}
          >
            <span aria-hidden="true">{symbol}</span>
          </span>
        );
      })}
      </div>
      {note ? <span className="sh-agent-card__deployment-note" title={noteTitle ?? note}>{note}</span> : null}
    </div>
  );
}
