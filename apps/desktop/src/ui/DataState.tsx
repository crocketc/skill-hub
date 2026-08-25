import { Button } from "./Button";

export interface DataStateProps {
  actionLabel?: string;
  message: string;
  onAction?: () => void;
  state: "loading" | "empty" | "error" | "unavailable";
}

export function DataState({
  actionLabel,
  message,
  onAction,
  state,
}: DataStateProps) {
  const role = state === "error" ? "alert" : "status";

  return (
    <section aria-live={state === "error" ? "assertive" : "polite"} className="sh-data-state" role={role}>
      <p>{message}</p>
      {actionLabel && onAction ? (
        <Button onClick={onAction} variant="secondary">
          {actionLabel}
        </Button>
      ) : null}
    </section>
  );
}
