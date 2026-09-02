import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";
import type { BootstrapSnapshot, StartupRecoveryState } from "../../api/bindings";
import { AppShell } from "../../app/AppShell";
import {
  type BootstrapVerificationState,
  desktopBootstrapRuntime,
  type BootstrapRuntime,
} from "./api";

interface BootstrapGateProps {
  runtime?: BootstrapRuntime;
}

type BootstrapLoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      snapshot: BootstrapSnapshot;
      verification: BootstrapVerificationState;
    }
  | { kind: "error" };

function RecoveryBlocker({ recoveryState }: { recoveryState: StartupRecoveryState }) {
  const { t } = useTranslation();
  const isRecovering = recoveryState === "in_progress";

  return (
    <main className="sh-startup-blocker">
      <section
        aria-live="assertive"
        className="sh-startup-blocker__card"
        role={isRecovering ? undefined : "alert"}
      >
        <h1>{t(isRecovering ? "bootstrap.recoveryInProgressTitle" : "bootstrap.recoveryTitle")}</h1>
        <p>{t(isRecovering ? "bootstrap.recoveryInProgressDescription" : "bootstrap.recoveryDescription")}</p>
        {isRecovering ? (
          <div aria-label={t("bootstrap.blockingStartup")} role="progressbar" />
        ) : null}
        <a href="/operations">{t("bootstrap.openRecovery")}</a>
      </section>
    </main>
  );
}

function LoadingState() {
  const { t } = useTranslation();
  return <main className="sh-startup-loading">{t("dataState.loading")}</main>;
}

function ErrorState({ retry }: { retry: () => void }) {
  const { t } = useTranslation();
  return (
    <main className="sh-startup-loading">
      <p>{t("dataState.error")}</p>
      <button onClick={retry} type="button">
        {t("actions.retry")}
      </button>
    </main>
  );
}

export function BootstrapGate({ runtime = desktopBootstrapRuntime }: BootstrapGateProps) {
  const [state, setState] = useState<BootstrapLoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const view = await runtime.getBootstrapView();
      setState({
        kind: "ready",
        snapshot: view.snapshot,
        verification: view.verification,
      });
    } catch {
      setState({ kind: "error" });
    }
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") {
    return <LoadingState />;
  }
  if (state.kind === "error") {
    return <ErrorState retry={() => void load()} />;
  }
  if (state.snapshot.recovery_state !== "clean") {
    return <RecoveryBlocker recoveryState={state.snapshot.recovery_state} />;
  }
  if (state.snapshot.initialization_state === "not_initialized") {
    return <Navigate replace to="/initialize" />;
  }

  return <AppShell snapshot={state.snapshot} verification={state.verification} />;
}
