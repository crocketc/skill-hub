use crate::agent::{AgentDirectoryProjection, CustomAgent, DiscoverySnapshot};
use crate::app_update::{ApplicationUpdate, CheckApplicationUpdate, UpdateState};
use crate::catalog::{DeclaredRequirementFact, InvocationPolicyFact, SkillLifecycle};
use crate::check::{
    CheckKind, CheckResult as DomainCheckResult, CheckState, CheckTrigger, Finding,
    FindingDisposition, ProductLevel,
};
use crate::deployment::DeploymentMode;
use crate::evidence::UsageEvidenceAnalysis;
use crate::import::{ImportAnalysis, ImportBatchConflictAnalysis, ImportCandidate};
use crate::project::{AssemblyPlan, Project, SavedProjectView};
use crate::search::{SearchHit, SearchQuery};
use crate::source::{SourceDescriptor, SourceSearchPage, SourceSearchQuery, SourceState};
use crate::{
    BootstrapSnapshot, DeploymentPlan, DeploymentPlanRequest, Severity, SkillId, VersionId,
};

use crate::relationship::{
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictWorkspace, DeploymentRelationFact,
    DirectoryNodeFact, GovernanceTaskFact, RelationGovernanceFilters, RelationGovernanceLedger,
    RelationshipGraphFactCounts, RelationshipGraphFilters, SkillRelationshipEdge,
    SkillRelationshipGraph, SkillRelationshipNode, SourceRelationFact, UsageDecisionRecord,
    UsageEntryKey, UsageRelationView,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetSkill {
    pub skill_id: SkillId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ListTranslations {
    pub skill_id: SkillId,
}
/// User-facing lifecycle bucket used by the library list filter. `Trial`
/// covers any skill with a pending trial date regardless of the stored
/// lifecycle, mirroring the display mapping used by the desktop clients.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SkillLifecycleFilter {
    Active,
    Trial,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SkillDeploymentFilter {
    #[default]
    Any,
    Deployed,
    NotDeployed,
}

/// Combined library list filter. Empty vectors match every value; the tag and
/// check-state vectors use any-of semantics.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields, default)]
pub struct SkillListFilters {
    pub ai_check: Vec<CheckState>,
    pub basic_check: Vec<CheckState>,
    pub deployment: SkillDeploymentFilter,
    pub lifecycle: Vec<SkillLifecycleFilter>,
    pub tags: Vec<String>,
    pub version: SkillVersionFilter,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SkillVersionFilter {
    #[default]
    Any,
    UpgradeAvailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SkillSortColumn {
    Name,
    Lifecycle,
    AgentDeployments,
    ProjectDeployments,
    Version,
    Updated,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SkillSortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillListSort {
    pub column: SkillSortColumn,
    pub direction: SkillSortDirection,
}

impl Default for SkillListSort {
    fn default() -> Self {
        Self {
            column: SkillSortColumn::Name,
            direction: SkillSortDirection::Asc,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ListSkills {
    pub text: String,
    pub page: u32,
    pub page_size: u32,
    #[serde(default)]
    pub filters: SkillListFilters,
    #[serde(default)]
    pub sort: SkillListSort,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SkillListItem {
    pub skill_id: SkillId,
    pub display_name: String,
    pub runtime_name: String,
    pub original_description: String,
    pub translated_description: Option<String>,
    pub user_note: Option<String>,
    pub user_purpose: Option<String>,
    pub tags: Vec<String>,
    pub license: Option<String>,
    pub lifecycle: SkillLifecycle,
    pub trial_due: Option<String>,
    pub author: Option<String>,
    pub source_kind: Option<String>,
    pub source_locator: Option<String>,
    pub current_version: Option<VersionId>,
    pub current_version_label: Option<String>,
    pub agent_deployment_count: u32,
    pub agent_deployment_target_ids: Vec<String>,
    pub project_deployment_count: u32,
    pub basic_check: CheckState,
    pub ai_check: CheckState,
    /// Number of actionable findings across the latest basic and AI checks.
    /// This is a read-model fact used by the library result column; it is not
    /// a UI default or a count of high-risk findings only.
    pub pending_count: u32,
    pub high_risk_count: u32,
    /// W3-1（FB-003 裁决第 1 节）：当前内容版本的安全预警状态。`Some` 表示
    /// 处于预警（不可派发、待办三选处理），值是预警级别；`None` 表示放行
    /// 或已完全信任。
    #[serde(default)]
    pub security_alert: Option<ProductLevel>,
    /// Latest explicit upstream observation; absent means the Skill has not
    /// been checked yet in this installation.
    #[serde(default)]
    pub upstream_state: Option<SourceState>,
    /// Read-only invocation policy fact (identified result or safe default).
    /// `None` only when the Skill record is missing; the UI must render a single
    /// explicit empty state rather than duplicate "no reliable data" stacks.
    #[serde(default)]
    pub invocation_policy: Option<InvocationPolicyFact>,
    /// Read-only declared runtime requirements. Empty when the Skill declares no
    /// runtime requirements.
    #[serde(default)]
    pub declared_requirements: Vec<DeclaredRequirementFact>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SkillListPage {
    pub items: Vec<SkillListItem>,
    pub total: u32,
    pub page: u32,
    pub page_size: u32,
    pub tags: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListVersions {
    pub skill_id: SkillId,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetRollbackImpact {
    pub skill_id: SkillId,
    pub target_version_id: VersionId,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct VersionAdoptionRelationImpact {
    pub relation_id: String,
    pub agent_client_id: String,
    pub path: String,
    pub path_key: String,
    pub directory_node_id: Option<String>,
    pub relationship: crate::relationship::RelationshipType,
    pub file_representation: crate::relationship::FileRepresentation,
    pub ownership: crate::relationship::OwnershipState,
    pub link_target_path: Option<String>,
    pub link_target_path_key: Option<String>,
    pub link_target_directory_id: Option<String>,
    pub match_state: crate::deployment::ObservedMatchState,
    pub health_reasons: Option<Vec<crate::relationship::RelationHealthReason>>,
    pub active: bool,
    pub follows_current: bool,
    pub independent_copy: bool,
    pub identity_reliable: bool,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RollbackImpact {
    pub skill_id: SkillId,
    pub current_version_id: Option<VersionId>,
    pub database_current_version_id: Option<VersionId>,
    pub portable_current_version_id: Option<VersionId>,
    pub visible_tree_fingerprint: Option<String>,
    pub target_version_id: VersionId,
    pub preview_id: crate::OperationId,
    pub expires_at: String,
    pub confirmation_fingerprint: String,
    pub target_basic_check_required: bool,
    pub relations: Vec<VersionAdoptionRelationImpact>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListSkillOperations {
    pub skill_id: SkillId,
}
/// One LLM check currently running in the facade, exposed so the UI can show
/// progress and hand the operation id to `cancel_operation`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct LlmCheckRun {
    pub skill_id: String,
    pub version_id: String,
    pub operation_id: crate::OperationId,
}
/// One persisted journal entry as surfaced by the per-skill history. The
/// journal has no skill dimension yet, so entries describe the operation
/// itself rather than a relation to the queried skill.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SkillOperationEntry {
    pub operation_id: String,
    pub kind: String,
    pub phase: crate::OperationPhase,
    pub error_code: Option<crate::ErrorCode>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SkillOperationsResult {
    pub skill_id: SkillId,
    pub entries: Vec<SkillOperationEntry>,
    /// True only when entries were genuinely narrowed to the skill. The
    /// journal does not record a skill dimension yet, so production answers
    /// carry `false` plus the limitation marker below.
    pub filtered: bool,
    /// Stable code describing why the history is not skill-scoped, e.g.
    /// `skill_dimension_not_recorded`.
    pub limitation: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListMarkdownFiles {
    pub skill_id: SkillId,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ReadMarkdownFile {
    pub skill_id: SkillId,
    pub path: String,
    #[serde(default)]
    pub version_id: Option<VersionId>,
}
/// K9：本地资产解析请求。Markdown 与资产必须来自同一版本——`version_id`
/// 给定时两者都只读该版本的清单；缺省（null）时用当前版本。跨版本混读
/// 不是"尽力解析"，而是明确拒绝；资产路径与 Markdown 路径同样只接受
/// 该版本树内的相对路径。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ResolveLocalAsset {
    pub skill_id: SkillId,
    pub markdown_path: String,
    pub asset_path: String,
    #[serde(default)]
    pub version_id: Option<VersionId>,
}
/// K9：解析结果。内容以 data URL 返回——webview 拿不到任何文件系统
/// 路径，只能拿到已通过版本树边界校验的字节与白名单媒体类型。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct LocalAssetResolution {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub markdown_path: String,
    pub asset_path: String,
    pub media_type: String,
    pub data_url: String,
}
/// K7/G-18：Skill 洞察读模型请求。组合、依赖、外部变化全部来自真实
/// 关系事实与操作日志；常量与硬编码空数组都不可接受。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetSkillInsights {
    pub skill_id: SkillId,
}
/// K7/G-18：洞察结果。空 Section 是真实事实的诚实呈现（确实没有组合/
/// 依赖/变化），不伪造占位数据；操作历史映射为用户事实文案码。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillInsightsResult {
    pub skill_id: SkillId,
    pub combinations: Vec<SkillInsightCombination>,
    pub dependencies: Vec<SkillInsightDependency>,
    pub external_changes: Vec<SkillInsightExternalChange>,
    pub operation_history: Vec<SkillInsightOperationEntry>,
    /// 与操作历史同源的局限标记（如 `skill_dimension_not_recorded`）；
    /// 日志能真实回答时为 None。
    pub operation_history_limitation: Option<String>,
}
/// K7：组合事实——组合名与其他成员的用户可见标签（不裸露 SkillId 之外
/// 的内部标识，成员标签来自 catalog 展示名）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillInsightCombination {
    pub name: String,
    pub other_member_labels: Vec<String>,
}
/// K7：依赖事实——活动关系按稳定形态码呈现（`import_copy`、
/// `managed_copy`、`managed_link`、`observed_copy`、`observed_link`、
/// `shared_directory_read`、`shared_directory_reference`、`unknown`）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillInsightDependency {
    pub relation_id: String,
    pub path: String,
    pub agent_client_id: Option<String>,
    pub shape_code: String,
}
/// K7：外部变化事实——关系内容与集中库分叉（`content_diverged`）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillInsightExternalChange {
    pub relation_id: String,
    pub path: String,
    pub state_code: String,
}
/// K7：操作历史条目——kind/phase/error_code 映射为用户事实文案码
/// （`insights.operation.<类别>.<结果>`），不向调用方裸露枚举。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillInsightOperationEntry {
    pub operation_id: String,
    pub message_code: String,
    /// Unix 秒的十进制字符串（Specta 不放行 64 位整数）；不可得时 None。
    pub at_epoch: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct MarkdownFileEntry {
    pub label: String,
    pub path: String,
    pub primary: bool,
}
/// K4：草稿摘要——工作台一次拉取的恢复事实。`base_content_identity`
/// 用于判定草稿是否仍基于当前内容；`base_version_id` 记录草稿基准
/// 版本（None=读取时未指定版本）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct MarkdownDraftSummary {
    pub base_content_identity: String,
    pub base_version_id: Option<String>,
    pub markdown: String,
    /// RFC 3339（UTC）。
    pub updated_at: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct MarkdownFileContent {
    pub content_identity: String,
    pub editable: bool,
    pub markdown: String,
    pub path: String,
    /// QA-013：所有权进入查询结果——只读原因来自领域所有权矩阵；
    /// 托管副本为 None（可显式保存原文形成新版本）。
    #[serde(default)]
    pub read_only_reason: Option<crate::catalog::MarkdownReadOnlyReason>,
    /// K4：该文件的未保存草稿摘要；None=无草稿。
    #[serde(default)]
    pub draft: Option<MarkdownDraftSummary>,
}
/// K4：草稿查询。无草稿时结果载荷为 `None`。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetMarkdownDraft {
    pub skill_id: SkillId,
    pub path: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct DiffVersions {
    pub left: VersionId,
    pub right: VersionId,
}
/// K5：替换继承预览请求——来源 Skill 与拟接管的受管目标（部署关系）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetSaveAsCopyReplacementPreview {
    pub source_skill_id: SkillId,
    pub targets: Vec<crate::DeploymentId>,
}
/// K5：单个替换目标的预览事实。`consumer_deployment_ids` 列出同一物理
/// 入口的全部活动消费者；共享目标接管必须逐项显式确认。身份不可核验的
/// 目标按 `blocker` 如实呈现，绝不静默放行。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SaveAsCopyReplacementTargetPreview {
    pub deployment_id: crate::DeploymentId,
    pub target_id: String,
    pub path: String,
    pub runtime_name: String,
    pub managed: bool,
    /// 目标无法核验（blocker 存在）时为 None。
    pub version_id: Option<VersionId>,
    pub consumer_deployment_ids: Vec<crate::DeploymentId>,
    pub requires_shared_target_confirmation: bool,
    /// 稳定阻断码：`target_not_found`/`target_not_managed`/
    /// `target_owner_mismatch`/`target_identity_unavailable`。None 表示
    /// 当前事实可核验、可进入提交核验。
    pub blocker: Option<String>,
}
/// K5：替换继承预览——§2 三件套（preview_id/expires_at/
/// confirmation_fingerprint）加逐目标事实。指纹内容=（来源 skill_id，
/// 来源当前 version_id，按部署记录身份排序的选定目标事实）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SaveAsCopyReplacementPreview {
    pub source_skill_id: SkillId,
    pub source_version_id: VersionId,
    pub preview_id: crate::OperationId,
    /// RFC 3339（UTC）。
    pub expires_at: String,
    pub confirmation_fingerprint: String,
    pub targets: Vec<SaveAsCopyReplacementTargetPreview>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListCombinations;
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SkillResult {
    pub skill_id: SkillId,
    pub display_name: String,
    pub runtime_name: String,
    pub original_description: String,
    pub translated_description: Option<String>,
    pub user_note: Option<String>,
    pub user_purpose: Option<String>,
    pub tags: Vec<String>,
    pub author: Option<String>,
    pub license: Option<String>,
    pub lifecycle: SkillLifecycle,
    pub trial_due: Option<String>,
    pub current_version: Option<VersionId>,
    /// Current deployed physical Agent targets, matching the catalog list read model.
    #[serde(default)]
    pub agent_deployment_count: u32,
    /// Current deployed registered project targets, matching the catalog list read model.
    #[serde(default)]
    pub project_deployment_count: u32,
    /// K9：Skill 在集中库中的真实物化根目录（用户可见树的绝对路径）；
    /// 树未物化时为 None。供"采纳本地来源"等预填场景取真实路径，
    /// 不派生自截断文本或显示别名。
    #[serde(default)]
    pub root_path: Option<String>,
    /// G-16：跟随当前版本的托管链接数——活动关系且路径是指向当前物化树
    /// 的链接（K1 影响语义的 follows_current 计数）。
    #[serde(default)]
    pub managed_link_count: u32,
    /// G-16：独立副本数——活动且未跟随当前版本的导入/观察副本（#15 起
    /// 受管复制属受管去向、由采用新版同步重写，不再计入独立副本）。
    #[serde(default)]
    pub independent_copy_count: u32,
    /// QA-010：当前版本的可读标签——用户命名优先，其次 vN 捕获序号；
    /// 内容哈希只是技术身份，不进入展示标签（不可读时为 None）。
    #[serde(default)]
    pub current_version_label: Option<String>,
    /// Read-only invocation policy fact (identified result or safe default).
    #[serde(default)]
    pub invocation_policy: Option<InvocationPolicyFact>,
    /// Read-only declared runtime requirements. Empty when none are declared.
    #[serde(default)]
    pub declared_requirements: Vec<DeclaredRequirementFact>,
    /// 与列表投影同源的来源、检查与待处理事实；单技能抽屉读模型不得比
    /// 列表读模型更薄（get_detail 与 list_page 共用 status_columns）。
    #[serde(default)]
    pub source_kind: Option<String>,
    #[serde(default)]
    pub source_locator: Option<String>,
    #[serde(default)]
    pub basic_check: crate::check::CheckState,
    #[serde(default)]
    pub ai_check: crate::check::CheckState,
    #[serde(default)]
    pub pending_count: u32,
    #[serde(default)]
    pub high_risk_count: u32,
    #[serde(default)]
    pub upstream_state: Option<crate::source::SourceState>,
    /// W3-1（FB-003 裁决第 1 节）：当前内容版本的安全预警状态，与列表
    /// 投影同一事实来源。详情不得比列表更薄。
    #[serde(default)]
    pub security_alert: Option<ProductLevel>,
    /// K5/MS-04：上游谱系——本主体由哪个来源 skill+version 复用修改而来
    /// （ReuseModify 登记的有向事实）。None=无登记，诚实缺省。
    #[serde(default)]
    pub upstream_lineage: Option<SkillUpstreamLineage>,
}
/// K5/MS-04：详情查询暴露的上游谱系。来源展示名读取时解析；来源主体
/// 已删除时为 None，不编造标签。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillUpstreamLineage {
    pub source_skill_id: SkillId,
    pub source_version_id: VersionId,
    pub source_display_name: Option<String>,
    /// 登记时间（Unix 秒的十进制字符串，Specta 不放行 64 位整数）。
    #[serde(default)]
    pub created_at: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct VersionResult {
    pub version_id: VersionId,
    pub skill_id: SkillId,
    pub current: bool,
    pub file_count: u32,
    pub added: u32,
    pub changed: u32,
    pub removed: u32,
    /// 版本清单文件的修改时间（Unix 秒的十进制字符串，Specta 不放行
    /// 64 位整数）——作为可读版本序号的依据；不可得时为 None（诚实缺省）。
    #[serde(default)]
    pub created_at_epoch: Option<String>,
    /// 按捕获时间排序的序号（最早 = 1）；时间未知时为 None。
    #[serde(default)]
    pub sequence: Option<u32>,
    /// 用户显式命名的版本名（AR-021）；未命名时 None。
    #[serde(default)]
    pub label: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct VersionDiffResult {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct CombinationResult {
    pub name: String,
    pub members: Vec<SkillId>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetBootstrapSnapshot;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListPendingItems;

/// N12：确定性重复（当前版本内容哈希相同的其他 Skill）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ListDeterministicDuplicates {
    pub skill_id: SkillId,
}

/// 单条确定性重复：对方 Skill 及其当前版本内容哈希。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeterministicDuplicateEntry {
    pub skill_id: SkillId,
    pub label: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetDiscoverySnapshot;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetAgentDirectoryProjection;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListCustomAgents;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListProjects;

/// Read-only analysis of a user-chosen local directory before project
/// registration. It never creates catalog, project, or deployment records and
/// never writes to the analyzed directory.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PreviewProjectDirectory {
    pub path: String,
}

/// Project-scoped agent directories found inside the chosen root, plus the
/// skill directories the bounded detector can scan from it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ProjectDirectoryPreview {
    pub path: String,
    pub agent_traces: Vec<crate::agent::LogicalTarget>,
    pub skill_candidates: Vec<crate::import::ImportCandidate>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListSavedProjectViews;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct AnalyzeImport {
    pub candidate: ImportCandidate,
    pub tree_hash: Option<String>,
}

/// W2-2（FB-007）：批内冲突分析。输入发现阶段产出的一批候选，core 纯
/// 函数互检分组；`batch_id` 提供时应用层把分析暂存在会话内存，供提交
/// 期核对组成签名与同名处置。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AnalyzeImportBatch {
    pub batch_id: Option<String>,
    pub candidates: Vec<ImportCandidate>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DiscoverImportCandidates {
    pub source: SourceDescriptor,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SearchOnlineSources {
    pub query: SourceSearchQuery,
}

/// An assisted online search: the original text always runs against the real
/// provider; AI query extension may add marked hits, never invented ones.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SearchOnlineSourcesAssisted {
    pub text: String,
}

/// P1-05：待确认搜索候选列表（持久化，跨会话可恢复）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListSearchCandidates;

/// Reads a UI preference value (raw JSON) by key; absent keys return null.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetUiPreference {
    pub key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListSkillRepos;

/// Downloads every enabled GitHub repo archive and scans it for SKILL.md
/// directories. Per-repo failures surface as warnings; the query never writes
/// outside temporary download directories.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct DiscoverRepoSkills;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AnalyzeGlobalSkillEvidence {
    pub window_days: u32,
    pub threshold_calls: u32,
}

/// Registered logical target IDs for a side-effect-free deployment preview.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetDeploymentPlan {
    pub request: DeploymentPlanRequest,
}

/// One Skill × target-selection group inside a batch deployment preview.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentBatchPreviewRequestItem {
    pub skill_id: SkillId,
    /// Explicit version; `None` resolves the Skill's current library version.
    pub version_id: Option<VersionId>,
    /// Explicit runtime name; `None` resolves the version's declared name.
    pub runtime_name: Option<String>,
    pub logical_target_ids: Vec<String>,
    pub preference: crate::deployment::DeploymentPreference,
}

/// Side-effect-free batch deployment preview request.  The client names
/// Skills, targets and a preference; confirmations map a pair id to the
/// confirmation fingerprint the client still holds, and exclusions list pair
/// ids the user removed from the batch.  Everything else stays server-owned.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetDeploymentBatchPreview {
    pub items: Vec<DeploymentBatchPreviewRequestItem>,
    #[serde(default)]
    pub confirmations: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub exclusions: Vec<String>,
}

/// One Skill × physical-target pair of a batch deployment preview.  Pair ids
/// are stable UI identity derived from the Skill and the physical target;
/// they never authorize anything by themselves.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentPairPreview {
    pub pair_id: String,
    pub skill_id: SkillId,
    pub skill_display_name: String,
    pub version_id: VersionId,
    pub runtime_name: String,
    pub logical_target_ids: Vec<String>,
    pub target_label: String,
    pub target_path: String,
    pub destination_path: String,
    pub preference: crate::deployment::DeploymentPreference,
    pub disposition: crate::deployment::DeploymentPreviewDisposition,
    pub mode: Option<DeploymentMode>,
    pub fallback_mode: Option<DeploymentMode>,
    pub block_reason: Option<crate::deployment::DeploymentBlockReason>,
    pub warnings: Vec<String>,
    /// `true` when a client-held confirmation still matches the recomputed
    /// fingerprint.  The frontend never compares fingerprints itself.
    pub confirmation_preserved: bool,
    pub confirmation_fingerprint: String,
    /// Original failure code and safe parameters for the technical-details
    /// area only; the user-facing reason is `block_reason`.
    pub technical_error: Option<crate::application::TargetOperationError>,
}

/// The server-owned result of a batch deployment preview.  `preview_id`
/// names the stored snapshot a later commit must reference.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentBatchPreview {
    pub preview_id: String,
    /// RFC-3339 UTC instant after which the snapshot is refused.
    pub expires_at: String,
    pub pairs: Vec<DeploymentPairPreview>,
    /// Pair ids whose client-held confirmation stayed valid.
    pub preserved_confirmation_ids: Vec<String>,
}

/// A registered logical filesystem target available for deployment selection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentTarget {
    pub id: String,
    pub label: String,
    pub path: String,
    pub available: bool,
    pub physical_id: String,
    pub modes: Vec<DeploymentMode>,
    /// Structured identity used by clients to render an Agent consistently.
    /// Project targets leave these fields empty.
    #[serde(default)]
    pub agent_client_id: Option<String>,
    #[serde(default)]
    pub agent_profile_id: Option<String>,
    #[serde(default)]
    pub shared_directory: bool,
    /// Brand profiles that recognise the same physical shared directory.
    /// Empty for ordinary Agent and project targets.
    #[serde(default)]
    pub shared_agent_brands: Vec<String>,
    /// Client kinds grouped by the brand that recognises the same physical
    /// shared directory. Used only for the user-facing logo tooltip.
    #[serde(default)]
    pub shared_agent_brand_kinds: std::collections::BTreeMap<String, Vec<crate::agent::ClientKind>>,
    /// User-facing directory observation fact; absent for project targets.
    #[serde(default)]
    pub directory_status: Option<crate::agent::DirectoryObservationStatus>,
    /// False for a not-yet-created candidate path. Such a target may be shown
    /// for confirmation but must not be used as a physical deployment identity.
    #[serde(default)]
    pub physical_identity_verified: bool,
    /// First supported mode, matching the existing planner preference order.
    #[serde(default)]
    pub preferred_mode: Option<DeploymentMode>,
}

/// Lists registered logical targets without scanning arbitrary directories.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListDeploymentTargets;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetBasicCheckResult {
    pub skill_id: SkillId,
    pub version_id: VersionId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListFindings {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub kind: CheckKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct BasicCheckResult {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub state: CheckState,
    pub run_id: Option<String>,
    pub ruleset_id: Option<String>,
    pub checked_at: Option<String>,
    pub finding_count: u32,
    pub actionable_count: u32,
    /// W1-3（FB-006）：该记录的触发来源；无记录时回退为 manual。
    #[serde(default)]
    pub trigger: CheckTrigger,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct LlmSafetyCheckResult {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub state: CheckState,
    pub run_id: Option<String>,
    #[serde(default)]
    pub basic_run_id: Option<String>,
    pub model_id: Option<String>,
    pub checked_at: Option<String>,
    pub finding_count: u32,
    pub actionable_count: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct FindingResult {
    pub id: String,
    pub code: String,
    pub severity: Severity,
    pub file: Option<String>,
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    pub disposition: FindingDisposition,
    pub high_risk: bool,
}

impl BasicCheckResult {
    pub fn from_check_result(
        skill_id: SkillId,
        version_id: VersionId,
        result: &DomainCheckResult,
    ) -> Self {
        let run = result.run.as_ref();
        let finding_count = run
            .map(|run| u32::try_from(run.findings.len()).unwrap_or(u32::MAX))
            .unwrap_or_default();
        let actionable_count = run
            .map(|run| {
                u32::try_from(
                    run.findings
                        .iter()
                        .filter(|finding| finding.is_actionable())
                        .count(),
                )
                .unwrap_or(u32::MAX)
            })
            .unwrap_or_default();
        Self {
            skill_id,
            version_id,
            state: result.state,
            run_id: run.map(|run| run.id.clone()),
            ruleset_id: run.and_then(|run| run.ruleset_id.clone()),
            checked_at: run.and_then(|run| run.ended_at.map(|value| value.to_string())),
            finding_count,
            actionable_count,
            trigger: run.map(|run| run.trigger).unwrap_or_default(),
        }
    }
}

impl From<&Finding> for FindingResult {
    fn from(finding: &Finding) -> Self {
        Self {
            id: finding.id.clone(),
            code: finding.code.clone(),
            severity: finding.severity,
            file: finding.file.clone(),
            line_start: finding.line_start,
            line_end: finding.line_end,
            disposition: finding.disposition,
            high_risk: finding.is_high_risk(),
        }
    }
}

impl LlmSafetyCheckResult {
    pub fn from_check_result(
        skill_id: SkillId,
        version_id: VersionId,
        result: &DomainCheckResult,
    ) -> Self {
        let run = result.run.as_ref();
        Self {
            skill_id,
            version_id,
            state: result.state,
            run_id: run.map(|run| run.id.clone()),
            basic_run_id: run.and_then(|run| {
                run.coverage_inputs
                    .get("basic_run_id")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned)
            }),
            model_id: run.and_then(|run| run.model_id.clone()),
            checked_at: run.and_then(|run| run.ended_at.map(|value| value.to_string())),
            finding_count: run
                .map(|run| u32::try_from(run.findings.len()).unwrap_or(u32::MAX))
                .unwrap_or_default(),
            actionable_count: run
                .map(|run| {
                    u32::try_from(
                        run.findings
                            .iter()
                            .filter(|finding| finding.is_actionable())
                            .count(),
                    )
                    .unwrap_or(u32::MAX)
                })
                .unwrap_or_default(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ListDeployments {
    pub skill_id: Option<SkillId>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetDeploymentRelations {
    pub skill_id: SkillId,
}

/// OPT-20260914-08：读取一个 Skill 的导入存证与已观察部署关系。
/// 溯源与关系是展示/审计数据：查询绝不触发扫描、导入或文件系统写入。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetSkillProvenance {
    pub skill_id: SkillId,
}

/// 导入存证 + 已观察部署关系的联合视图。`provenance` 为 None 表示该
/// Skill 不是经由带存证的导入链路进入集中库的（例如创建/收集），诚实
/// 缺省而不是编造来源。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillProvenanceResult {
    pub skill_id: SkillId,
    pub provenance: Option<crate::import::ImportProvenance>,
    pub observed_deployments: Vec<crate::deployment::ObservedDeployment>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetReconcilePlan {
    pub deployment_id: crate::DeploymentId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetRemovalImpact {
    pub skill_id: SkillId,
}

/// Scope for the normalized relationship view.  This is a fact query only:
/// it deliberately has no field claiming that an Agent has loaded or can
/// execute a file merely because the file was found in a recognized path.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case", tag = "type", content = "value")]
pub enum RelationshipOverviewScope {
    All,
    Skill { skill_id: SkillId },
    Agent { agent_client_id: String },
    Directory { directory_node_id: String },
    Relation { relation_id: String },
    Path { path_key: String },
}

pub type RelationshipScope = RelationshipOverviewScope;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetRelationshipOverview {
    pub scope: RelationshipOverviewScope,
}

/// Reads durable decisions for a confirmed skill/entry identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ListUsageDecisions {
    pub skill_id: SkillId,
    pub entry_key: UsageEntryKey,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetRelationshipRemovalImpact {
    pub relation_id: String,
}

/// Reads the conflict-resolution workspace: the pending `uncertain` queue, each
/// case's latest analysis (and whether the input fingerprint moved on), the
/// cumulative handled count and the handled history. Read-only: it never
/// scans, calls AI or writes a fact.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetConflictWorkspace;

/// Reads one bounded, fact-backed relationship graph. This query is read-only:
/// it never scans files, calls AI, or refreshes relationship facts.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetSkillRelationshipGraph {
    pub skill_id: SkillId,
    #[serde(default)]
    pub filters: RelationshipGraphFilters,
}

/// Searches Skills that have a displayable relationship fact or an unresolved
/// conflict. `runtime_name` is the stable compatibility alias exposed by the
/// catalog, so matching it reports `matched_alias`.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ListSkillRelationshipCandidates {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Reads the relationship-governance ledger: one row per established
/// relationship edge, plus the four quick-filter counts.  Read-only: it never
/// scans files, calls AI, probes link capability or writes a fact.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ListRelationGovernance {
    #[serde(default)]
    pub filters: RelationGovernanceFilters,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillRelationshipCandidate {
    pub skill_id: SkillId,
    pub display_name: String,
    pub runtime_name: String,
    pub tags: Vec<String>,
    pub matched_alias: Option<String>,
    pub relationship_count: u32,
    pub relationship_revision: String,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub last_verified_at: Option<i64>,
}

/// UI graph result. The graph remains a pure relationship projection; the
/// persisted revision identifies the fact snapshot used to construct it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillRelationshipGraphResult {
    pub center_skill_id: SkillId,
    pub nodes: Vec<SkillRelationshipNode>,
    pub edges: Vec<SkillRelationshipEdge>,
    pub fact_counts: RelationshipGraphFactCounts,
    pub collapsed_count: u32,
    pub relationship_revision: String,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub last_verified_at: Option<i64>,
}

impl SkillRelationshipGraphResult {
    pub fn from_projection(
        projection: SkillRelationshipGraph,
        relationship_revision: i64,
        last_verified_at: Option<i64>,
    ) -> Self {
        Self {
            center_skill_id: projection.center_skill_id,
            nodes: projection.nodes,
            edges: projection.edges,
            fact_counts: projection.fact_counts,
            collapsed_count: projection.collapsed_count,
            relationship_revision: relationship_revision.to_string(),
            last_verified_at: projection.last_verified_at.or(last_verified_at),
        }
    }

    pub fn has_node(&self, node_id: &str) -> bool {
        self.nodes.iter().any(|node| node.node_id == node_id)
    }
}

/// One deterministic relationship snapshot shared by import, Agent and Skill
/// views.  `agent_execution_confirmed` is intentionally always false: path
/// discovery/recognition is not runtime loading evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationshipOverview {
    pub scope: RelationshipOverviewScope,
    pub directory_nodes: Vec<DirectoryNodeFact>,
    pub agent_directory_capabilities: Vec<AgentDirectoryCapabilityFact>,
    pub source_relations: Vec<SourceRelationFact>,
    pub deployment_relations: Vec<DeploymentRelationFact>,
    /// Unified active use facts projected from deployment/source evidence.
    pub usage_relations: Vec<UsageRelationView>,
    pub conflict_cases: Vec<ConflictCaseFact>,
    pub pending_governance_tasks: Vec<GovernanceTaskFact>,
    pub agent_execution_confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetCallPolicy {
    pub skill_id: SkillId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetLlmSafetyCheckResult {
    pub skill_id: SkillId,
    pub version_id: VersionId,
}

/// N8：批量来源更新检查。显式传入 Skill 列表（由前端选择决定范围），
/// 逐条复用单 Skill 检测；单条失败按项降级，不影响批次其余结果。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CheckSourceUpdates {
    pub skill_ids: Vec<SkillId>,
}

/// N8：批量检查的单条结果——Skill 及其来源状态（含诚实的 SourceUnavailable）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SourceUpdateCheckOutcome {
    pub skill_id: SkillId,
    pub state: crate::SourceState,
}

/// K6：Skill 来源候选/检查状态查询。只读已持久化的检查事实与忽略记录，
/// 不发起网络请求；B 侧用它渲染候选与忽略状态，采纳/检查成功后失效刷新。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetSourceUpdateStatus {
    pub skill_id: SkillId,
}

/// K6：来源候选/检查状态投影。从未检查过时 state 为 None（诚实缺省）；
/// candidate_ignored 表示当前候选是否已被用户忽略（D3）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SourceUpdateStatus {
    pub skill_id: SkillId,
    pub state: Option<crate::SourceState>,
    /// 最近一次检查时刻，RFC3339 UTC；从未检查过为 None。
    pub checked_at: Option<String>,
    pub upstream_label: Option<String>,
    pub candidate_identity: Option<String>,
    /// 该 Skill 当前全部被忽略的候选身份。
    pub ignored_candidates: Vec<String>,
    /// 当前候选是否被忽略。
    pub candidate_ignored: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetProjectAssemblyPlan {
    pub project_id: crate::ProjectId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppQuery {
    #[serde(rename = "check_application_update")]
    CheckApplicationUpdate(CheckApplicationUpdate),
    #[serde(rename = "query_open_import_batch")]
    QueryOpenImportBatch(crate::api::QueryOpenImportBatch),
    #[serde(rename = "get_application_update_policy")]
    GetApplicationUpdatePolicy,
    #[serde(rename = "get_skill")]
    GetSkill(GetSkill),
    #[serde(rename = "list_skills")]
    ListSkills(ListSkills),
    #[serde(rename = "list_versions")]
    ListVersions(ListVersions),
    #[serde(rename = "get_rollback_impact")]
    GetRollbackImpact(GetRollbackImpact),
    #[serde(rename = "get_save_as_copy_replacement_preview")]
    GetSaveAsCopyReplacementPreview(GetSaveAsCopyReplacementPreview),
    #[serde(rename = "list_skill_operations")]
    ListSkillOperations(ListSkillOperations),
    #[serde(rename = "list_running_llm_checks")]
    ListRunningLlmChecks,
    #[serde(rename = "list_llm_providers")]
    ListLlmProviders,
    #[serde(rename = "list_translations")]
    ListTranslations(ListTranslations),
    #[serde(rename = "list_llm_provider_presets")]
    ListLlmProviderPresets,
    #[serde(rename = "check_source_updates")]
    CheckSourceUpdates(CheckSourceUpdates),
    #[serde(rename = "get_source_update_status")]
    GetSourceUpdateStatus(GetSourceUpdateStatus),
    #[serde(rename = "list_markdown_files")]
    ListMarkdownFiles(ListMarkdownFiles),
    #[serde(rename = "read_markdown_file")]
    ReadMarkdownFile(ReadMarkdownFile),
    #[serde(rename = "resolve_local_asset")]
    ResolveLocalAsset(ResolveLocalAsset),
    #[serde(rename = "get_skill_insights")]
    GetSkillInsights(GetSkillInsights),
    #[serde(rename = "get_markdown_draft")]
    GetMarkdownDraft(GetMarkdownDraft),
    #[serde(rename = "diff_versions")]
    DiffVersions(DiffVersions),
    #[serde(rename = "list_combinations")]
    ListCombinations(ListCombinations),
    #[serde(rename = "search")]
    Search(SearchQuery),
    #[serde(rename = "search_online_sources_assisted")]
    SearchOnlineSourcesAssisted(SearchOnlineSourcesAssisted),
    #[serde(rename = "get_bootstrap_snapshot")]
    GetBootstrapSnapshot,
    #[serde(rename = "get_desktop_preferences")]
    GetDesktopPreferences,
    #[serde(rename = "list_pending_items")]
    ListPendingItems(ListPendingItems),
    #[serde(rename = "get_pending_workspace")]
    GetPendingWorkspace,
    #[serde(rename = "list_pending_confirmations")]
    ListPendingConfirmations,
    #[serde(rename = "list_deterministic_duplicates")]
    ListDeterministicDuplicates(ListDeterministicDuplicates),
    #[serde(rename = "get_discovery_snapshot")]
    GetDiscoverySnapshot(GetDiscoverySnapshot),
    #[serde(rename = "list_custom_agents")]
    ListCustomAgents(ListCustomAgents),
    #[serde(rename = "list_projects")]
    ListProjects(ListProjects),
    #[serde(rename = "preview_project_directory")]
    PreviewProjectDirectory(PreviewProjectDirectory),
    #[serde(rename = "list_saved_project_views")]
    ListSavedProjectViews(ListSavedProjectViews),
    #[serde(rename = "analyze_import")]
    AnalyzeImport(AnalyzeImport),
    #[serde(rename = "analyze_import_batch")]
    AnalyzeImportBatch(AnalyzeImportBatch),
    #[serde(rename = "discover_import_candidates")]
    DiscoverImportCandidates(DiscoverImportCandidates),
    #[serde(rename = "search_online_sources")]
    SearchOnlineSources(SearchOnlineSources),
    #[serde(rename = "list_search_candidates")]
    ListSearchCandidates(ListSearchCandidates),
    #[serde(rename = "get_ui_preference")]
    GetUiPreference(GetUiPreference),
    #[serde(rename = "list_skill_repos")]
    ListSkillRepos(ListSkillRepos),
    #[serde(rename = "discover_repo_skills")]
    DiscoverRepoSkills(DiscoverRepoSkills),
    #[serde(rename = "analyze_global_skill_evidence")]
    AnalyzeGlobalSkillEvidence(AnalyzeGlobalSkillEvidence),
    #[serde(rename = "get_deployment_plan")]
    GetDeploymentPlan(GetDeploymentPlan),
    #[serde(rename = "get_deployment_batch_preview")]
    GetDeploymentBatchPreview(GetDeploymentBatchPreview),
    #[serde(rename = "list_deployment_targets")]
    ListDeploymentTargets(ListDeploymentTargets),
    #[serde(rename = "get_agent_directory_projection")]
    GetAgentDirectoryProjection(GetAgentDirectoryProjection),
    #[serde(rename = "list_deployments")]
    ListDeployments(ListDeployments),
    #[serde(rename = "get_deployment_relations")]
    GetDeploymentRelations(GetDeploymentRelations),
    #[serde(rename = "get_skill_provenance")]
    GetSkillProvenance(GetSkillProvenance),
    #[serde(rename = "get_reconcile_plan")]
    GetReconcilePlan(GetReconcilePlan),
    #[serde(rename = "get_removal_impact")]
    GetRemovalImpact(GetRemovalImpact),
    #[serde(rename = "get_relationship_overview")]
    GetRelationshipOverview(GetRelationshipOverview),
    #[serde(rename = "list_usage_decisions")]
    ListUsageDecisions(ListUsageDecisions),
    #[serde(rename = "get_relationship_removal_impact")]
    GetRelationshipRemovalImpact(GetRelationshipRemovalImpact),
    #[serde(rename = "get_skill_relationship_graph")]
    GetSkillRelationshipGraph(GetSkillRelationshipGraph),
    #[serde(rename = "list_skill_relationship_candidates")]
    ListSkillRelationshipCandidates(ListSkillRelationshipCandidates),
    #[serde(rename = "get_conflict_workspace")]
    GetConflictWorkspace(GetConflictWorkspace),
    #[serde(rename = "list_relation_governance")]
    ListRelationGovernance(ListRelationGovernance),
    #[serde(rename = "list_governance_history")]
    ListGovernanceHistory(crate::relationship::ListGovernanceHistory),
    #[serde(rename = "list_recovery_candidates")]
    ListRecoveryCandidates,
    #[serde(rename = "get_call_policy")]
    GetCallPolicy(GetCallPolicy),
    #[serde(rename = "get_llm_safety_check_result")]
    GetLlmSafetyCheckResult(GetLlmSafetyCheckResult),
    #[serde(rename = "list_ignore_rules")]
    ListIgnoreRules,
    #[serde(rename = "get_basic_check_result")]
    GetBasicCheckResult(GetBasicCheckResult),
    #[serde(rename = "list_findings")]
    ListFindings(ListFindings),
    #[serde(rename = "get_project_assembly_plan")]
    GetProjectAssemblyPlan(GetProjectAssemblyPlan),
}

/// A single UI preference entry (raw JSON payload stored verbatim).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GetUiPreferenceResult {
    pub key: String,
    pub value_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppQueryResult {
    #[serde(rename = "application_update")]
    ApplicationUpdate(ApplicationUpdate),
    #[serde(rename = "application_update_state")]
    ApplicationUpdateState(UpdateState),
    #[serde(rename = "application_update_policy")]
    ApplicationUpdatePolicy(crate::ApplicationUpdatePolicy),
    #[serde(rename = "skill")]
    Skill(SkillResult),
    #[serde(rename = "skill_page")]
    SkillPage(SkillListPage),
    #[serde(rename = "versions")]
    Versions(Vec<VersionResult>),
    #[serde(rename = "rollback_impact")]
    RollbackImpact(RollbackImpact),
    #[serde(rename = "save_as_copy_replacement_preview")]
    SaveAsCopyReplacementPreview(SaveAsCopyReplacementPreview),
    #[serde(rename = "markdown_files")]
    MarkdownFiles(Vec<MarkdownFileEntry>),
    #[serde(rename = "markdown_file")]
    MarkdownFile(MarkdownFileContent),
    #[serde(rename = "markdown_draft")]
    MarkdownDraft(Option<MarkdownDraftSummary>),
    #[serde(rename = "local_asset")]
    LocalAsset(LocalAssetResolution),
    #[serde(rename = "skill_insights")]
    SkillInsights(SkillInsightsResult),
    #[serde(rename = "version_diff")]
    VersionDiff(VersionDiffResult),
    #[serde(rename = "combinations")]
    Combinations(Vec<CombinationResult>),
    #[serde(rename = "search_results")]
    SearchResults(Vec<SearchHit>),
    #[serde(rename = "global_skill_evidence")]
    GlobalSkillEvidence(UsageEvidenceAnalysis),
    #[serde(rename = "bootstrap_snapshot")]
    BootstrapSnapshot(BootstrapSnapshot),
    #[serde(rename = "desktop_preferences")]
    DesktopPreferences(crate::DesktopPreferences),
    #[serde(rename = "pending_items")]
    PendingItems(Vec<crate::pending::PendingItem>),
    #[serde(rename = "pending_workspace")]
    PendingWorkspace(crate::pending::PendingWorkspace),
    #[serde(rename = "pending_confirmations")]
    PendingConfirmations(Vec<crate::pending::PendingConfirmation>),
    #[serde(rename = "deterministic_duplicates")]
    DeterministicDuplicates(Vec<DeterministicDuplicateEntry>),
    #[serde(rename = "discovery_snapshot")]
    DiscoverySnapshot(DiscoverySnapshot),
    #[serde(rename = "custom_agents")]
    CustomAgents(Vec<CustomAgent>),
    #[serde(rename = "projects")]
    Projects(Vec<Project>),
    #[serde(rename = "project_directory_preview")]
    ProjectDirectoryPreview(ProjectDirectoryPreview),
    #[serde(rename = "saved_project_views")]
    SavedProjectViews(Vec<SavedProjectView>),
    #[serde(rename = "import_analysis")]
    ImportAnalysis(ImportAnalysis),
    #[serde(rename = "import_batch_analysis")]
    ImportBatchAnalysis(ImportBatchConflictAnalysis),
    #[serde(rename = "import_candidates")]
    ImportCandidates(Vec<ImportCandidate>),
    #[serde(rename = "open_import_batches")]
    OpenImportBatches(Vec<crate::api::OpenImportBatch>),
    #[serde(rename = "source_search_page")]
    SourceSearchPage(SourceSearchPage),
    #[serde(rename = "search_candidates")]
    SearchCandidates(Vec<crate::source::SearchCandidateRecord>),
    #[serde(rename = "ui_preference")]
    UiPreference(crate::GetUiPreferenceResult),
    #[serde(rename = "skill_repos")]
    SkillRepos(Vec<crate::source::SkillRepoView>),
    #[serde(rename = "repo_discovery_report")]
    RepoDiscoveryReport(crate::source::RepoDiscoveryReport),
    #[serde(rename = "deployment_plan")]
    DeploymentPlan(DeploymentPlan),
    #[serde(rename = "deployment_batch_preview")]
    DeploymentBatchPreview(DeploymentBatchPreview),
    #[serde(rename = "deployment_targets")]
    DeploymentTargets(Vec<DeploymentTarget>),
    #[serde(rename = "agent_directory_projection")]
    AgentDirectoryProjection(AgentDirectoryProjection),
    #[serde(rename = "deployments")]
    Deployments(Vec<crate::DeploymentRecord>),
    #[serde(rename = "deployment_relations")]
    DeploymentRelations(Vec<crate::DeploymentRecord>),
    #[serde(rename = "skill_provenance")]
    SkillProvenance(SkillProvenanceResult),
    #[serde(rename = "reconcile_plan")]
    ReconcilePlan(crate::ReconcilePlan),
    #[serde(rename = "removal_impact")]
    RemovalImpact(crate::RemovalImpact),
    #[serde(rename = "relationship_overview")]
    RelationshipOverview(RelationshipOverview),
    #[serde(rename = "usage_decision_history")]
    UsageDecisionHistory(Vec<UsageDecisionRecord>),
    #[serde(rename = "relationship_removal_impact")]
    RelationshipRemovalImpact(crate::relationship::RemovalImpactFact),
    #[serde(rename = "skill_relationship_graph")]
    SkillRelationshipGraph(SkillRelationshipGraphResult),
    #[serde(rename = "skill_relationship_candidates")]
    SkillRelationshipCandidates(Vec<SkillRelationshipCandidate>),
    #[serde(rename = "conflict_workspace")]
    ConflictWorkspace(ConflictWorkspace),
    #[serde(rename = "relation_governance_ledger")]
    RelationGovernanceLedger(RelationGovernanceLedger),
    #[serde(rename = "governance_history_page")]
    GovernanceHistoryPage(crate::relationship::GovernanceHistoryPage),
    #[serde(rename = "recovery_candidates")]
    RecoveryCandidates(Vec<crate::RecoveryCandidate>),
    #[serde(rename = "skill_operations")]
    SkillOperations(SkillOperationsResult),
    #[serde(rename = "running_llm_checks")]
    RunningLlmChecks(Vec<LlmCheckRun>),
    #[serde(rename = "llm_providers")]
    LlmProviders(Vec<crate::llm::LlmProviderView>),
    #[serde(rename = "translations")]
    Translations(Vec<crate::llm::TranslationView>),
    #[serde(rename = "llm_provider_presets")]
    LlmProviderPresets(Vec<crate::llm::LlmProviderPreset>),
    #[serde(rename = "source_update_checks")]
    SourceUpdateChecks(Vec<SourceUpdateCheckOutcome>),
    #[serde(rename = "source_update_status")]
    SourceUpdateStatus(SourceUpdateStatus),
    #[serde(rename = "call_policy")]
    CallPolicy(crate::CallPolicyResult),
    #[serde(rename = "llm_safety_check_result")]
    LlmSafetyCheckResult(LlmSafetyCheckResult),
    #[serde(rename = "ignore_rules")]
    IgnoreRules(Vec<crate::IgnoreRule>),
    #[serde(rename = "basic_check_result")]
    BasicCheckResult(BasicCheckResult),
    #[serde(rename = "findings")]
    Findings(Vec<FindingResult>),
    #[serde(rename = "assembly_plan")]
    AssemblyPlan(AssemblyPlan),
}
