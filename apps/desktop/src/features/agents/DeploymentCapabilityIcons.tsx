import type { AgentDirectoryView } from "./api";
import { linkCompatibility } from "./importCompatibility";
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
  const compatibility = directory.importCompatibility;
  const copy = directory.builtin ? "unsupported" : compatibility?.copy
    ?? (directory.supportedModes.includes("managed_copy") ? "supported" : "unverified");
  const link = directory.builtin ? "unsupported" : compatibility ? linkCompatibility(compatibility)
    : directory.supportedModes.some((mode) => mode !== "managed_copy") ? "supported" : "unverified";
  const methods = [
    ["copy", "⧉", copy],
    ["link", "↗", link],
  ] as const;
  return (
    <div aria-label={String(t("agents.deploymentMethods.label"))} className="sh-agent-card__deployment-footer" role="group">
      <div className="sh-agent-card__deployment-methods">
      {methods.map(([mode, symbol, status]) => {
        const text = String(t(`agents.deploymentMethods.${mode}.${status}`));
        return (
          <span
            aria-label={text}
            className={`sh-agent-card__deployment-method is-${status}`}
            key={mode}
            role="img"
            title={directory.builtin ? String(t("agents.deploymentMethods.readonly")) : text}
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
