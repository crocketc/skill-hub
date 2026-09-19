import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { nativeOperationFacade } from "./nativeApi";

vi.mock("../../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/bindings")>();
  return { ...original, executeCommand: vi.fn(), queryApplication: vi.fn() };
});

beforeEach(() => { vi.mocked(queryApplication).mockReset(); vi.mocked(executeCommand).mockReset(); });

it("reads an operation state from the native bootstrap projection", async () => {
  vi.mocked(queryApplication).mockResolvedValue({ type: "bootstrap_snapshot", payload: {
    recent_operations: [{ operation_id: "op-1", kind: "import", state: "committed", phase: "committed", error_code: null, created_at: "now" }],
  } as never });
  await expect(nativeOperationFacade.get("op-1")).resolves.toMatchObject({ operationId: "op-1", phase: "committed", total: 1 });
});

it("lists the recovery candidates the backend reports", async () => {
  vi.mocked(queryApplication).mockResolvedValue({ type: "recovery_candidates", payload: [
    { operation_id: "op-1", actions: ["complete_operation", "rollback_operation"] },
  ] } as never);

  await expect(nativeOperationFacade.listRecoveryCandidates()).resolves.toEqual([
    { operationId: "op-1", actions: ["complete_operation", "rollback_operation"] },
  ]);
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
