import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { nativeOperationFacade } from "./nativeApi";

vi.mock("../../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/bindings")>();
  return { ...original, executeCommand: vi.fn(), queryApplication: vi.fn() };
});

beforeEach(() => { vi.mocked(queryApplication).mockReset(); vi.mocked(executeCommand).mockReset(); });

it("loads an old operation by its id even when it is outside the recent-operation window", async () => {
  const oldestOperationId = "op-oldest-of-238";
  vi.mocked(queryApplication).mockResolvedValue({ type: "operation_details", payload: {
    operation_id: oldestOperationId,
    kind: "import_skill",
    phase: "needs_recovery",
    progress: { operation_id: oldestOperationId, phase: "needs_recovery", completed: 17, total: 238, message_code: "operation.import_skill.failed" },
    error_code: "operation.conflict",
    created_at: "1789890340",
    object_name: "Older skill",
    targets: [],
  } } as never);

  await expect(nativeOperationFacade.get(oldestOperationId)).resolves.toMatchObject({
    operationId: oldestOperationId,
    phase: "needs_recovery",
    completed: 17,
    total: 238,
    message: "operation.conflict",
    kind: "import_skill",
    objectName: "Older skill",
    createdAt: "1789890340",
  });
  expect(queryApplication).toHaveBeenCalledWith({
    type: "get_operation_details",
    payload: { operation_id: oldestOperationId },
  });
});

it("lists the recovery candidates the backend reports", async () => {
  vi.mocked(queryApplication).mockResolvedValue({ type: "recovery_candidates", payload: [
    { operation_id: "op-1", actions: ["complete_operation", "rollback_operation"] },
  ] } as never);

  await expect(nativeOperationFacade.listRecoveryCandidates()).resolves.toEqual([
    { operationId: "op-1", actions: ["complete_operation", "rollback_operation"] },
  ]);
});

it("lists only the native API's replaced-content backup records", async () => {
  vi.mocked(queryApplication).mockResolvedValue({ type: "deployment_conflict_backups", payload: [
    { backup_id: "opaque-1", target_label: "Agent target", entry_name: "my-skill", entry_kind: "directory" },
  ] } as never);

  await expect(nativeOperationFacade.listDeploymentConflictBackups()).resolves.toEqual([
    { backup_id: "opaque-1", target_label: "Agent target", entry_name: "my-skill", entry_kind: "directory" },
  ]);
  expect(queryApplication).toHaveBeenCalledWith({ type: "list_deployment_conflict_backups" });
});

it("restores a replaced-content backup through the dedicated command", async () => {
  vi.mocked(executeCommand).mockResolvedValue({ type: "operation_summary", payload: {} as never });

  await nativeOperationFacade.restoreDeploymentConflictBackup("opaque-1");

  expect(executeCommand).toHaveBeenCalledWith({
    type: "restore_deployment_conflict_backup",
    payload: { backup_id: "opaque-1" },
  });
});

/**
 * 恢复必须走 `resolve_recovery`：`acknowledge_recovery` 在应用层没有实现分支，
 * 用它换来的只是 `internal.error`，恢复页会永远停在闸门里。
 */
it("resolves a recovery operation by rolling it back", async () => {
  vi.mocked(queryApplication).mockResolvedValue({ type: "recovery_candidates", payload: [
    { operation_id: "op-1", actions: ["complete_operation", "rollback_operation"] },
  ] } as never);
  vi.mocked(executeCommand).mockResolvedValue({ type: "operation_summary", payload: {} as never });

  await nativeOperationFacade.resolveRecovery("op-1", "rollback_operation");

  expect(executeCommand).toHaveBeenCalledWith({ type: "resolve_recovery", payload: { operation_id: "op-1", action: "rollback_operation" } });
});

it("does not resolve an unknown recovery operation", async () => {
  vi.mocked(queryApplication).mockResolvedValue({ type: "recovery_candidates", payload: [] } as never);
  await expect(nativeOperationFacade.resolveRecovery("unknown", "rollback_operation")).rejects.toThrow("recovery operation was not found");
  expect(executeCommand).not.toHaveBeenCalled();
});

it("refuses an action the candidate never declared", async () => {
  vi.mocked(queryApplication).mockResolvedValue({ type: "recovery_candidates", payload: [
    { operation_id: "op-1", actions: ["rollback_operation"] },
  ] } as never);
  await expect(nativeOperationFacade.resolveRecovery("op-1", "complete_operation")).rejects.toThrow("recovery operation was not found");
  expect(executeCommand).not.toHaveBeenCalled();
});
