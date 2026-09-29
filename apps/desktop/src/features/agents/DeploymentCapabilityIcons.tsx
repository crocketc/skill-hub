import type { AgentDirectoryView } from "./api";
import "./deploymentCapabilityIcons.css";

export function DeploymentCapabilityIcons({
  directory,
  t,
}: {
  directory?: AgentDirectoryView;
  t: (key: string, options?: Record<string, unknown>) => string;
}): JSX.Element | null {
  if (!directory) return null;
  const methods = [
    ["managed_copy", "⧉"],
    ["symbolic_link", "↗"],
    ["directory_junction", "⊞"],
  ] as const;
  return (
    <div aria-label={String(t("agents.deploymentMethods.label"))} className="sh-agent-card__deployment-methods">
      {methods.map(([mode, symbol]) => {
        const supported = directory.supportedModes.includes(mode);
        const recommended = directory.preferredMode === mode;
        return (
          <span
            aria-label={String(t(`agents.deploymentMethods.${mode}.${supported ? "supported" : "unsupported"}`))}
            className={`sh-agent-card__deployment-method ${supported ? "is-supported" : "is-unsupported"} ${recommended ? "is-recommended" : ""}`}
            key={mode}
            title={String(t(`agents.deploymentMethods.${mode}.${supported ? "supported" : "unsupported"}`))}
          >
            <span aria-hidden="true">{symbol}</span>
          </span>
        );
      })}
    </div>
  );
}
