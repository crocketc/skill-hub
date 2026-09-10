import { useMemo } from "react";
import { RecoveryPage } from "./RecoveryPage";
import type { OperationFacade, OperationPhase } from "../operations/api";
import type { RecentOperationRow, RecentOperationsReader } from "../operations/api";

const RECENT: RecentOperationRow[] = [
  {
    operation_id: "op-deploy-9",
    kind: "deployment",
    state: "failed",
    phase: "needs_recovery",
    error_code: "deployment.target_conflict",
    created_at: "2026-09-06T07:00:00Z",
  },
  {
    operation_id: "op-import-1",
    kind: "import",
    state: "committed",
    phase: "committed",
    error_code: null,
    created_at: "2026-09-08T08:01:00Z",
  },
];

function previewFlag(name: string): boolean {
  return new URLSearchParams(window.location.search).get(name) === "1";
}

function previewPhase(): OperationPhase {
  const raw = new URLSearchParams(window.location.search).get("phase");
  return raw === "rolled_back" ? "rolled_back" : "needs_recovery";
}

/**
 * DEV-only preview for /__preview/recovery.
 * Query knobs: ?phase=rolled_back and ?error=1 for the unavailable state.
 */
export function RecoveryPreview() {
  const facade = useMemo<OperationFacade>(() => ({
    get: async () => ({
      operationId: "op-deploy-9",
      phase: previewPhase(),
      completed: 0,
      total: 1,
      message: "deployment.target_conflict",
    }),
    acknowledgeRecovery: async () => undefined,
  }), []);
  const recent = useMemo<RecentOperationsReader>(() => (
    previewFlag("error")
      ? { listRecentOperations: () => Promise.reject(new Error("native bridge unavailable in preview")) }
      : { listRecentOperations: () => Promise.resolve(RECENT satisfies RecentOperationRow[]) }
  ), []);
  return <RecoveryPage facade={facade} recent={recent} />;
}
