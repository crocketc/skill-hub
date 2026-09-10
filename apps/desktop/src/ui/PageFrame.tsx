import type { ReactNode } from "react";

export interface PageFrameProps {
  children: ReactNode;
  /**
   * `standard` constrains prose-heavy pages to a readable measure;
   * `wide` lets entity grids use the full workspace width.
   */
  width?: "standard" | "wide";
}

/**
 * Page-level frame: vertical rhythm, left alignment and the single main
 * scroll area inside AppShell. It renders no heading of its own.
 */
export function PageFrame({ children, width = "standard" }: PageFrameProps) {
  return (
    <div
      className={[
        "sh-page-frame",
        width === "wide" ? "sh-page-frame--wide" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
