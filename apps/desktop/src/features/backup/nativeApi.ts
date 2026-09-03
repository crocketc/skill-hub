import { executeCommand } from "../../api/bindings";
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
};
