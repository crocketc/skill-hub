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

it("acknowledges only the requested recovery operation", async () => {
  vi.mocked(queryApplication).mockResolvedValue({ type: "recovery_candidates", payload: [{ operation_id: "op-1", actions: ["acknowledge"] }] });
  vi.mocked(executeCommand).mockResolvedValue({ type: "operation_summary", payload: {} as never });
  await nativeOperationFacade.acknowledgeRecovery("op-1");
  expect(executeCommand).toHaveBeenCalledWith({ type: "acknowledge_recovery", payload: { operation_id: "op-1" } });
});

it("does not acknowledge an unknown recovery operation", async () => {
  vi.mocked(queryApplication).mockResolvedValue({ type: "recovery_candidates", payload: [] });
  await expect(nativeOperationFacade.acknowledgeRecovery("unknown")).rejects.toThrow("recovery operation was not found");
  expect(executeCommand).not.toHaveBeenCalled();
});
