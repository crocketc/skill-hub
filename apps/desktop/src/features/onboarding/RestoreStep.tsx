import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { RestoreDecision, RestorePlan } from "../../api/bindings";
import type { OnboardingOperations } from "../bootstrap/api";

interface RestoreStepProps {
  operations: OnboardingOperations;
  onComplete: () => void;
  onBack: () => void;
}

export function RestoreStep({ operations, onComplete, onBack }: RestoreStepProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selectDirectory = async () => {
    setIsPreparing(true);
    setMessage(null);
    setPlan(null);
    try {
      const picked = await operations.pickDirectory?.();
      if (!picked) {
        return;
      }
      const result = await operations.prepareRestore?.(picked);
      setPath(picked);
      setPlan(result ?? null);
    } catch {
      setMessage(t("onboarding.contractUnavailable"));
    } finally {
      setIsPreparing(false);
    }
  };

  const restore = async () => {
    if (!path || !plan) {
      return;
    }
    setIsRestoring(true);
    setMessage(null);
    try {
      const decisions: RestoreDecision[] = plan.conflicts.map((conflict) => ({
        skill_id: conflict.skill_id ?? "",
        decision: "skip",
      }));
      await operations.commitRestore?.(path, decisions);
      onComplete();
    } catch {
      setMessage(t("onboarding.contractUnavailable"));
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <section aria-labelledby="restore-step-title" className="sh-onboarding__card">
      <span className="sh-onboarding__ordinal">0</span>
      <h1 id="restore-step-title">{t("onboarding.restoreTitle")}</h1>
      <p>{t("onboarding.restoreDescription")}</p>
      <Button disabled={isRestoring} loading={isPreparing} onClick={() => void selectDirectory()}>
        {t("onboarding.selectBackupDirectory")}
      </Button>
      {plan && plan.skills > 0 ? (
        <p className="sh-onboarding__message" role="status">
          {t("onboarding.restoreFoundSkills", { n: plan.skills })}
        </p>
      ) : plan ? (
        <p className="sh-onboarding__message" role="status">
          {t("onboarding.restoreNoSkills")}
        </p>
      ) : null}
      {plan && plan.skills > 0 ? (
        <Button disabled={isPreparing} loading={isRestoring} onClick={() => void restore()}>
          {t("onboarding.restoreAndContinue")}
        </Button>
      ) : null}
      {message ? <p aria-live="polite" className="sh-onboarding__message">{message}</p> : null}
      <Button disabled={isRestoring} onClick={onBack} variant="secondary">
        {t("onboarding.restoreBack")}
      </Button>
    </section>
  );
}
