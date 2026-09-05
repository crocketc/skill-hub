import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { nativeBackupFacade } from "./nativeApi";

vi.mock("../../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/bindings")>();
  return { ...original, executeCommand: vi.fn(), queryApplication: vi.fn() };
});

beforeEach(() => {
  vi.mocked(executeCommand).mockReset();
  vi.mocked(queryApplication).mockReset();
});

it("runs backup preflight and creation through typed commands", async () => {
  vi.mocked(executeCommand)
    .mockResolvedValueOnce({ type: "backup_plan", payload: { scope: "full", sensitive_items: [] } })
    .mockResolvedValueOnce({ type: "backup_created", payload: { path: "C:/backup.skillhub", manifest: { format_version: 1, entries: [], contains_sensitive_skill_content: false } } });
  await nativeBackupFacade.prepareBackup("full");
  await nativeBackupFacade.createBackup("full", []);
  expect(executeCommand).toHaveBeenNthCalledWith(1, { type: "prepare_backup", payload: { scope: "full" } });
  expect(executeCommand).toHaveBeenNthCalledWith(2, { type: "create_backup", payload: { scope: "full", decisions: [] } });
});

it("keeps restore and export as explicit preflight then commit operations", async () => {
  vi.mocked(executeCommand)
    .mockResolvedValueOnce({ type: "restore_plan", payload: { format_version: 1, skills: 1, deployments_requiring_rediscovery: 1, conflicts: [] } })
    .mockResolvedValueOnce({ type: "restore_result", payload: { skills_restored: 1, skills_skipped: 0, deployments_requiring_rediscovery: 1 } })
    .mockResolvedValueOnce({ type: "export_plan", payload: { selection: { skills: ["skill-1"] }, versions: "current", skills: [], sensitive_items: [] } })
    .mockResolvedValueOnce({ type: "export_result", payload: { path: "C:/export", skills_exported: 1 } });
  await nativeBackupFacade.prepareRestore("C:/backup.skillhub");
  await nativeBackupFacade.commitRestore("C:/backup.skillhub", []);
  await nativeBackupFacade.prepareExport({ selection: { skills: ["skill-1"] }, versions: "current", skills: [] });
  await nativeBackupFacade.createExport({ selection: { skills: ["skill-1"] }, versions: "current", skills: [] }, []);
  expect(executeCommand).toHaveBeenNthCalledWith(2, { type: "commit_restore", payload: { path: "C:/backup.skillhub", decisions: [] } });
  expect(executeCommand).toHaveBeenNthCalledWith(4, expect.objectContaining({ type: "create_standard_export" }));
});

it("lists deployments and skill versions through read-only queries", async () => {
  vi.mocked(queryApplication)
    .mockResolvedValueOnce({ type: "deployments", payload: [] })
    .mockResolvedValueOnce({ type: "versions", payload: [] });
  await nativeBackupFacade.listDeployments();
  await nativeBackupFacade.listVersions("skill-1");
  expect(queryApplication).toHaveBeenNthCalledWith(1, { type: "list_deployments", payload: { skill_id: null } });
  expect(queryApplication).toHaveBeenNthCalledWith(2, { type: "list_versions", payload: { skill_id: "skill-1" } });
});

it("previews uninstall impact and applies explicit decisions through typed commands", async () => {
  vi.mocked(executeCommand)
    .mockResolvedValueOnce({ type: "uninstall_impact", payload: { deployments: [], actions: ["undeploy_all"], preserves_central_library: true } })
    .mockResolvedValueOnce({ type: "operation_summary", payload: { operation_id: "op-1", phase: "committed", message_code: "uninstall.decision_applied", error_code: null } });
  const impact = await nativeBackupFacade.prepareUninstall(["dep-1"]);
  const summary = await nativeBackupFacade.applyUninstallDecision(["undeploy_all"]);
  expect(impact).toEqual({ deployments: [], actions: ["undeploy_all"], preserves_central_library: true });
  expect(summary.phase).toBe("committed");
  expect(executeCommand).toHaveBeenNthCalledWith(1, { type: "prepare_uninstall", payload: { deployment_ids: ["dep-1"] } });
  expect(executeCommand).toHaveBeenNthCalledWith(2, { type: "apply_uninstall_decision", payload: { actions: ["undeploy_all"] } });
});
