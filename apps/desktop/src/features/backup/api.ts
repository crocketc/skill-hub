import type {
  BackupCreated,
  BackupDecision,
  BackupPlan,
  BackupScope,
  DeploymentId,
  DeploymentRecord,
  ExportDecision,
  ExportPlan,
  ExportInput,
  ExportResult,
  OperationSummary,
  RestoreDecision,
  RestorePlan,
  RestoreResult,
  UninstallAction,
  UninstallImpact,
  VersionResult,
} from "../../api/bindings";

export interface BackupFacade {
  prepareBackup(scope: BackupScope): Promise<BackupPlan>;
  createBackup(scope: BackupScope, decisions: BackupDecision[]): Promise<BackupCreated>;
  verifyBackup(path: string): Promise<void>;
  prepareRestore(path: string): Promise<RestorePlan>;
  commitRestore(path: string, decisions: RestoreDecision[]): Promise<RestoreResult>;
  prepareExport(input: ExportInput): Promise<ExportPlan>;
  createExport(input: ExportInput, decisions: ExportDecision[]): Promise<ExportResult>;
  /** All registered deployment relations; used by the uninstall preparation flow. */
  listDeployments(): Promise<DeploymentRecord[]>;
  /** Versions of one skill, used to report whether a carried-over skill is exportable. */
  listVersions(skillId: string): Promise<VersionResult[]>;
  prepareUninstall(deploymentIds: DeploymentId[]): Promise<UninstallImpact>;
  applyUninstallDecision(actions: UninstallAction[]): Promise<OperationSummary>;
}
