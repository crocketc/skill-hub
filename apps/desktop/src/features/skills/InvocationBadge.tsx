import { useTranslation } from "react-i18next";
import type { InvocationPolicy, InvocationMode } from "./api";

const MODE_KEYS = {
  disabled: "skillLibrary.invocation.modes.disabled",
  model_and_user: "skillLibrary.invocation.modes.modelAndUser",
  model_only: "skillLibrary.invocation.modes.modelOnly",
  user_only: "skillLibrary.invocation.modes.userOnly",
} as const satisfies Record<InvocationMode, string>;

function ActorIcon({ actor }: { actor: "model" | "user" }) {
  if (actor === "model") {
    return (
      <svg aria-hidden="true" className="sh-invocation-badge__icon sh-invocation-badge__icon--model" viewBox="0 0 20 20">
        <path d="M10 2.5 12 6l3.5 2-3.5 2-2 3.5-2-3.5-3.5-2 3.5-2L10 2.5Z" />
        <path d="M15.5 12.5 16.5 14l1.5 1-1.5 1-1 1.5-1-1.5-1.5-1 1.5-1 1-1.5Z" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" className="sh-invocation-badge__icon sh-invocation-badge__icon--user" viewBox="0 0 20 20">
      <circle cx="10" cy="6" r="3" />
      <path d="M4.5 17c.5-3.1 2.3-4.8 5.5-4.8s5 1.7 5.5 4.8" />
    </svg>
  );
}

export function InvocationBadge({ policy }: { policy?: InvocationPolicy }) {
  const { t } = useTranslation();
  const mode = policy?.mode ?? "model_and_user";
  const label = String(t(MODE_KEYS[mode]));
  const actors = mode === "model_and_user" ? ["model", "user"] : mode === "model_only" ? ["model"] : mode === "user_only" ? ["user"] : [];
  return (
    <span
      aria-label={label}
      className={`sh-invocation-badge sh-invocation-badge--${mode}`}
      data-invocation-mode={mode}
      title={policy?.field ? `${label} · ${policy.field}` : label}
    >
      <span aria-hidden="true" className="sh-invocation-badge__actors">
        {actors.map((actor) => <ActorIcon actor={actor as "model" | "user"} key={actor} />)}
        {mode === "disabled" ? <span className="sh-invocation-badge__disabled">×</span> : null}
      </span>
      <span className="sh-invocation-badge__label">{label}</span>
    </span>
  );
}
