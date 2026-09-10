import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import "./import.css";

export type ImportStepState = "complete" | "current" | "upcoming";

export interface ImportStep {
  label: string;
  state: ImportStepState;
}

export type ImportStatusKind = "info" | "success" | "warning" | "failure";

export interface ImportStatus {
  kind: ImportStatusKind;
  text: string;
}

interface ImportShellProps {
  eyebrow: string;
  title: string;
  steps: ImportStep[];
  stepsLabel: string;
  /** Transient progress feedback announced through a persistent polite region. */
  status?: ImportStatus | null;
  children: ReactNode;
  /** Stable bottom action area; every phase keeps its actions in this footer. */
  footer?: ReactNode;
}

const statusIcon: Record<ImportStatusKind, "info" | "success" | "warning" | "failure"> = {
  failure: "failure",
  info: "info",
  success: "success",
  warning: "warning",
};

/**
 * Import flow frame: one eyebrow, one named step rail with unified step names
 * and completion states, one persistent status region and one stable bottom
 * action area. Each phase renders its own sections as `children` so failure,
 * cancellation, duplicates and recovery keep independent presentations.
 *
 * Contract twin of `features/onboarding/WizardShell` (same step rail, status
 * and footer semantics), rendered as a `section` because the import wizard is
 * always embedded inside the app shell's single `main`.
 */
export function ImportShell({
  children,
  eyebrow,
  footer,
  status,
  steps,
  stepsLabel,
  title,
}: ImportShellProps) {
  const { t } = useTranslation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // 当前步骤变化时（原主操作卸载）把焦点收回流程标题，避免焦点丢失到 body。
  const currentStep = steps.findIndex((step) => step.state === "current");
  const previousStepRef = useRef(currentStep);
  useEffect(() => {
    if (previousStepRef.current !== currentStep) {
      previousStepRef.current = currentStep;
      headingRef.current?.focus();
    }
  }, [currentStep]);

  return (
    <section aria-labelledby="import-wizard-title" className="sh-import-wizard">
      <header className="sh-import-wizard__topline">
        <div>
          <p className="sh-import-wizard__eyebrow">{eyebrow}</p>
          <h2 id="import-wizard-title" ref={headingRef} tabIndex={-1}>{title}</h2>
        </div>
      </header>
      <ol aria-label={stepsLabel} className="sh-import-wizard__steps">
        {steps.map((step, index) => (
          <li
            aria-current={step.state === "current" ? "step" : undefined}
            className="sh-import-wizard__step"
            data-state={step.state}
            key={step.label}
          >
            <span aria-hidden="true" className="sh-import-wizard__step-marker">
              {step.state === "complete" ? <Icon name="success" size={16} /> : index + 1}
            </span>
            <span className="sh-import-wizard__step-label">{step.label}</span>
            {step.state === "complete" ? (
              <span className="sh-import-wizard__step-state">{t("importWorkflow.stepComplete")}</span>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="sh-import-wizard__panel">{children}</div>
      <p className="sh-import-wizard__status" role="status">
        {status ? (
          <>
            <Icon aria-hidden="true" name={statusIcon[status.kind]} size={16} />
            {status.text}
          </>
        ) : null}
      </p>
      {footer ? <footer className="sh-import-wizard__actions">{footer}</footer> : null}
    </section>
  );
}
