import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import {
  desktopBootstrapRuntime,
  type BootstrapRuntime,
  type OnboardingOperations,
  unavailableOnboardingOperations,
} from "../bootstrap/api";
import { CompatibilityStep } from "./CompatibilityStep";
import { LibraryStep } from "./LibraryStep";
import { ScanStep } from "./ScanStep";

interface OnboardingWizardProps {
  defaultLibraryPath?: string;
  operations?: OnboardingOperations;
  runtime?: BootstrapRuntime;
}

const defaultLibraryPath = "~/SkillHub/skills";

export function OnboardingWizard({
  defaultLibraryPath: libraryPath = defaultLibraryPath,
  operations = unavailableOnboardingOperations,
  runtime = desktopBootstrapRuntime,
}: OnboardingWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [compatibilityConfirmed, setCompatibilityConfirmed] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const showError = () => setMessage(t("onboarding.contractUnavailable"));

  const discoverAgents = async () => {
    setIsDiscovering(true);
    setMessage(null);
    try {
      await operations.discoverAgents();
    } catch {
      showError();
    } finally {
      setIsDiscovering(false);
    }
  };

  const scan = async () => {
    setIsScanning(true);
    setMessage(null);
    try {
      await runtime.runInitializationScan([]);
      setMessage(t("onboarding.scanComplete"));
    } catch {
      setMessage(t("onboarding.scanFailed"));
    } finally {
      setIsScanning(false);
    }
  };

  const complete = async (skipped: boolean) => {
    setMessage(null);
    try {
      await operations.completeOnboarding({ libraryPath, skipped });
      setMessage(t("onboarding.complete"));
    } catch {
      showError();
    }
  };

  const activeStep =
    step === 0 ? (
      <LibraryStep defaultLibraryPath={libraryPath} />
    ) : step === 1 ? (
      <CompatibilityStep
        confirmed={compatibilityConfirmed}
        isDiscovering={isDiscovering}
        onConfirmChange={setCompatibilityConfirmed}
        onDiscover={() => void discoverAgents()}
      />
    ) : (
      <ScanStep isScanning={isScanning} onScan={() => void scan()} />
    );

  return (
    <main className="sh-onboarding">
      <div className="sh-onboarding__frame">
        <header className="sh-onboarding__header">
          <p>{t("onboarding.eyebrow")}</p>
          <span>{t("onboarding.step", { current: step + 1 })}</span>
        </header>
        {activeStep}
        {message ? <p aria-live="polite" className="sh-onboarding__message">{message}</p> : null}
        <footer className="sh-onboarding__actions">
          {step > 0 ? (
            <Button onClick={() => setStep((current) => current - 1)} variant="secondary">
              {t("onboarding.back")}
            </Button>
          ) : null}
          {step < 2 ? (
            <Button onClick={() => setStep((current) => current + 1)}>
              {t("onboarding.continue")}
            </Button>
          ) : (
            <>
              <Button onClick={() => void complete(false)}>
                {t("onboarding.finish")}
              </Button>
              <Button onClick={() => void complete(false)} variant="secondary">
                {t("onboarding.skipScan")}
              </Button>
            </>
          )}
          <ConfirmDialog
            cancelLabel={t("actions.cancel")}
            confirmLabel={t("onboarding.confirmSkip")}
            description={t("onboarding.skipDescription", { path: libraryPath })}
            onConfirm={() => void complete(true)}
            title={t("onboarding.skipTitle")}
            trigger={<Button variant="ghost">{t("onboarding.skip")}</Button>}
            variant="primary"
          />
        </footer>
      </div>
    </main>
  );
}
