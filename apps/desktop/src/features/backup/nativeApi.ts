import { executeCommand, queryApplication } from "../../api/bindings";
import type { BackupFacade } from "./api";

export const nativeBackupFacade: BackupFacade = {
  async prepareBackup(scope) {
    const result = await executeCommand({ type: "prepare_backup", payload: { scope } });
    if (result.type !== "backup_plan") throw new Error("backup preflight returned an unexpected result");
    return result.payload;
  },
  async createBackup(scope, decisions) {
    const result = await executeCommand({ type: "create_backup", payload: { scope, decisions } });
    if (result.type !== "backup_created") throw new Error("backup creation returned an unexpected result");
    return result.payload;
  },
  async verifyBackup(path) {
    const result = await executeCommand({ type: "verify_backup", payload: { path } });
    if (result.type !== "backup_manifest") throw new Error("backup verification returned an unexpected result");
  },
  async prepareRestore(path) {
    const result = await executeCommand({ type: "prepare_restore", payload: { path } });
    if (result.type !== "restore_plan") throw new Error("restore preflight returned an unexpected result");
    return result.payload;
  },
  async commitRestore(path, decisions) {
    const result = await executeCommand({ type: "commit_restore", payload: { path, decisions } });
    if (result.type !== "restore_result") throw new Error("restore returned an unexpected result");
    return result.payload;
  },
  async runRollingBackup(input) {
    const result = await executeCommand({
      type: "run_rolling_backup",
      payload: {
        scope: input.scope,
        retention: input.retention,
        decisions: input.decisions as never,
      },
    });
    if (result.type !== "backup_retention_result") {
      throw new Error("rolling backup returned an unexpected result");
    }
    return result.payload;
  },
  async prepareExport(input) {
    const result = await executeCommand({ type: "prepare_standard_export", payload: { input } });
    if (result.type !== "export_plan") throw new Error("export preflight returned an unexpected result");
    return result.payload;
  },
  async createExport(input, decisions) {
    const result = await executeCommand({ type: "create_standard_export", payload: { input, decisions: decisions as never } });
    if (result.type !== "export_result") throw new Error("export returned an unexpected result");
    return result.payload;
  },
  async libraryPath() {
    const result = await queryApplication({ type: "get_bootstrap_snapshot" });
    if (result.type !== "bootstrap_snapshot") throw new Error("bootstrap snapshot returned an unexpected result");
    return result.payload.library_path;
  },
  async listDeployments() {
    const result = await queryApplication({ type: "list_deployments", payload: { skill_id: null } });
    if (result.type !== "deployments") throw new Error("deployment list returned an unexpected result");
    return result.payload;
  },
  async listVersions(skillId) {
    const result = await queryApplication({ type: "list_versions", payload: { skill_id: skillId } });
    if (result.type !== "versions") throw new Error("version list returned an unexpected result");
    return result.payload;
  },
  async prepareUninstall(deploymentIds) {
    const result = await executeCommand({ type: "prepare_uninstall", payload: { deployment_ids: deploymentIds } });
    if (result.type !== "uninstall_impact") throw new Error("uninstall preflight returned an unexpected result");
    return result.payload;
  },
  async applyUninstallDecision(actions) {
    const result = await executeCommand({ type: "apply_uninstall_decision", payload: { actions } });
    if (result.type !== "operation_summary") throw new Error("uninstall decision returned an unexpected result");
    return result.payload;
  },
};
