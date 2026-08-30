use crate::agent::{CustomAgent, DiscoverySnapshot};
use crate::app_update::{ApplicationUpdate, CheckApplicationUpdate};
use crate::catalog::SkillLifecycle;
use crate::check::{
    CheckKind, CheckResult as DomainCheckResult, CheckState, Finding, FindingDisposition,
};
use crate::deployment::DeploymentMode;
use crate::evidence::UsageEvidenceAnalysis;
use crate::import::{ImportAnalysis, ImportCandidate};
use crate::project::{AssemblyPlan, Project, SavedProjectView};
use crate::search::{SearchHit, SearchQuery};
use crate::source::{SourceDescriptor, SourceSearchPage, SourceSearchQuery};
use crate::{
    BootstrapSnapshot, DeploymentPlan, DeploymentPlanRequest, Severity, SkillId, VersionId,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetSkill {
    pub skill_id: SkillId,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ListSkills {
    pub text: String,
    pub page: u32,
    pub page_size: u32,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SkillListItem {
    pub skill_id: SkillId,
    pub display_name: String,
    pub runtime_name: String,
    pub original_description: String,
    pub translated_description: Option<String>,
    pub user_note: Option<String>,
    pub tags: Vec<String>,
    pub license: Option<String>,
    pub lifecycle: SkillLifecycle,
    pub trial_due: Option<String>,
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
    pub tags: Vec<String>,
    pub license: Option<String>,
    pub lifecycle: SkillLifecycle,
    pub trial_due: Option<String>,
    pub current_version: Option<VersionId>,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetDiscoverySnapshot;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListCustomAgents;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListProjects;

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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetProjectAssemblyPlan {
    pub project_id: crate::ProjectId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppQuery {
    #[serde(rename = "check_application_update")]
    CheckApplicationUpdate(CheckApplicationUpdate),
    #[serde(rename = "get_skill")]
    GetSkill(GetSkill),
    #[serde(rename = "list_skills")]
    ListSkills(ListSkills),
    #[serde(rename = "list_versions")]
    ListVersions(ListVersions),
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
    #[serde(rename = "get_bootstrap_snapshot")]
    GetBootstrapSnapshot,
    #[serde(rename = "list_pending_items")]
    ListPendingItems(ListPendingItems),
    #[serde(rename = "get_discovery_snapshot")]
    GetDiscoverySnapshot(GetDiscoverySnapshot),
    #[serde(rename = "list_custom_agents")]
    ListCustomAgents(ListCustomAgents),
    #[serde(rename = "list_projects")]
    ListProjects(ListProjects),
    #[serde(rename = "list_saved_project_views")]
    ListSavedProjectViews(ListSavedProjectViews),
    #[serde(rename = "analyze_import")]
    AnalyzeImport(AnalyzeImport),
    #[serde(rename = "discover_import_candidates")]
    DiscoverImportCandidates(DiscoverImportCandidates),
    #[serde(rename = "search_online_sources")]
    SearchOnlineSources(SearchOnlineSources),
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
    #[serde(rename = "get_reconcile_plan")]
    GetReconcilePlan(GetReconcilePlan),
    #[serde(rename = "get_removal_impact")]
    GetRemovalImpact(GetRemovalImpact),
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppQueryResult {
    #[serde(rename = "application_update")]
    ApplicationUpdate(ApplicationUpdate),
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
    #[serde(rename = "pending_items")]
    PendingItems(Vec<crate::pending::PendingItem>),
    #[serde(rename = "discovery_snapshot")]
    DiscoverySnapshot(DiscoverySnapshot),
    #[serde(rename = "custom_agents")]
    CustomAgents(Vec<CustomAgent>),
    #[serde(rename = "projects")]
    Projects(Vec<Project>),
    #[serde(rename = "saved_project_views")]
    SavedProjectViews(Vec<SavedProjectView>),
    #[serde(rename = "import_analysis")]
    ImportAnalysis(ImportAnalysis),
    #[serde(rename = "import_candidates")]
    ImportCandidates(Vec<ImportCandidate>),
    #[serde(rename = "source_search_page")]
    SourceSearchPage(SourceSearchPage),
    #[serde(rename = "deployment_plan")]
    DeploymentPlan(DeploymentPlan),
    #[serde(rename = "deployment_targets")]
    DeploymentTargets(Vec<DeploymentTarget>),
    #[serde(rename = "deployments")]
    Deployments(Vec<crate::DeploymentRecord>),
    #[serde(rename = "deployment_relations")]
    DeploymentRelations(Vec<crate::DeploymentRecord>),
    #[serde(rename = "reconcile_plan")]
    ReconcilePlan(crate::ReconcilePlan),
    #[serde(rename = "removal_impact")]
    RemovalImpact(crate::RemovalImpact),
    #[serde(rename = "recovery_candidates")]
    RecoveryCandidates(Vec<crate::RecoveryCandidate>),
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
