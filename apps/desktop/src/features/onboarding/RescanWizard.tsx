import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { CheckboxField } from "../../ui/CheckboxField";
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
import { WizardShell, type WizardStep } from "./WizardShell";
import { displayPath } from "../../platform/displayPath";
import { beginBackgroundScan, resetBackgroundScan } from "../bootstrap/backgroundScan";

export interface RescanWizardProps {
  /** Allows the slow-scan handoff state to be reached deterministically in previews. */
  scanSlowAfterMs?: number;
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
  scanSlowAfterMs = 10_000,
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
  const [targets, setTargets] = useState<CompatibilityTarget[] | null>(null);
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanSlow, setScanSlow] = useState(false);
  const [scanInBackground, setScanInBackground] = useState(false);
  const [scanState, setScanState] = useState<InitializationScanState | null>(null);
  const [operationError, setOperationError] = useState<{ kind: "discover" | "scan"; message: string } | null>(null);
  const mountedRef = useRef(true);
  const scanHandleRef = useRef<Promise<InitializationScanState> | null>(null);
  const scanStartedAtRef = useRef<number | null>(null);
  const scanScopeIdsRef = useRef<string[]>([]);
  const scanSettledRef = useRef(true);
  const handedOffRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const pendingScan = scanHandleRef.current;
      if (pendingScan && !scanSettledRef.current && !handedOffRef.current) {
        beginBackgroundScan(
          pendingScan,
          scanScopeIdsRef.current,
          scanStartedAtRef.current ?? Date.now(),
        );
      }
    };
  }, []);

  const discover = async () => {
    setIsDiscovering(true);
    setOperationError(null);
    try {
      const result = await operations.discoverAgents();
      setTargets(result.targets);
      setSelectedTargetIds([]);
    } catch (error) {
      setOperationError({ kind: "discover", message: describe(error) });
    } finally {
      setIsDiscovering(false);
    }
  };

  const scan = async () => {
    if (isScanning || scanInBackground) return;
    setIsScanning(true);
    setScanSlow(false);
    setScanInBackground(false);
    setScanState(null);
    setOperationError(null);
    handedOffRef.current = false;
    scanSettledRef.current = false;
    scanStartedAtRef.current = Date.now();
    scanScopeIdsRef.current = [...selectedTargetIds];
    resetBackgroundScan();
    try {
      const attempt = runtime.runInitializationScan(selectedTargetIds);
      scanHandleRef.current = attempt;
      const result = await attempt;
      scanSettledRef.current = true;
      if (!mountedRef.current) return;
      resetBackgroundScan();
      if (handedOffRef.current) setScanInBackground(false);
      setScanState(result);
      if (result.kind === "in_progress") {
        beginBackgroundScan(
          Promise.resolve(result),
          scanScopeIdsRef.current,
          scanStartedAtRef.current ?? Date.now(),
        );
        setScanInBackground(true);
      }
    } catch (error) {
      scanSettledRef.current = true;
      if (!mountedRef.current) return;
      resetBackgroundScan();
      if (handedOffRef.current) setScanInBackground(false);
      setOperationError({ kind: "scan", message: describe(error) });
    } finally {
      if (mountedRef.current) setIsScanning(false);
    }
  };

  useEffect(() => {
    if (!isScanning || scanInBackground) return;
    const timer = window.setTimeout(() => setScanSlow(true), scanSlowAfterMs);
    return () => window.clearTimeout(timer);
  }, [isScanning, scanInBackground, scanSlowAfterMs]);

  const continueScanInBackground = () => {
    const pendingScan = scanHandleRef.current;
    if (!pendingScan || scanSettledRef.current || handedOffRef.current) return;
    handedOffRef.current = true;
    beginBackgroundScan(
      pendingScan,
      scanScopeIdsRef.current,
      scanStartedAtRef.current ?? Date.now(),
    );
    setScanInBackground(true);
    setIsScanning(false);
  };

  const leaveWizard = (callback?: () => void) => {
    continueScanInBackground();
    callback?.();
  };

  const canContinue = step === 0
    ? confirmed
    : step === 1
      ? targets !== null && (targets.length === 0 || selectedTargetIds.length > 0)
      : false;

  const rediscoverySteps = (current: number): WizardStep[] => [
    {
      label: t("onboarding.rescanTitle"),
      state: current > 0 ? "complete" : "current",
    },
    {
      label: t("onboarding.compatibilityTitle"),
      state: current === 1 ? "current" : current > 1 ? "complete" : "upcoming",
    },
    {
      label: t("onboarding.scanTitle"),
      state: current === 2 ? "current" : "upcoming",
    },
  ];

  const footer = (
    <>
      <div className="sh-onboarding__actions-group">
        {onCancel ? <Button onClick={() => leaveWizard(onCancel)} variant="secondary">{t("onboarding.rescanCancel")}</Button> : null}
        {step > 0 ? <Button onClick={() => setStep((current) => current - 1)} variant="secondary">{t("onboarding.back")}</Button> : null}
      </div>
      <div className="sh-onboarding__actions-group sh-onboarding__actions-group--primary">
        {step === 2 && onOpenImport && scanState?.kind === "completed" && scanState.result.discovered.length > 0 ? (
          <Button onClick={() => onOpenImport(scanState.result.roots)} variant="secondary">
            {t("onboarding.scanOpenImport")}
          </Button>
        ) : null}
        {step < 2 ? (
          <Button disabled={!canContinue} onClick={() => setStep((current) => current + 1)} size="lg">
            {t("onboarding.continue")}
          </Button>
        ) : null}
        {step === 2 ? (
          <Button
            disabled={scanInBackground}
            loading={isScanning}
            onClick={() => void scan()}
            variant={scanState || scanInBackground ? "secondary" : "primary"}
          >
            {scanInBackground
              ? t("onboarding.rescanScanInBackground")
              : scanState
                ? t("onboarding.rescanScan")
                : t("onboarding.startReadOnlyScan")}
          </Button>
        ) : null}
        {step === 2 && onComplete ? (
          <Button onClick={() => leaveWizard(onComplete)} size="lg">{t("onboarding.rescanComplete")}</Button>
        ) : null}
      </div>
    </>
  );

  return (
    <WizardShell
      eyebrow={t("onboarding.rescanEyebrow")}
      footer={footer}
      steps={rediscoverySteps(step)}
      stepsLabel={t("onboarding.rescanStepsLabel")}
    >
      {step > 0 ? (
        <div className="sh-onboarding__path">
          <span>{t("onboarding.rescanLibraryLocation")}</span>
          <code>{displayPath(libraryPath)}</code>
        </div>
      ) : null}
      {step === 0 ? (
        <section aria-labelledby="rescan-library-title" className="sh-onboarding__card">
          <h1 id="rescan-library-title">{t("onboarding.rescanTitle")}</h1>
          <p>{t("onboarding.rescanDescription")}</p>
          <div className="sh-onboarding__path">
            <span>{t("onboarding.rescanLibraryLocation")}</span>
            <code>{displayPath(libraryPath)}</code>
          </div>
          <CheckboxField
            checked={confirmed}
            label={t("onboarding.rescanConfirmation")}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
        </section>
      ) : step === 1 ? (
        <CompatibilityStep
          confirmed={confirmed}
          isDiscovering={isDiscovering}
          selectedTargetIds={selectedTargetIds}
          targets={targets}
          onConfirmChange={setConfirmed}
          onDiscover={() => void discover()}
          onTargetSelectionChange={(id, selected) => setSelectedTargetIds((current) => selected ? [...current, id] : current.filter((item) => item !== id))}
          onSelectAllAvailable={() => setSelectedTargetIds(targets?.filter((target) => target.availability === "available").map((target) => target.id) ?? [])}
        />
      ) : (
        <ScanStep
          continueInBackgroundLabel={t("onboarding.rescanContinueInBackground")}
          isScanning={isScanning}
          onContinueInBackground={scanSlow ? continueScanInBackground : undefined}
          scanResult={scanState?.kind === "completed" ? scanState.result : undefined}
          scanStartedAt={scanStartedAtRef.current ?? undefined}
          scanInBackground={scanInBackground}
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
    </WizardShell>
  );
}
