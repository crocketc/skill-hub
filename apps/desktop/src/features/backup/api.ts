import type {
  BackupCreated,
  BackupDecision,
  BackupPlan,
  BackupScope,
  DeploymentId,
  DeploymentRecord,
  ExportDecision,
  ExportInput,
  ExportPreview,
  ExportResult,
  OperationId,
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
  /**
   * K3 预览绑定（§2 三件套）：prepare 返回 ExportPreview（preview_id +
   * expires_at + confirmation_fingerprint + 扫描结果）。
   */
  prepareExport(input: ExportInput): Promise<ExportPreview>;
  /**
   * K3：create 只收预览 id 与用户敏感决定；实际输入由后端从预览快照
   * 重新物化并重验指纹，不再接受可篡改的完整 input。
   */
  createExport(previewId: OperationId, decisions: ExportDecision[]): Promise<ExportResult>;
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
