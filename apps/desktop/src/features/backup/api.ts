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

  BackupRetentionResult,
} from "../../api/bindings";

export interface BackupFacade {
  /** N11：当前集中库根路径（来自引导快照）。 */
  libraryPath?: () => Promise<string>;
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
  /** 滚动备份：按保留策略创建备份并清理超量历史。 */
  runRollingBackup?(input: {
    scope: BackupScope;
    retention: { max_backups: number };
    decisions: BackupDecision[];
  }): Promise<BackupRetentionResult>;
}
export type BackupRetentionOutcome = BackupRetentionResult;
