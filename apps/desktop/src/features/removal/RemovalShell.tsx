import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "../../ui/Icon";
import "./removal.css";

export type RemovalStatusKind = "info" | "success" | "warning" | "failure";

export interface RemovalStatus {
  kind: RemovalStatusKind;
  text: string;
}

interface RemovalShellProps {
  eyebrow: string;
  title: string;
  /** Transient progress feedback announced through a persistent polite region. */
  status?: RemovalStatus | null;
  children: ReactNode;
  /** Stable bottom action row: secondary group left, danger primary right. */
  footer?: ReactNode;
}

/**
 * Removal flow frame: contract twin of `features/import/ImportShell`
 * (same eyebrow, persistent status region and stable footer semantics)
 * rendered as an embedded `role="dialog"` section because removal
 * confirmations open on top of the host page instead of owning the main
 * content. Focus moves into the flow heading on open and returns to the
 * trigger when the dialog unmounts.
 */
export function RemovalShell({
  children,
  eyebrow,
  footer,
  status,
  title,
}: RemovalShellProps) {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    return () => {
      triggerRef.current?.focus();
    };
  }, []);

  return (
    <section aria-labelledby={titleId} className="sh-removal-flow sh-workflow-card" role="dialog">
      <p className="sh-removal-flow__eyebrow">{eyebrow}</p>
      <h2 className="sh-removal-flow__title" id={titleId} ref={headingRef} tabIndex={-1}>{title}</h2>
      {children}
      <p className="sh-removal-flow__status" role="status">
        {status ? (
          <>
            <Icon aria-hidden="true" name={status.kind} size={16} />
            {status.text}
          </>
        ) : null}
      </p>
      {footer ? <footer className="sh-removal-flow__actions">{footer}</footer> : null}
    </section>
  );
}
