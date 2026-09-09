import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import type { RestoreConflictDecision, RestoreDecision, RestorePlan } from "../../api/bindings";
import type { OnboardingOperations } from "../bootstrap/api";

interface RestoreStepProps {
  operations: OnboardingOperations;
  onComplete: () => void;
  onBack: () => void;
}

export function RestoreStep({ operations, onComplete, onBack }: RestoreStepProps) {
  const { t } = useTranslation();
  // describeNativeError 以动态键调用翻译；i18next 的强类型键联合在此收窄。
  const describe = (error: unknown) =>
    describeNativeError(
      error,
      (key, options) => String(t(key as never, options as never)),
      "onboarding.genericError",
    );
  const [path, setPath] = useState<string | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, RestoreConflictDecision>>({});

  // Restore currently commits in one native call; keep an honest running
  // status (count + elapsed time) instead of leaving the UI frozen.
  useEffect(() => {
    if (!isRestoring) return;
    setElapsedSeconds(0);
    const timer = window.setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isRestoring]);

  const selectDirectory = async () => {
    setIsPreparing(true);
    setMessage(null);
    setPlan(null);
    setDecisions({});
    try {
      const picked = await operations.pickDirectory?.();
      if (!picked) {
        return;
      }
      const result = await operations.prepareRestore?.(picked);
      setPath(picked);
      setPlan(result ?? null);
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setIsPreparing(false);
    }
  };

  // B3：恢复冲突逐项决策。提交契约（CommitRestore.decisions）本就按条接收
  // 决策，向导此前静默全部 skip；现在如实列出冲突并要求显式决策。
  const conflicts = plan?.conflicts ?? [];
  const invalidConflicts = conflicts.filter((conflict) => conflict.kind === "invalid_portable_data");
  const decidableConflicts = conflicts.filter((conflict) => conflict.skill_id);
  const allDecided = decidableConflicts.every((conflict) => decisions[conflict.skill_id!]);
  const canRestore = Boolean(plan) && allDecided && invalidConflicts.length === 0;

  const restore = async () => {
    if (!path || !plan || !canRestore) {
      return;
    }
    setIsRestoring(true);
    setMessage(null);
    try {
      const submitted: RestoreDecision[] = decidableConflicts.map((conflict) => ({
        skill_id: conflict.skill_id ?? "",
        decision: decisions[conflict.skill_id!],
      }));
      await operations.commitRestore?.(path, submitted);
      onComplete();
    } catch (error) {
      setMessage(describe(error));
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
        <Button disabled={!canRestore || isPreparing} loading={isRestoring} onClick={() => void restore()}>
          {t("onboarding.restoreAndContinue")}
        </Button>
      ) : null}
      {plan && decidableConflicts.length > 0 ? (
        <fieldset aria-label={t("onboarding.restoreConflictsHeading")}>
          <legend>{t("onboarding.restoreConflictsHeading")}</legend>
          {decidableConflicts.map((conflict) => (
            <label key={conflict.skill_id}>
              {t("dataProtection.restore.decision", { skillId: conflict.skill_id })}
              <select
                value={decisions[conflict.skill_id!] ?? ""}
                onChange={(event) =>
                  setDecisions((current) => ({
                    ...current,
                    [conflict.skill_id!]: event.target.value as RestoreConflictDecision,
                  }))
                }
              >
                <option value="">{t("dataProtection.restore.choose")}</option>
                <option value="overwrite">{t("dataProtection.restore.overwrite")}</option>
                <option value="keep_both">{t("dataProtection.restore.keepBoth")}</option>
                <option value="skip">{t("dataProtection.restore.skip")}</option>
              </select>
            </label>
          ))}
        </fieldset>
      ) : null}
      {plan && invalidConflicts.length > 0 ? (
        <p role="alert" className="sh-onboarding__message">
          {t("dataProtection.restore.invalid")}
        </p>
      ) : null}
      {isRestoring && plan ? (
        <p aria-live="polite" className="sh-onboarding__message" role="status">
          {t("onboarding.restoreRunning", { count: plan.skills, seconds: elapsedSeconds })}
        </p>
      ) : null}
      {message ? <p aria-live="polite" className="sh-onboarding__message">{message}</p> : null}
      <Button disabled={isRestoring} onClick={onBack} variant="secondary">
        {t("onboarding.restoreBack")}
      </Button>
    </section>
  );
}
