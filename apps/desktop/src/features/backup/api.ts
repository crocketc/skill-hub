import type {
  BackupCreated,
  BackupDecision,
  BackupPlan,
  BackupScope,
  ExportDecision,
  ExportPlan,
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
  prepareExport(input: ExportInput): Promise<ExportPlan>;
  createExport(input: ExportInput, decisions: ExportDecision[]): Promise<ExportResult>;
}
