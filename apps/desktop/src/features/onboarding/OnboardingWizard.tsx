import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DataState } from "../../ui/DataState";
import {
  beginBackgroundScan,
  resetBackgroundScan,
} from "../bootstrap/backgroundScan";
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
import { WizardShell, type WizardStep } from "./WizardShell";
import type { ThemeName } from "../../styles/theme";

interface OnboardingWizardProps {
  /** Display-level knob so previews can reach the slow-scan branch deterministically. */
  scanSlowAfterMs?: number;
  initialBranch?: "create" | "select" | "restore";
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
  scanSlowAfterMs = 10_000,
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
    initialBranch === "select" ? null : initialBranch === "restore" ? "restore" : "create",
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
  const [libraryActivated, setLibraryActivated] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nativeLibraryPath, setNativeLibraryPath] = useState(libraryPath);
  const [customLibraryPath, setCustomLibraryPath] = useState<string | null>(null);
  // M-31：后台扫描的真实句柄。转入后台后向导可能立即退出，promise 由
  // bootstrap/backgroundScan 的模块级监控器持有并观察其真实结果。
  const scanHandleRef = useRef<Promise<InitializationScanState> | null>(null);
  const handedOffRef = useRef(false);
  const scanSettledRef = useRef(true);
  const mountedRef = useRef(true);
  const finishedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
    setError(null);
    try {
      const result = await operations.discoverAgents();
      setTargets(result.targets);
      setSelectedTargetIds([]);
      setSelectionConfirmed(false);
    } catch (caught) {
      setError(describe(caught));
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
    setError(null);
    handedOffRef.current = false;
    scanSettledRef.current = false;
    const attempt = runtime.runInitializationScan(selectedTargetIds);
    scanHandleRef.current = attempt;
    try {
      const result = await attempt;
      scanSettledRef.current = true;
      if (!mountedRef.current || finishedRef.current) {
        // 向导已退出或已按后台方式提交初始化：结果由持同一 promise 的
        // 后台监控器记录并触发全局通知。
        return;
      }
      // 结果回到向导展示：撤销监控器，避免全局通知与页面结果重复。
      resetBackgroundScan();
      if (handedOffRef.current) {
        setScanInBackground(false);
      }
      setScanState(result);
      setMessage(
        result.kind === "completed"
          ? t("onboarding.scanComplete")
          : t("onboarding.scanStarted"),
      );
    } catch (caught) {
      scanSettledRef.current = true;
      const code = nativeErrorCode(caught);
      console.error("initialization_scan_failed", code ?? "unknown");
      if (!mountedRef.current || finishedRef.current) {
        // 失败由后台监控器上报为全局通知（含重试入口），绝不静默。
        return;
      }
      resetBackgroundScan();
      if (handedOffRef.current) {
        setScanInBackground(false);
      }
      setError(code ? t("onboarding.scanFailedWithCode", { code }) : t("onboarding.scanFailedWithoutCode"));
    } finally {
      if (mountedRef.current) {
        setIsScanning(false);
      }
    }
  };

  useEffect(() => {
    if (!isScanning || scanInBackground) return;
    const timer = window.setTimeout(() => setScanSlow(true), scanSlowAfterMs);
    return () => window.clearTimeout(timer);
  }, [isScanning, scanInBackground, scanSlowAfterMs]);

  // Completion stays on the summary page unless the scan was handed off: a
  // handed-off scan keeps running in the native facade after the wizard is
  // gone, so finishing must admit the user to the app immediately (M-31).
  const complete = async (skipped: boolean) => {
    if (!nativeLibraryPath || completionState !== "idle") {
      return;
    }
    setCompletionState("pending");
    setMessage(null);
    setError(null);
    try {
      if (branch !== "restore" && operations.activateLibraryRoot && !libraryActivated) {
        await operations.activateLibraryRoot(
          nativeLibraryPath,
          branch === "existing" ? "existing" : "create",
        );
        setLibraryActivated(true);
      }
      await operations.completeOnboarding({ libraryPath: nativeLibraryPath, skipped });
      setCompletionSnapshot({ branch: branch ?? "create", skipped });
      if (scanInBackground) {
        // 后台扫描仍在真实运行：立即退出向导进入概览（M-31），扫描结果
        // 由监控器观察并通过全局通知反馈。
        finishedRef.current = true;
        onComplete?.();
        return;
      }
      // 前台完成后仍有扫描在跑：交给监控器，退出向导后依旧可观察、不静默。
      if (scanHandleRef.current && !scanSettledRef.current && !handedOffRef.current) {
        beginBackgroundScan(scanHandleRef.current, selectedTargetIds);
      }
      setCompletionState("complete");
    } catch (caught) {
      setCompletionState("idle");
      setError(describe(caught));
    }
  };

  const pickCustomDirectory = async () => {
    setMessage(null);
    setError(null);
    try {
      const path = await operations.pickDirectory?.();
      if (path) setCustomLibraryPath(path);
    } catch (caught) {
      setError(describe(caught));
    }
  };

  const continueFromLibraryStep = () => {
    const selectedPath = customLibraryPath ?? nativeLibraryPath;
    if (!selectedPath || completionState !== "idle") return;
    setNativeLibraryPath(selectedPath);
    setStep(1);
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
        onContinueInBackground={scanSlow && scanHandleRef.current ? () => {
          const handle = scanHandleRef.current;
          if (!handle) {
            return;
          }
          handedOffRef.current = true;
          // 真实 IPC promise 交给模块级监控器：向导退出后扫描结果仍可观察。
          beginBackgroundScan(handle, selectedTargetIds);
          setScanInBackground(true);
          setIsScanning(false);
          setMessage(t("onboarding.scanBackground"));
        } : undefined}
        scanInBackground={scanInBackground}
        scanResult={scanState?.kind === "completed" ? scanState.result : undefined}
      />
    );

  const initializationSteps = (current: number): WizardStep[] => [
    {
      label: t("onboarding.libraryTitle"),
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
              {scanState?.kind === "in_progress" || scanInBackground
                ? t("onboarding.summary.scanInProgress")
                : t("onboarding.summary.scanSkipped")}
            </p>
          ) : null}
          {onOpenImport && scannedRoots.length > 0 ? (
            <Button onClick={() => onOpenImport(scannedRoots)} variant="secondary">
              {t("onboarding.summary.openImport")}
            </Button>
          ) : null}
          <Button onClick={() => onComplete?.()} size="lg">{t("onboarding.summary.enterApp")}</Button>
        </section>
      </main>
    );
  }

  if (branch === null) {
    return (
      <WizardShell
        eyebrow={t("onboarding.eyebrow")}
        steps={initializationSteps(0).map((branchStep) => ({ ...branchStep, state: "upcoming" as const }))}
        stepsLabel={t("onboarding.stepsLabel")}
      >
        <BranchSelection onSelect={(selected) => { setBranch(selected); setStep(0); }} />
      </WizardShell>
    );
  }

  if (branch === "restore") {
    return (
      <WizardShell
        eyebrow={t("onboarding.eyebrow")}
        steps={[{ label: t("onboarding.restoreTitle"), state: "current" }]}
        stepsLabel={t("onboarding.stepsLabel")}
      >
        <RestoreStep
          operations={operations}
          libraryPath={nativeLibraryPath}
          onBack={() => setBranch(null)}
          onComplete={() => void complete(false)}
        />
      </WizardShell>
    );
  }

  const footer = (
    <>
      <div className="sh-onboarding__actions-group">
        {step > 0 ? (
          <Button onClick={() => setStep((current) => current - 1)} variant="secondary">
            {t("onboarding.back")}
          </Button>
        ) : initialBranch === "select" ? (
          <Button onClick={() => setBranch(null)} variant="secondary">
            {t("onboarding.back")}
          </Button>
        ) : null}
      </div>
      <div className="sh-onboarding__actions-group sh-onboarding__actions-group--primary">
        {step < 2 ? (
          <Button
            disabled={!canContinue || (step === 0 && completionState === "pending")}
            onClick={() => (step === 0 ? continueFromLibraryStep() : setStep((current) => current + 1))}
            size="lg"
          >
            {t("onboarding.continue")}
          </Button>
        ) : (
          <>
            <Button
              disabled={completionState !== "idle" || !nativeLibraryPath}
              onClick={() => void complete(false)}
              size="lg"
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
      </div>
    </>
  );

  return (
    <WizardShell
      eyebrow={t("onboarding.eyebrow")}
      footer={footer}
      steps={initializationSteps(step)}
      stepsLabel={t("onboarding.stepsLabel")}
      status={message ? { kind: "info", text: message } : null}
    >
      {activeStep}
      {scanState?.kind === "in_progress" ? (
        <p className="sh-onboarding__message">
          <code>{scanState.operationId}</code>
          {` · ${scanState.phase}`}
        </p>
      ) : null}
      {error ? <DataState message={error} state="error" /> : null}
    </WizardShell>
  );
}
