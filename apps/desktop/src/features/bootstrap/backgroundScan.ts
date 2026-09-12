import type { ScanResult } from "../../api/bindings";
import type { InitializationScanState } from "./api";

/**
 * Notice shape mirrors the global notification service contract
 * (`useAppNotifications().notify`); the integration wires the hook's `notify`
 * into `BackgroundScanNotifier`, so this module never depends on the shell.
 */
export interface AppNoticeAction {
  label: string;
  to: string;
}

export interface AppNotice {
  tone: "success" | "info" | "warning" | "danger";
  title: string;
  detail?: string;
  action?: AppNoticeAction;
}

export type NotifyFunction = (notice: AppNotice) => string;

export type BackgroundScanStatus = "idle" | "scanning" | "completed" | "failed";

export interface BackgroundScanState {
  status: BackgroundScanStatus;
  /** Monotonic id of the latest begin; lets consumers dedupe reports. */
  token: number;
  scopeIds: string[];
  /** Present once the handed-off scan actually finished with a result. */
  result?: ScanResult;
  error?: unknown;
  /** True once a terminal state was surfaced through a notification. */
  reported: boolean;
}

type Listener = (state: BackgroundScanState) => void;

let state: BackgroundScanState = { status: "idle", token: 0, scopeIds: [], reported: false };
const listeners = new Set<Listener>();

function update(next: BackgroundScanState): void {
  state = next;
  for (const listener of listeners) {
    listener(state);
  }
}

export function getBackgroundScanState(): BackgroundScanState {
  return state;
}

export function subscribeBackgroundScan(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Keeps a handed-off initialization scan observable after the onboarding
 * wizard unmounts. The promise is the real IPC handle: the scan keeps running
 * in the native facade, and this module only records its honest outcome —
 * it never fabricates a completed or failed state on its own.
 */
export function beginBackgroundScan(
  scan: Promise<InitializationScanState>,
  scopeIds: string[],
): void {
  const token = state.token + 1;
  update({ status: "scanning", token, scopeIds, reported: false });
  void scan.then(
    (outcome) => {
      if (state.token !== token) {
        return; // Superseded by a newer scan or reset by the wizard.
      }
      if (outcome.kind === "completed") {
        update({ status: "completed", token, scopeIds, result: outcome.result, reported: false });
        return;
      }
      // The backend acknowledged an async operation instead of a final
      // result; the contract carries no completion signal yet, so the scan
      // stays honestly "scanning" instead of pretending it settled.
    },
    (error: unknown) => {
      if (state.token !== token) {
        return;
      }
      update({ status: "failed", token, scopeIds, error, reported: false });
    },
  );
}

/**
 * The wizard re-adopted the scan outcome on screen (the user stayed on the
 * page), so the app-wide completion notice would duplicate what is already
 * visible. Bumping the token also detaches any pending settlement.
 */
export function resetBackgroundScan(): void {
  update({ status: "idle", token: state.token + 1, scopeIds: [], reported: false });
}

export function markBackgroundScanReported(): void {
  if (state.status === "completed" || state.status === "failed") {
    update({ ...state, reported: true });
  }
}
