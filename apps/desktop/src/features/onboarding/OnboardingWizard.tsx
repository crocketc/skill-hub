import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import {
  type CompatibilityTarget,
  desktopBootstrapRuntime,
  type BootstrapRuntime,
  type InitializationScanState,
  type OnboardingOperations,
  desktopOnboardingOperations,
} from "../bootstrap/api";
import { CompatibilityStep } from "./CompatibilityStep";
import { LibraryStep } from "./LibraryStep";
import { ScanStep } from "./ScanStep";

interface OnboardingWizardProps {
  libraryPath?: string;
  onComplete?: () => void;
  onOpenImport?: (roots: string[]) => void;
  operations?: OnboardingOperations;
  runtime?: BootstrapRuntime;
}

function nativeErrorCode(error: unknown): string | null {
  if (typeof error === "string") {
    try {
      return nativeErrorCode(JSON.parse(error) as unknown);
    } catch {
      const match = error.match(/(?:code["']?\s*[:=]\s*["']?)([a-z0-9_.-]+)/i);
      return match?.[1] ?? null;
    }
  }
  if (error instanceof Error) {
    return nativeErrorCode(error.message);
  }
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code : null;
}

export function OnboardingWizard({
  libraryPath,
  onComplete,
  onOpenImport,
  operations = desktopOnboardingOperations,
  runtime = desktopBootstrapRuntime,
}: OnboardingWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [compatibilityConfirmed, setCompatibilityConfirmed] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanSlow, setScanSlow] = useState(false);
  const [scanInBackground, setScanInBackground] = useState(false);
  const [scanState, setScanState] = useState<InitializationScanState | null>(null);
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [selectionConfirmed, setSelectionConfirmed] = useState(false);
  const [targets, setTargets] = useState<CompatibilityTarget[] | null>(null);
  const [completionState, setCompletionState] = useState<"idle" | "pending" | "complete">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [nativeLibraryPath, setNativeLibraryPath] = useState(libraryPath);

  useEffect(() => {
    setNativeLibraryPath(libraryPath);
    if (libraryPath) {
      return;
    }
    let active = true;
    void runtime
      .getBootstrapView()
      .then((view) => {
        if (active && view.snapshot.library_path) {
          setNativeLibraryPath(view.snapshot.library_path);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [libraryPath, runtime]);

  const showError = () => setMessage(t("onboarding.contractUnavailable"));

  const discoverAgents = async () => {
    setIsDiscovering(true);
    setMessage(null);
    try {
      const result = await operations.discoverAgents();
      setTargets(result.targets);
      setSelectedTargetIds([]);
      setSelectionConfirmed(false);
    } catch {
      showError();
    } finally {
      setIsDiscovering(false);
    }
  };

  const scan = async () => {
    setIsScanning(true);
    setScanSlow(false);
    setScanInBackground(false);
    setScanState(null);
    setMessage(null);
    try {
      const result = await runtime.runInitializationScan(selectedTargetIds);
      setScanState(result);
      setMessage(
        result.kind === "completed"
          ? t("onboarding.scanComplete")
          : t("onboarding.scanStarted"),
      );
    } catch (error) {
      const code = nativeErrorCode(error);
      console.error("initialization_scan_failed", code ?? "unknown");
      setMessage(code ? t("onboarding.scanFailedWithCode", { code }) : t("onboarding.scanFailedWithoutCode"));
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    if (!isScanning || scanInBackground) return;
    const timer = window.setTimeout(() => setScanSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [isScanning, scanInBackground]);

  const complete = async (skipped: boolean, afterComplete?: () => void) => {
    if (!nativeLibraryPath || completionState !== "idle") {
      return;
    }
    setCompletionState("pending");
    setMessage(null);
    try {
      await operations.completeOnboarding({ libraryPath: nativeLibraryPath, skipped });
      setCompletionState("complete");
      (afterComplete ?? onComplete)?.();
    } catch {
      setCompletionState("idle");
      showError();
    }
  };

  const selectTarget = (targetId: string, selected: boolean) => {
    setSelectedTargetIds((current) =>
      selected ? [...current, targetId] : current.filter((id) => id !== targetId),
    );
    setSelectionConfirmed(false);
  };

  const canContinue =
    step === 0
      ? Boolean(nativeLibraryPath)
      : step === 1
        ? selectedTargetIds.length === 0 || selectionConfirmed
        : false;

  const activeStep =
    step === 0 ? (
      <LibraryStep libraryPath={nativeLibraryPath} />
    ) : step === 1 ? (
      <CompatibilityStep
        confirmed={compatibilityConfirmed}
        isDiscovering={isDiscovering}
        selectionConfirmed={selectionConfirmed}
        selectedTargetIds={selectedTargetIds}
        targets={targets}
        onConfirmChange={setCompatibilityConfirmed}
        onDiscover={() => void discoverAgents()}
        onSelectionConfirmChange={setSelectionConfirmed}
        onTargetSelectionChange={selectTarget}
        onSelectAllAvailable={() => {
          setSelectedTargetIds(targets?.filter((target) => target.availability === "available").map((target) => target.id) ?? []);
          setSelectionConfirmed(false);
        }}
      />
    ) : (
      <ScanStep
        isScanning={isScanning && !scanInBackground}
        onScan={() => void scan()}
        onContinueInBackground={scanSlow ? () => {
          setScanInBackground(true);
          setIsScanning(false);
          setMessage(t("onboarding.scanBackground"));
        } : undefined}
        onOpenImport={onOpenImport ? (roots) => void complete(false, () => onOpenImport(roots)) : undefined}
        scanInBackground={scanInBackground}
        scanResult={scanState?.kind === "completed" ? scanState.result : undefined}
      />
    );

  if (completionState === "complete") {
    return (
      <main className="sh-onboarding">
        <section aria-live="polite" className="sh-onboarding__card">
          <h1>{t("onboarding.finishedTitle")}</h1>
          <p>{t("onboarding.finishedDescription")}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="sh-onboarding">
      <div className="sh-onboarding__frame">
        <header className="sh-onboarding__header">
          <p>{t("onboarding.eyebrow")}</p>
          <span>{t("onboarding.step", { current: step + 1 })}</span>
        </header>
        {activeStep}
        {message ? <p aria-live="polite" className="sh-onboarding__message">{message}</p> : null}
        {scanState?.kind === "in_progress" ? (
          <p className="sh-onboarding__message">
            <code>{scanState.operationId}</code>
            {` · ${scanState.phase}`}
          </p>
        ) : null}
        <footer className="sh-onboarding__actions">
          {step > 0 ? (
            <Button onClick={() => setStep((current) => current - 1)} variant="secondary">
              {t("onboarding.back")}
            </Button>
          ) : null}
          {step < 2 ? (
            <Button disabled={!canContinue} onClick={() => setStep((current) => current + 1)}>
              {t("onboarding.continue")}
            </Button>
          ) : (
            <>
              <Button disabled={completionState !== "idle" || !nativeLibraryPath} onClick={() => void complete(false)}>
                {t("onboarding.finish")}
              </Button>
              <Button disabled={completionState !== "idle" || !nativeLibraryPath} onClick={() => void complete(false)} variant="secondary">
                {t("onboarding.skipScan")}
              </Button>
            </>
          )}
          <ConfirmDialog
            cancelLabel={t("actions.cancel")}
            confirmLabel={t("onboarding.confirmSkip")}
            description={t("onboarding.skipDescription", { path: nativeLibraryPath })}
            onConfirm={() => void complete(true)}
            title={t("onboarding.skipTitle")}
            trigger={<Button disabled={!nativeLibraryPath || completionState !== "idle"} variant="ghost">{t("onboarding.skip")}</Button>}
            variant="primary"
          />
        </footer>
      </div>
    </main>
  );
}
