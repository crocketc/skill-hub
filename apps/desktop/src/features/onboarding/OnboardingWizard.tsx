import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
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
import { BranchSelection, type InitializationBranch } from "./BranchSelection";
import { CompatibilityStep } from "./CompatibilityStep";
import { LibraryStep } from "./LibraryStep";
import { RestoreStep } from "./RestoreStep";
import { ScanStep } from "./ScanStep";
import type { ThemeName } from "../../styles/theme";

interface OnboardingWizardProps {
  initialBranch?: "create" | "select";
  libraryPath?: string;
  onComplete?: () => void;
  onOpenImport?: (roots: string[]) => void;
  operations?: OnboardingOperations;
  runtime?: BootstrapRuntime;
  onThemeChange?: (theme: ThemeName) => void;
  theme?: ThemeName;
}

/**
 * Snapshot taken when onboarding commits. The summary page renders from this
 * so it can state honestly what ran (and what did not) instead of showing
 * fabricated zero counts.
 */
interface CompletionSnapshot {
  branch: InitializationBranch;
  skipped: boolean;
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
  initialBranch = "create",
  libraryPath,
  onComplete,
  onOpenImport,
  operations = desktopOnboardingOperations,
  runtime = desktopBootstrapRuntime,
  onThemeChange,
  theme = "moss-neutral",
}: OnboardingWizardProps) {
  const { t } = useTranslation();
  // describeNativeError 以动态键调用翻译；i18next 的强类型键联合在此收窄。
  const describe = (error: unknown) =>
    describeNativeError(
      error,
      (key, options) => String(t(key as never, options as never)),
      "onboarding.genericError",
    );
  const [branch, setBranch] = useState<InitializationBranch | null>(
    initialBranch === "select" ? null : "create",
  );
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
  const [completionSnapshot, setCompletionSnapshot] = useState<CompletionSnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [nativeLibraryPath, setNativeLibraryPath] = useState(libraryPath);
  const [customLibraryPath, setCustomLibraryPath] = useState<string | null>(null);

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

  const discoverAgents = async () => {
    setIsDiscovering(true);
    setMessage(null);
    try {
      const result = await operations.discoverAgents();
      setTargets(result.targets);
      setSelectedTargetIds([]);
      setSelectionConfirmed(false);
    } catch (error) {
      setMessage(describe(error));
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

  // Completion stays on the summary page; the user explicitly enters the app
  // or the import flow from there, so nothing jumps away automatically.
  const complete = async (skipped: boolean) => {
    if (!nativeLibraryPath || completionState !== "idle") {
      return;
    }
    setCompletionState("pending");
    setMessage(null);
    try {
      await operations.completeOnboarding({ libraryPath: nativeLibraryPath, skipped });
      setCompletionSnapshot({ branch: branch ?? "create", skipped });
      setCompletionState("complete");
    } catch (error) {
      setCompletionState("idle");
      setMessage(describe(error));
    }
  };

  const pickCustomDirectory = async () => {
    setMessage(null);
    try {
      const path = await operations.pickDirectory?.();
      if (path) setCustomLibraryPath(path);
    } catch (error) {
      setMessage(describe(error));
    }
  };

  // A custom root is persisted through `set_library_root` and applied by
  // restarting, which rebuilds every library handle against the chosen path.
  const applyCustomRoot = async () => {
    if (!customLibraryPath || completionState !== "idle") return;
    setCompletionState("pending");
    setMessage(null);
    try {
      await operations.setLibraryRoot?.(customLibraryPath);
      // 后端 configured_library_path 以持久化值为准；保存成功后立即回显
      // 所选目录，即使重启未完成或失败，UI 也如实反映已保存的库根。
      setNativeLibraryPath(customLibraryPath);
      await operations.restart?.();
      setCompletionState("idle");
      setMessage(t("onboarding.restartPending"));
    } catch (error) {
      setCompletionState("idle");
      setMessage(describe(error));
    }
  };

  const continueFromLibraryStep = () => {
    if (customLibraryPath) {
      void applyCustomRoot();
    } else {
      setStep(1);
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
        ? targets !== null && (targets.length === 0 || (selectedTargetIds.length > 0 && selectionConfirmed))
        : false;

  const scannedRoots = scanState?.kind === "completed" ? scanState.result.roots : [];

  const activeStep =
    step === 0 ? (
      <LibraryStep
        libraryPath={nativeLibraryPath}
        customLibraryPath={customLibraryPath}
        onPickCustomDirectory={operations.pickDirectory ? () => void pickCustomDirectory() : undefined}
        onThemeChange={onThemeChange ?? (() => undefined)}
        theme={theme}
      />
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
        scanInBackground={scanInBackground}
        scanResult={scanState?.kind === "completed" ? scanState.result : undefined}
      />
    );

  if (completionState === "complete") {
    const summary = completionSnapshot;
    const restoreSummary = summary?.branch === "restore";
    const scanResult = scanState?.kind === "completed" ? scanState.result : null;
    return (
      <main className="sh-onboarding">
        <section aria-live="polite" className="sh-onboarding__card">
          <h1>{t("onboarding.finishedTitle")}</h1>
          <p>{t("onboarding.finishedDescription")}</p>
          {summary && !restoreSummary && summary.skipped ? (
            <p className="sh-onboarding__message">{t("onboarding.summary.initSkipped")}</p>
          ) : null}
          {summary && !restoreSummary && !summary.skipped ? (
            <div className="sh-onboarding__scan-stats">
              {targets !== null ? (
                <span>
                  {t("onboarding.summary.targets", { count: targets.length, selected: selectedTargetIds.length })}
                </span>
              ) : null}
              {scanResult ? (
                <>
                  <span>{t("onboarding.summary.scanRoots", { count: scanResult.roots.length })}</span>
                  <span>{t("onboarding.summary.discovered", { count: scanResult.discovered.length })}</span>
                  <span>
                    {t("onboarding.summary.skipped", {
                      count: scanResult.unchanged_count + scanResult.errors.length,
                    })}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
          {summary && !restoreSummary && !summary.skipped && !scanResult ? (
            <p className="sh-onboarding__message">
              {scanState?.kind === "in_progress"
                ? t("onboarding.summary.scanInProgress")
                : t("onboarding.summary.scanSkipped")}
            </p>
          ) : null}
          {onOpenImport && scannedRoots.length > 0 ? (
            <Button onClick={() => onOpenImport(scannedRoots)} variant="secondary">
              {t("onboarding.summary.openImport")}
            </Button>
          ) : null}
          <Button onClick={() => onComplete?.()}>{t("onboarding.summary.enterApp")}</Button>
        </section>
      </main>
    );
  }

  if (branch === null) {
    return (
      <main className="sh-onboarding">
        <div className="sh-onboarding__frame">
          <header className="sh-onboarding__header">
            <p>{t("onboarding.eyebrow")}</p>
          </header>
          <BranchSelection onSelect={(selected) => { setBranch(selected); setStep(0); }} />
        </div>
      </main>
    );
  }

  if (branch === "restore") {
    return (
      <main className="sh-onboarding">
        <div className="sh-onboarding__frame">
          <header className="sh-onboarding__header">
            <p>{t("onboarding.eyebrow")}</p>
          </header>
          <RestoreStep
            operations={operations}
            onBack={() => setBranch(null)}
            onComplete={() => void complete(false)}
          />
        </div>
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
          ) : initialBranch === "select" ? (
            <Button onClick={() => setBranch(null)} variant="secondary">
              {t("onboarding.back")}
            </Button>
          ) : null}
          {step < 2 ? (
            <Button
              disabled={!canContinue || (step === 0 && completionState === "pending")}
              onClick={() => (step === 0 ? continueFromLibraryStep() : setStep((current) => current + 1))}
            >
              {step === 0 && customLibraryPath ? t("onboarding.applyCustomRoot") : t("onboarding.continue")}
            </Button>
          ) : (
            <>
              <Button
                disabled={completionState !== "idle" || !nativeLibraryPath}
                onClick={() => void complete(false)}
              >
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
