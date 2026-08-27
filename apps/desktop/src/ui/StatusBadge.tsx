import type { ReactNode } from "react";

export interface StatusBadgeProps {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}

export function StatusBadge({ children, tone = "neutral" }: StatusBadgeProps) {
  return (
    <span className={`sh-status-badge sh-status-badge--${tone}`}>
      <span aria-hidden="true" className="sh-status-badge__marker" />
      {children}
    </span>
  );
}
