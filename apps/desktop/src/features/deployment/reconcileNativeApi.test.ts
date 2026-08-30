import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication, type ReconcilePlan } from "../../api/bindings";
import { nativeReconcileFacade } from "./reconcileNativeApi";

vi.mock("../../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/bindings")>();
  return { ...original, executeCommand: vi.fn(), queryApplication: vi.fn() };
});

beforeEach(() => {
  vi.mocked(queryApplication).mockReset();
  vi.mocked(executeCommand).mockReset();
});

it("loads a typed reconcile plan from the native facade", async () => {
  const plan: ReconcilePlan = {
    deployment_id: "deployment-1",
    state: "modified" as const,
    expected_hash: "sha256:expected",
    observed_hash: "sha256:observed",
    allowed_actions: ["collect_changes", "restore", "keep_independent_copy", "ignore"],
  };
  vi.mocked(queryApplication).mockResolvedValue({ type: "reconcile_plan", payload: plan });

  await expect(nativeReconcileFacade.getPlan("deployment-1")).resolves.toEqual(plan);
  expect(queryApplication).toHaveBeenCalledWith({
    type: "get_reconcile_plan",
    payload: { deployment_id: "deployment-1" },
  });
});

it("submits an explicit reconcile action through its typed command", async () => {
  const result = {
    deployment_id: "deployment-1",
    state_before: "modified" as const,
    action: "ignore" as const,
    version_id: null,
    management_retained: true,
  };
  vi.mocked(executeCommand).mockResolvedValue({ type: "reconcile_result", payload: result });

  await expect(nativeReconcileFacade.apply("deployment-1", "ignore")).resolves.toEqual(result);
  expect(executeCommand).toHaveBeenCalledWith({
    type: "ignore_external_change",
    payload: { deployment_id: "deployment-1" },
  });
});
