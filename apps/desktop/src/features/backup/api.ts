import type {
  BackupCreated,
  BackupDecision,
  BackupPlan,
  BackupScope,
  ExportInput,
  ExportResult,
  RestoreDecision,
  RestorePlan,
  RestoreResult,
} from "../../api/bindings";

export interface BackupFacade {
  prepareBackup(scope: BackupScope): Promise<BackupPlan>;
  createBackup(scope: BackupScope, decisions: BackupDecision[]): Promise<BackupCreated>;
  verifyBackup(path: string): Promise<void>;
  prepareRestore(path: string): Promise<RestorePlan>;
  commitRestore(path: string, decisions: RestoreDecision[]): Promise<RestoreResult>;
  prepareExport(input: ExportInput): Promise<unknown>;
  createExport(input: ExportInput, decisions: unknown[]): Promise<ExportResult>;
}
