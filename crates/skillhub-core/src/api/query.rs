use crate::agent::{CustomAgent, DiscoverySnapshot};
use crate::app_update::{ApplicationUpdate, CheckApplicationUpdate, UpdateState};
use crate::catalog::{
    DeclaredRequirementFact, InvocationPolicyFact, SkillLifecycle,
};
use crate::check::{
    CheckKind, CheckResult as DomainCheckResult, CheckState, Finding, FindingDisposition,
};
use crate::deployment::DeploymentMode;
use crate::evidence::UsageEvidenceAnalysis;
use crate::import::{ImportAnalysis, ImportCandidate};
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
    SkillRelationshipGraph, SkillRelationshipNode, SourceRelationFact,
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
    Archived,
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
    pub high_risk_count: u32,
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
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct MarkdownFileEntry {
    pub label: String,
    pub path: String,
    pub primary: bool,
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
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct DiffVersions {
    pub left: VersionId,
    pub right: VersionId,
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

/// 只读发现：解析 `~/.agents/.skill-lock.json`，列出其中 GitHub 来源的
/// Skill 条目（不做网络请求）；随后可经 download_repo_skill 逐条导入。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct DiscoverAgentsLockSkills;

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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetProjectAssemblyPlan {
    pub project_id: crate::ProjectId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppQuery {
    #[serde(rename = "check_application_update")]
    CheckApplicationUpdate(CheckApplicationUpdate),
    #[serde(rename = "get_application_update_policy")]
    GetApplicationUpdatePolicy,
    #[serde(rename = "get_skill")]
    GetSkill(GetSkill),
    #[serde(rename = "list_skills")]
    ListSkills(ListSkills),
    #[serde(rename = "list_versions")]
    ListVersions(ListVersions),
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
    #[serde(rename = "list_markdown_files")]
    ListMarkdownFiles(ListMarkdownFiles),
    #[serde(rename = "read_markdown_file")]
    ReadMarkdownFile(ReadMarkdownFile),
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
    #[serde(rename = "discover_agents_lock_skills")]
    DiscoverAgentsLockSkills(DiscoverAgentsLockSkills),
    #[serde(rename = "analyze_global_skill_evidence")]
    AnalyzeGlobalSkillEvidence(AnalyzeGlobalSkillEvidence),
    #[serde(rename = "get_deployment_plan")]
    GetDeploymentPlan(GetDeploymentPlan),
    #[serde(rename = "list_deployment_targets")]
    ListDeploymentTargets(ListDeploymentTargets),
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
    #[serde(rename = "markdown_files")]
    MarkdownFiles(Vec<MarkdownFileEntry>),
    #[serde(rename = "markdown_file")]
    MarkdownFile(MarkdownFileContent),
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
    #[serde(rename = "import_candidates")]
    ImportCandidates(Vec<ImportCandidate>),
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
    #[serde(rename = "agents_lock_entries")]
    AgentsLockEntries(Vec<crate::source::AgentsLockEntry>),
    #[serde(rename = "deployment_plan")]
    DeploymentPlan(DeploymentPlan),
    #[serde(rename = "deployment_targets")]
    DeploymentTargets(Vec<DeploymentTarget>),
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
