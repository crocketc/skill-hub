import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import "./onboarding.css";

export type WizardStepState = "complete" | "current" | "upcoming";

export interface WizardStep {
  label: string;
  state: WizardStepState;
}

export interface WizardStatus {
  kind: "info" | "success";
  text: string;
}

interface WizardShellProps {
  eyebrow: string;
  steps: WizardStep[];
  stepsLabel: string;
  /** Transient progress feedback announced through a persistent polite region. */
  status?: WizardStatus | null;
  children: ReactNode;
  /** Stable bottom action area; rendered as the frame footer when provided. */
  footer?: ReactNode;
}

/**
 * Shared onboarding/rediscovery frame: one eyebrow, one named step rail with
 * unified step names and completion states, one persistent status region and
 * one sticky bottom action area. Business branches render their own sections
 * as `children` so every state keeps an independent presentation.
 */
export function WizardShell({
  children,
  eyebrow,
  footer,
  status,
  steps,
  stepsLabel,
}: WizardShellProps) {
  const { t } = useTranslation();

  return (
    <main className="sh-onboarding">
      <div className="sh-onboarding__frame">
        <header className="sh-onboarding__header">
          <p>{eyebrow}</p>
        </header>
        <ol aria-label={stepsLabel} className="sh-onboarding__steps">
          {steps.map((step, index) => (
            <li
              aria-current={step.state === "current" ? "step" : undefined}
              className="sh-onboarding__step"
              data-state={step.state}
              key={step.label}
            >
              <span aria-hidden="true" className="sh-onboarding__step-marker">
                {step.state === "complete" ? <Icon name="success" size={16} /> : index + 1}
              </span>
              <span className="sh-onboarding__step-label">{step.label}</span>
              {step.state === "complete" ? (
                <span className="sh-onboarding__step-state">{t("onboarding.stepComplete")}</span>
              ) : null}
            </li>
          ))}
        </ol>
        <div className="sh-onboarding__body">{children}</div>
        <p className="sh-onboarding__status" role="status">
          {status ? (
            <>
              <Icon aria-hidden="true" name={status.kind === "success" ? "success" : "info"} size={16} />
              {status.text}
            </>
          ) : null}
        </p>
        {footer ? <footer className="sh-onboarding__actions">{footer}</footer> : null}
      </div>
    </main>
  );
}
