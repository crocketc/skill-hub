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
 * Query knobs: ?phase=rolled_back, ?error=1, and ?replaced=1 for the recoverable backup flow.
 */
export function RecoveryPreview() {
  const facade = useMemo<OperationFacade>(() => {
    let detailAttempts = 0;
    let hasReplacedContent = previewFlag("replaced")
      || window.localStorage.getItem("skillhub.preview.replacedBackup") === "1";
    return {
      get: async (operationId) => {
        if (previewFlag("detailError") && detailAttempts++ === 0) {
          throw new Error("native bridge unavailable in preview");
        }
        return {
          operationId,
          phase: previewPhase(),
          completed: 0,
          total: 1,
          message: "deployment.target_conflict",
          kind: "deploy_skill",
          objectName: "Preview skill",
        };
      },
      listRecoveryCandidates: async () => (previewFlag("empty") ? [] : [{
        operationId: "op-deploy-9",
        actions: previewFlag("noActions")
          ? []
          : previewFlag("complete")
            ? ["complete_operation"]
            : ["rollback_operation"],
        kind: "deploy_skill",
        objectName: "Preview skill",
      }]),
      resolveRecovery: async () => undefined,
      listDeploymentConflictBackups: async () => hasReplacedContent ? [{
        backup_id: "preview-backup-1",
        target_label: "Codex global Skills",
        entry_name: "preview-original-skill",
        entry_kind: "directory",
      }] : [],
      restoreDeploymentConflictBackup: async (backupId) => {
        if (backupId !== "preview-backup-1") throw new Error("replaced content was not found in preview");
        hasReplacedContent = false;
        window.localStorage.removeItem("skillhub.preview.replacedBackup");
      },
    };
  }, []);
  const recent = useMemo<RecentOperationsReader>(() => (
    previewFlag("error")
      ? { listRecentOperations: () => Promise.reject(new Error("native bridge unavailable in preview")) }
      : { listRecentOperations: () => Promise.resolve(RECENT satisfies RecentOperationRow[]) }
  ), []);
  return <RecoveryPage facade={facade} recent={recent} />;
}
