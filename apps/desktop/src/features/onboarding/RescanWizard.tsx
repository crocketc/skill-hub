import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import {
  desktopBootstrapRuntime,
  desktopOnboardingOperations,
  type BootstrapRuntime,
  type CompatibilityTarget,
  type InitializationScanState,
  type OnboardingOperations,
} from "../bootstrap/api";
import { CompatibilityStep } from "./CompatibilityStep";
import { ScanStep } from "./ScanStep";

export interface RescanWizardProps {
  libraryPath: string;
  operations?: OnboardingOperations;
  runtime?: BootstrapRuntime;
  onCancel?: () => void;
  onComplete?: () => void;
  onOpenImport?: (roots: string[]) => void;
}

export function RescanWizard({
  libraryPath,
  operations = desktopOnboardingOperations,
  runtime = desktopBootstrapRuntime,
  onCancel,
  onComplete,
  onOpenImport,
}: RescanWizardProps) {
  const { t } = useTranslation();
  const describe = (error: unknown) =>
    describeNativeError(
      error,
      (key, options) => String(t(key as never, options as never)),
      "onboarding.genericError",
    );
  const [step, setStep] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [selectionConfirmed, setSelectionConfirmed] = useState(false);
  const [targets, setTargets] = useState<CompatibilityTarget[] | null>(null);
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanState, setScanState] = useState<InitializationScanState | null>(null);
  const [operationError, setOperationError] = useState<{ kind: "discover" | "scan"; message: string } | null>(null);

  const discover = async () => {
    setIsDiscovering(true);
    setOperationError(null);
    try {
      const result = await operations.discoverAgents();
      setTargets(result.targets);
      setSelectedTargetIds([]);
      setSelectionConfirmed(false);
    } catch (error) {
      setOperationError({ kind: "discover", message: describe(error) });
    } finally {
      setIsDiscovering(false);
    }
  };

  const scan = async () => {
    setIsScanning(true);
    setOperationError(null);
    try {
      setScanState(await runtime.runInitializationScan(selectedTargetIds));
    } catch (error) {
      setOperationError({ kind: "scan", message: describe(error) });
    } finally {
      setIsScanning(false);
    }
  };

  const canContinue = step === 0
    ? confirmed
    : step === 1
      ? targets !== null && (targets.length === 0 || (selectedTargetIds.length > 0 && selectionConfirmed))
      : false;

  return (
    <main className="sh-onboarding">
      <div className="sh-onboarding__frame">
        <header className="sh-onboarding__header">
          <p>{t("onboarding.rescanEyebrow")}</p>
          <span>{t("onboarding.rescanStep", { current: step + 1 })}</span>
        </header>
        {step > 0 ? (
          <div className="sh-onboarding__path">
            <span>{t("onboarding.rescanLibraryLocation")}</span>
            <code>{libraryPath}</code>
          </div>
        ) : null}
        {step === 0 ? (
          <section aria-labelledby="rescan-library-title" className="sh-onboarding__card">
            <span className="sh-onboarding__ordinal">1</span>
            <h1 id="rescan-library-title">{t("onboarding.rescanTitle")}</h1>
            <p>{t("onboarding.rescanDescription")}</p>
            <div className="sh-onboarding__path">
              <span>{t("onboarding.rescanLibraryLocation")}</span>
              <code>{libraryPath}</code>
            </div>
            <label className="sh-onboarding__check">
              <input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
              {t("onboarding.rescanConfirmation")}
            </label>
          </section>
        ) : step === 1 ? (
          <CompatibilityStep
            confirmed={confirmed}
            isDiscovering={isDiscovering}
            selectionConfirmed={selectionConfirmed}
            selectedTargetIds={selectedTargetIds}
            targets={targets}
            onConfirmChange={setConfirmed}
            onDiscover={() => void discover()}
            onSelectionConfirmChange={setSelectionConfirmed}
            onTargetSelectionChange={(id, selected) => setSelectedTargetIds((current) => selected ? [...current, id] : current.filter((item) => item !== id))}
            onSelectAllAvailable={() => setSelectedTargetIds(targets?.filter((target) => target.availability === "available").map((target) => target.id) ?? [])}
          />
        ) : (
          <ScanStep
            isScanning={isScanning}
            onScan={() => void scan()}
            onOpenImport={onOpenImport}
            scanResult={scanState?.kind === "completed" ? scanState.result : undefined}
          />
        )}
        {operationError ? (
          <DataState
            actionLabel={t("actions.retry")}
            message={operationError.message}
            onAction={() => void (operationError.kind === "discover" ? discover() : scan())}
            state="error"
          />
        ) : null}
        <footer className="sh-onboarding__actions">
          {onCancel ? <Button onClick={onCancel} variant="secondary">{t("onboarding.rescanCancel")}</Button> : null}
          {step > 0 ? <Button onClick={() => setStep((current) => current - 1)} variant="secondary">{t("onboarding.back")}</Button> : null}
          {step < 2 ? <Button disabled={!canContinue} onClick={() => setStep((current) => current + 1)}>{t("onboarding.continue")}</Button> : null}
          {step === 2 && onComplete ? <Button onClick={onComplete}>{t("onboarding.rescanComplete")}</Button> : null}
        </footer>
      </div>
    </main>
  );
}
