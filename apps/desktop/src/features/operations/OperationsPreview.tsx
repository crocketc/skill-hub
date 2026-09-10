import { useMemo } from "react";
import { createOperationTracker, type OperationTracker } from "../../platform/operationTracker";
import { OperationsList } from "./OperationsList";
import { OperationsRecordsPage } from "./OperationsRecordsPage";
import { OperationProgress } from "./OperationProgress";
import type { RecentOperationRow, RecentOperationsReader } from "./api";

/** Deterministic persisted-operation rows; timestamps exercise Intl formatting. */
const ROWS: RecentOperationRow[] = [
  {
    operation_id: "op-import-1",
    kind: "import",
    state: "committed",
    phase: "committed",
    error_code: null,
    created_at: "2026-09-08T08:01:00Z",
  },
  {
    operation_id: "op-deploy-9",
    kind: "deployment",
    state: "failed",
    phase: "needs_recovery",
    error_code: "deployment.target_conflict",
    created_at: "2026-09-06T07:00:00Z",
  },
  {
    operation_id: "op-removal-3",
    kind: "removal",
    state: "rolled_back",
    phase: "rolled_back",
    error_code: null,
    created_at: "2026-09-05T10:30:00Z",
  },
];

function previewFlag(name: string): boolean {
  return new URLSearchParams(window.location.search).get(name) === "1";
}

function previewReader(): RecentOperationsReader {
  if (previewFlag("error")) {
    return {
      listRecentOperations: () => Promise.reject(new Error("native bridge unavailable in preview")),
    };
  }
  return {
    listRecentOperations: () => Promise.resolve(previewFlag("empty") ? [] : ROWS),
  };
}

function previewTracker(): OperationTracker {
  const tracker = createOperationTracker();
  const id = tracker.begin({ kind: "import", label: "Import 3 skills from fixtures", total: 3 });
  tracker.progress(id, 1, 3);
  return tracker;
}

/**
 * DEV-only previews for the operations pages.
 * /__preview/operations-records: query knobs ?empty=1 and ?error=1.
 * /__preview/operation-progress: single committed operation detail.
 */
export function OperationsPreview() {
  const reader = useMemo(previewReader, []);
  // 空态/失败态预览不注入会话操作，保证"尚未有任何操作记录"可真实到达。
  const tracker = useMemo(
    () => (previewFlag("empty") || previewFlag("error") ? createOperationTracker() : previewTracker()),
    [],
  );
  return <OperationsRecordsPage recent={reader} tracker={tracker} />;
}

export function OperationProgressPreview() {
  const reader = useMemo(previewReader, []);
  const facade = useMemo(() => ({
    get: async () => ({
      operationId: "op-import-1",
      phase: "committed" as const,
      completed: 1,
      total: 1,
      message: "import.finished",
    }),
    acknowledgeRecovery: async () => undefined,
  }), []);
  return (
    <div className="sh-workflow-page">
      <OperationProgress facade={facade} operationId="op-import-1" />
      <section aria-label="Recent operations" className="sh-workflow-card">
        <OperationsList recent={reader} />
      </section>
    </div>
  );
}
