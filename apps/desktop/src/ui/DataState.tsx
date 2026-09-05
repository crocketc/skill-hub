import { Button } from "./Button";

export interface DataStateProps {
  actionLabel?: string;
  /** Optional secondary line under the message (e.g. "you can leave this page"). */
  hint?: string;
  message: string;
  onAction?: () => void;
  state: "loading" | "empty" | "error" | "unavailable";
}

export function DataState({
  actionLabel,
  hint,
  message,
  onAction,
  state,
}: DataStateProps) {
  const role = state === "error" ? "alert" : "status";

  return (
    <section aria-live={state === "error" ? "assertive" : "polite"} className="sh-data-state" role={role}>
      <p>{message}</p>
      {hint ? <p className="sh-data-state__hint">{hint}</p> : null}
      {actionLabel && onAction ? (
        <Button onClick={onAction} variant="secondary">
          {actionLabel}
        </Button>
      ) : null}
    </section>
  );
}
