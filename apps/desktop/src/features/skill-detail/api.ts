import type { AppliedSourceUpdate, AnalyzeConflictScope, ConflictAnalysis, RelationshipOverview, RemovalImpactFact, SkillUpstreamLineage, SourceUpdatePreview, SourceUpdateStatus, UpdateDecision, UpstreamCheckResult } from "../../api/bindings";
import type {
  BatchAction,
  CheckState,
  InvocationPolicy,
  SkillLibraryQuery,
  SkillLifecycle,
} from "../skills/api";
import { serializeSkillLibrarySearchParams } from "../skills/queryState";

export interface SkillDetailSummary {
  agentDeploymentCount?: number;
  aiCheck: CheckState;
  alias?: string;
  basicCheck: CheckState;
  currentVersion: string;
  /** Immutable identity of the current version used by version-scoped actions. */
  currentVersionId?: string;
  highRiskCount?: number;
  id: string;
  lifecycle: SkillLifecycle;
  name: string;
  pendingCount?: number;
  projectDeploymentCount?: number;
  /** G-16：跟随当前版本的托管链接数（活动关系，后端读模型直传）；未知时缺省。 */
  managedLinkCount?: number;
  /** G-16：独立副本数（活动且未跟随当前版本的副本型关系）；未知时缺省。 */
  independentCopyCount?: number;
  /** P1-12：概览块是全页唯一的用途陈述（头部不再重复）。口径见 nativeApi.summaryOf：
   * 用户用途优先，回退译文、原文。 */
  purpose: string;
  /**
   * K9：集中库可见树根的绝对路径（真实物化目录）；树未物化或未知时缺省。
   * 供 Markdown 工作台打开命令与接管预填写实路径，不派生自显示别名。
   */
  rootPath?: string;
  /**
   * K5：上游“复用修改”谱系；后端未登记或未提供时缺省，界面不渲染谱系块，
   * 绝不伪造来源名称。source_display_name 为 null 时按不可解析如实呈现。
   */
  upstreamLineage?: SkillUpstreamLineage | null;
  trialDue?: string;
  /** Undefined means the upstream source has not been checked in this installation. */
  upgradeAvailable?: boolean;
  upstreamVersion?: string;
}

export interface SkillTranslation {
  locale: string;
  model: string;
  sourceVersion: string;
  stale: boolean;
  text: string;
  translatedAt: string;
  userRevised: boolean;
}

export interface SkillMetadata {
  alias?: string;
  author?: string;
  copyright?: string;
  /** Read-only invocation fact; SkillHub does not edit Agent call switches. */
  invocationPolicy?: InvocationPolicy;
  /** Legacy fixture compatibility; command text is not rendered as a field. */
  invocation?: string;
  license?: string;
  note?: string;
  originalDescription?: string;
  ownership?: string;
  purpose: string;
  source?: string;
  tags: string[];
  translation?: SkillTranslation;
}

export interface SkillMetadataPatch {
  alias?: string | null;
  note?: string | null;
  purpose?: string;
  tags?: string[];
  translationText?: string | null;
}

export interface SkillRelation {
  affectedByCurrentVersion: boolean;
  id: string;
  kind: "agent" | "project";
  label: string;
  logicalTarget: string;
  physicalTarget: string;
  pinned: boolean;
  version: string;
  agentClientId?: string;
  agentProfileId?: string;
  sharedDirectory?: boolean;
}

/** OPT-20260914-08：导入存证的展示形态（导入那一刻的不可变事实）。 */
export interface SkillImportProvenance {
  agentClientId: string | null;
  originalPath: string;
  ownership: string;
  sourceKind: string;
  sourceLocator: string;
  contentFingerprint: string;
  importedAt: string;
}

/** OPT-20260914-08：已观察部署关系的展示形态。 */
export interface SkillObservedDeployment {
  id: string;
  clientId: string;
  originalPath: string;
  contentFingerprint: string;
  matchState: "content_verified" | "name_only" | "diverged";
  origin: "scan" | "import";
  status: "active" | "released";
  observedAt: string;
  releasedAt: string | null;
}

/** 导入存证 + 已观察关系的联合视图；provenance 为 null 表示非导入链路。 */
export interface SkillProvenance {
  provenance: SkillImportProvenance | null;
  observedDeployments: SkillObservedDeployment[];
}

export interface SkillRequirementFact {
  declaration: string;
  id: string;
  name: string;
  verification: "declared_only" | "unavailable";
}

/** G-18：组合事实——组合名与其他成员的展示标签（读模型直传，不裸露 SkillId 之外的标识）。 */
export interface SkillInsightCombinationFact {
  name: string;
  otherMemberLabels: string[];
}

/** G-18：依赖事实——活动关系的稳定形态与路径；id 仅用于列表 key，不进入文案。 */
export interface SkillInsightDependencyFact {
  agentClientId: string | null;
  id: string;
  path: string;
  shapeLabel: string;
}

/** G-18：外部变化事实——关系内容与集中库分叉等状态的可读标签。 */
export interface SkillInsightExternalChangeFact {
  id: string;
  path: string;
  stateLabel: string;
}

export interface SkillDetailInsights {
  combinations: SkillInsightCombinationFact[];
  dependencies: SkillInsightDependencyFact[];
  deterministicDuplicates: string[];
  externalChanges: SkillInsightExternalChangeFact[];
  operationHistory: Array<{ at?: string; id: string; label: string }>;
  /** Stable code explaining why the history is not skill-scoped, if any. */
  operationHistoryLimitation?: string;
  usageEvidence?: { invocationCount: number; lastUsedAt?: string };
}

/** One FTS/BM25 candidate handed to the semantic duplicate analysis. */
export interface SemanticDuplicateCandidate {
  basicCheckState: string;
  description: string;
  id: string;
  locallyModified: boolean;
  name: string;
  permissions: string[];
  source: string;
  trigger: string;
}

export interface SemanticDuplicateRelation {
  coverage: "a_contains_b" | "b_contains_a" | "overlap" | "independent" | "uncertain";
  recommendation:
    | "keep_a"
    | "keep_b"
    | "keep_both"
    | "archive_a"
    | "archive_b"
    | "manual_decision";
  sharedAbilities: string[];
  skillA: string;
  skillB: string;
  uniqueA: string[];
  uniqueB: string[];
}

/** Result of the optional AI layer over deterministic duplicate candidates.
 * `deterministic_only` means the LLM layer failed or was unnecessary; the
 * deterministic candidates are still shown and the failure code is displayed. */
export interface SemanticDuplicateReport {
  candidates: SemanticDuplicateCandidate[];
  failureCode?: string | null;
  source: "deterministic_only" | "llm";
}

export interface SkillVersionEntry {
  basicCheck?: CheckState;
  changes: { added: number; changed: number; removed: number };
  /** 捕获时间（已本地化的可读字符串）；时间未知时为空串（诚实缺省）。 */
  createdAt: string;
  /** Unix 秒的十进制字符串（原生契约直传），用于前端格式化。 */
  createdAtEpoch?: string | null;
  current: boolean;
  id: string;
  /** 用户可读标签：用户命名优先，其次 vN 序号，最后短哈希。 */
  label: string;
  /** 用户显式命名的版本名（AR-021）；未命名时为空。 */
  userLabel?: string;
  origin?: "edit" | "import" | "rollback" | "upstream";
  sequence?: number | null;
}

export interface SkillVersionDiff {
  added: string[];
  changed: string[];
  leftVersionId: string;
  removed: string[];
  rightVersionId: string;
}

export interface RollbackDeploymentImpact {
  affected: boolean;
  id: string;
  label: string;
  pinned: boolean;
  version: string;
}

export interface SkillRollbackImpact {
  deployments: RollbackDeploymentImpact[];
  rerunsBasicCheck: true;
  targetVersionId: string;
}

export interface AdjacentSkillContext {
  next?: { id: string; name: string };
  position: number;
  previous?: { id: string; name: string };
  total: number;
}

export type SkillDetailIntent =
  | { action: BatchAction; skillId: string; type: "batch" }
  | { skillId: string; type: "abandon_trial" }
  | {
      locale: string;
      overwriteUserRevision: boolean;
      skillId: string;
      type: "translate_description";
    };

/** G-15：重新关联的来源输入——kind 是用户显式选择的，不从前端猜。 */
export interface SourceRelinkInput {
  kind: "local" | "https" | "git";
  value: string;
}

export interface SkillDetailFacade {
  commitRollback(
    skillId: string,
    versionId: string,
  ): Promise<{ newVersionId: string }>;
  /** AR-021：为版本设置用户可读名称。 */
  setVersionLabel(skillId: string, versionId: string, label: string): Promise<void>;
  emitIntent(intent: SkillDetailIntent): Promise<{ text: string } | void>;
  getAdjacentContext(
    skillId: string,
    query: SkillLibraryQuery,
  ): Promise<AdjacentSkillContext>;
  getInsights(skillId: string): Promise<SkillDetailInsights>;
  getMetadata(skillId: string): Promise<SkillMetadata>;
  getRelations(skillId: string): Promise<SkillRelation[]>;
  /** OPT-20260914-08：读取导入存证与已观察部署关系（纯查询）。 */
  getProvenance(skillId: string): Promise<SkillProvenance>;
  /** Task 7：Skill 维度的统一关系概览（多来源、冲突、待办）。 */
  getRelationshipOverview(skillId: string): Promise<RelationshipOverview>;
  /** Task 7：按关系读取移除影响（既有 RemovalImpact 契约，只读）。 */
  getRelationshipRemovalImpact(relationId: string): Promise<RemovalImpactFact>;
  getRequirements(skillId: string): Promise<SkillRequirementFact[]>;
  getRollbackImpact(
    skillId: string,
    versionId: string,
  ): Promise<SkillRollbackImpact>;
  getSummary(skillId: string): Promise<SkillDetailSummary>;
  getVersionDiff(
    skillId: string,
    leftVersionId: string,
    rightVersionId: string,
  ): Promise<SkillVersionDiff>;
  getVersions(skillId: string): Promise<SkillVersionEntry[]>;
  saveMetadata(skillId: string, patch: SkillMetadataPatch): Promise<void>;
  setTrial(skillId: string, due: string | null): Promise<void>;
  checkSourceUpdate(skillId: string): Promise<UpstreamCheckResult>;
  /**
   * K6 预览绑定流：采纳入口先取得候选预览（preview_id + 文件级变化），
   * 用户确认后经 commitSourceUpdate 消耗预览；直接采纳命令已移除。
   */
  prepareSourceUpdate(skillId: string): Promise<SourceUpdatePreview>;
  /** K6：提交用户决定；过期/漂移由后端拒绝并要求重新预览。 */
  commitSourceUpdate(
    previewId: string,
    decision: UpdateDecision,
  ): Promise<AppliedSourceUpdate>;
  /** K6/D3：忽略当前候选（按候选身份持久化）；关闭界面不发本命令。 */
  ignoreSourceUpdate(skillId: string, candidateIdentity: string): Promise<void>;
  /** K6：读取持久化的检查/忽略状态；从未检查过时 state 为 null（诚实缺省）。 */
  getSourceUpdateStatus(skillId: string): Promise<SourceUpdateStatus>;
  /** G-15：来源类型由用户显式选择，前端绝不按自由文本猜协议。 */
  relinkSource(
    skillId: string,
    source: SourceRelinkInput,
  ): Promise<{ messageCode: string }>;
  /** Optional AI layer over deterministic duplicate candidates (US-018). */
  analyzeSemanticDuplicates(skillId: string): Promise<SemanticDuplicateReport>;
  /** Task 8：AI 可用性真实信号——已配置并启用的供应商存在即为 true。 */
  isAiAvailable(): Promise<boolean>;
  /** Task 8：Skill 维度的可选冲突分析（advisory，不改变用户裁决）。 */
  analyzeConflicts(scope: AnalyzeConflictScope): Promise<ConflictAnalysis>;
}

const skillKey = (skillId: string) => ["skill-detail", skillId] as const;

export const skillDetailKeys = {
  root: ["skill-detail"] as const,
  skill: skillKey,
  summary: (skillId: string) => [...skillKey(skillId), "summary"] as const,
  metadata: (skillId: string) => [...skillKey(skillId), "metadata"] as const,
  relations: (skillId: string) => [...skillKey(skillId), "relations"] as const,
  /** Task 7：统一关系概览（多来源、部署关系、冲突、待办）。 */
  relationship: (skillId: string) => [...skillKey(skillId), "relationship"] as const,
  provenance: (skillId: string) => [...skillKey(skillId), "provenance"] as const,
  requirements: (skillId: string) =>
    [...skillKey(skillId), "requirements"] as const,
  insights: (skillId: string) => [...skillKey(skillId), "insights"] as const,
  versions: (skillId: string) => [...skillKey(skillId), "versions"] as const,
  /** K6：来源更新检查/忽略状态（get_source_update_status 只读投影）。 */
  sourceUpdateStatus: (skillId: string) =>
    [...skillKey(skillId), "source-update-status"] as const,
  versionDiff: (skillId: string, leftVersionId: string, rightVersionId: string) =>
    [...skillKey(skillId), "version-diff", leftVersionId, rightVersionId] as const,
  rollbackImpact: (skillId: string, versionId: string) =>
    [...skillKey(skillId), "rollback-impact", versionId] as const,
  adjacent: (skillId: string, query: SkillLibraryQuery) =>
    [
      ...skillKey(skillId),
      "adjacent",
      serializeSkillLibrarySearchParams(query).toString(),
    ] as const,
};

export class SkillDetailNotFoundError extends Error {
  constructor(skillId: string) {
    super(`Skill not found: ${skillId}`);
    this.name = "SkillDetailNotFoundError";
  }
}

export class SkillDetailUnavailableError extends Error {
  constructor() {
    super("The Skill detail production contract is unavailable.");
    this.name = "SkillDetailUnavailableError";
  }
}

const unavailable = (): Promise<never> =>
  Promise.reject(new SkillDetailUnavailableError());

export const unavailableSkillDetailFacade: SkillDetailFacade = {
  commitRollback: unavailable,
  setVersionLabel: unavailable,
  emitIntent: unavailable,
  getAdjacentContext: unavailable,
  getInsights: unavailable,
  getMetadata: unavailable,
  getRelations: unavailable,
  getProvenance: unavailable,
  getRelationshipOverview: unavailable,
  getRelationshipRemovalImpact: unavailable,
  getRequirements: unavailable,
  getRollbackImpact: unavailable,
  getSummary: unavailable,
  getVersionDiff: unavailable,
  getVersions: unavailable,
  checkSourceUpdate: unavailable,
  prepareSourceUpdate: unavailable,
  commitSourceUpdate: unavailable,
  ignoreSourceUpdate: unavailable,
  getSourceUpdateStatus: unavailable,
  relinkSource: unavailable,
  analyzeSemanticDuplicates: unavailable,
  isAiAvailable: async () => false,
  analyzeConflicts: unavailable,
  saveMetadata: unavailable,
  setTrial: unavailable,
};
