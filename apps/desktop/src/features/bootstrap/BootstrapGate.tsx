import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useLocation } from "react-router-dom";
import type { BootstrapSnapshot, StartupRecoveryState } from "../../api/bindings";
import { AppShell } from "../../app/AppShell";
import { DataState } from "../../ui/DataState";
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
        <Link to="/recovery">{t("bootstrap.openRecovery")}</Link>
      </section>
    </main>
  );
}

function LoadingState() {
  const { t } = useTranslation();
  return (
    <main className="sh-startup-loading">
      <DataState message={t("dataState.loading")} state="loading" />
    </main>
  );
}

function ErrorState({ retry }: { retry: () => void }) {
  const { t } = useTranslation();
  return (
    <main className="sh-startup-loading">
      <DataState
        actionLabel={t("actions.retry")}
        message={t("dataState.error")}
        onAction={retry}
        state="error"
      />
    </main>
  );
}

export function BootstrapGate({ runtime = desktopBootstrapRuntime }: BootstrapGateProps) {
  const [state, setState] = useState<BootstrapLoadState>({ kind: "loading" });
  const location = useLocation();

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setState({ kind: "loading" });
    try {
      const view = await runtime.getBootstrapView();
      setState({
        kind: "ready",
        snapshot: view.snapshot,
        verification: view.verification,
      });
    } catch {
      if (showLoading) setState({ kind: "error" });
    }
  }, [runtime]);

  useEffect(() => {
    void load(true);
  }, [load]);

  if (state.kind === "loading") {
    return <LoadingState />;
  }
  if (state.kind === "error") {
    return <ErrorState retry={() => void load(true)} />;
  }
  if (state.snapshot.recovery_state !== "clean" && location.pathname !== "/recovery") {
    return <RecoveryBlocker recoveryState={state.snapshot.recovery_state} />;
  }
  if (state.snapshot.initialization_state === "not_initialized") {
    return <Navigate replace to="/initialize" />;
  }

  return (
    <AppShell
      refreshSnapshot={() => load(false)}
      snapshot={state.snapshot}
      verification={state.verification}
    />
  );
}
