use std::borrow::Borrow;
use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::relationship::RelationshipType;
use crate::{AppError, AppResult, DeploymentCapability, ErrorCode, RecoveryAction, Severity};

use super::model::{
    DeploymentMode, DeploymentPlan, DeploymentPlanInput, ExistingDeployment, ExistingOwnership,
    TargetChange, TargetConflict, TargetConflictReason, TargetPlan, VerifiedTarget,
};

/// Pure deployment planner.  It consumes caller-provided discovery and
/// ownership facts and never reads or writes the filesystem or database.
#[derive(Clone, Copy, Debug, Default)]
pub struct DeploymentPlanner;

impl DeploymentPlanner {
    pub fn new() -> Self {
        Self
    }

    /// Plan one Skill version for all selected logical targets.  Physical
    /// targets are merged by their stable id, so one physical path receives at
    /// most one TargetPlan even when several logical clients select it.
    pub fn plan<I>(&self, input: I) -> AppResult<DeploymentPlan>
    where
        I: Borrow<DeploymentPlanInput>,
    {
        let input = input.borrow();
        validate_runtime_name(&input.runtime_name)?;
        enforce_security_gate(input)?;
        if input.targets.is_empty() {
            return Err(invalid_input("at least one verified target is required"));
        }

        let mut selected: BTreeMap<String, Vec<&VerifiedTarget>> = BTreeMap::new();
        for target in &input.targets {
            selected
                .entry(target.physical_target_id().to_owned())
                .or_default()
                .push(target);
        }

        let mut targets = Vec::with_capacity(selected.len());
        let mut warnings = Vec::new();
        let mut conflicts = Vec::new();
        for (physical_id, target_group) in selected {
            let target = target_group
                .first()
                .expect("selected physical target group is not empty");
            let logical_ids = merged_logical_ids(&target_group);
            let existing = merged_existing(&target_group);
            let capabilities = merged_capabilities(&target_group);
            let case_sensitive = target_group.iter().all(|target| target.case_sensitive());
            let prefers_managed_copy = target_group
                .iter()
                .any(|target| matches!(target.source(), super::model::TargetFactSource::Project));
            let mode = select_mode(
                input.mode_override,
                &capabilities,
                prefers_managed_copy,
                &physical_id,
            )?;
            let target_warnings = mode_warnings(mode, &capabilities);
            let target_conflicts = conflicts_for(
                &physical_id,
                target.path(),
                &existing,
                &input.runtime_name,
                input.skill_id,
                &input.version_id,
                case_sensitive,
            );
            conflicts.extend(target_conflicts.iter().cloned());
            warnings.extend(target_warnings.iter().cloned());

            let change = if target_conflicts.is_empty()
                && existing.iter().any(|existing| {
                    is_same_managed_deployment(
                        existing,
                        &input.runtime_name,
                        input.skill_id,
                        &input.version_id,
                        case_sensitive,
                    )
                }) {
                TargetChange::NoOp
            } else {
                TargetChange::Create
            };
            let destination_path = Path::new(target.path())
                .join(&input.runtime_name)
                .to_string_lossy()
                .into_owned();
            targets.push(TargetPlan {
                physical_target_id: physical_id,
                logical_target_ids: logical_ids,
                target_path: target.path().to_owned(),
                destination_path,
                source_path: input.source_path.clone(),
                runtime_name: input.runtime_name.clone(),
                skill_id: input.skill_id,
                version_id: input.version_id.clone(),
                mode,
                change,
                warnings: target_warnings,
                conflicts: target_conflicts,
            });
        }

        if let Some(conflict) = conflicts.first() {
            return Err(conflict_error(conflict, conflicts.len()));
        }

        let mode = targets
            .first()
            .map(|target| target.mode)
            .expect("logical target validation guarantees one target");
        Ok(DeploymentPlan {
            skill_id: input.skill_id,
            version_id: input.version_id.clone(),
            runtime_name: input.runtime_name.clone(),
            mode,
            targets,
            warnings,
            conflicts,
        })
    }

    pub fn plan_request(&self, input: &DeploymentPlanInput) -> AppResult<DeploymentPlan> {
        self.plan(input)
    }
}

fn enforce_security_gate(input: &DeploymentPlanInput) -> AppResult<()> {
    let Some(run) = &input.security_gate.basic_check_run else {
        return Ok(());
    };
    if run.skill_id != input.skill_id
        || run.version_id != input.version_id
        || run.kind != crate::check::CheckKind::Basic
    {
        return Ok(());
    }
    if let Some(finding) = run
        .findings
        .iter()
        .find(|finding| finding.is_actionable() && finding.is_high_risk())
    {
        return Err(
            AppError::new(ErrorCode::SecurityCheckBlocked, Severity::Error)
                .with_param("skill_id", input.skill_id.to_string())
                .with_param("version_id", input.version_id.as_str().to_owned())
                .with_param("finding_id", finding.id.clone())
                .with_param("finding_code", finding.code.clone())
                .with_action(RecoveryAction::ReviewSecurityFindings),
        );
    }
    Ok(())
}

fn merged_logical_ids(targets: &[&VerifiedTarget]) -> Vec<String> {
    let mut ids = targets
        .iter()
        .flat_map(|target| target.logical_target_ids().iter().cloned())
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    ids
}

fn merged_existing(targets: &[&VerifiedTarget]) -> Vec<ExistingDeployment> {
    targets
        .iter()
        .flat_map(|target| target.existing().iter().cloned())
        .collect()
}

fn merged_capabilities(targets: &[&VerifiedTarget]) -> DeploymentCapability {
    DeploymentCapability::new(
        targets.iter().all(|target| target.capabilities().symlink),
        targets.iter().all(|target| target.capabilities().junction),
        targets.iter().all(|target| target.capabilities().copy),
    )
}

fn select_mode(
    override_mode: Option<DeploymentMode>,
    capabilities: &DeploymentCapability,
    prefers_managed_copy: bool,
    physical_target_id: &str,
) -> AppResult<DeploymentMode> {
    let mode = override_mode.or_else(|| {
        if prefers_managed_copy && capabilities.copy {
            Some(DeploymentMode::ManagedCopy)
        } else {
            DeploymentMode::select(capabilities)
        }
    });
    let Some(mode) = mode else {
        return Err(
            AppError::new(ErrorCode::AgentProfileInvalidCapability, Severity::Error)
                .with_param("physical_target_id", physical_target_id.to_owned())
                .with_action(RecoveryAction::InspectTarget),
        );
    };
    if !mode.is_supported_by(capabilities) {
        return Err(
            AppError::new(ErrorCode::AgentProfileInvalidCapability, Severity::Error)
                .with_param("physical_target_id", physical_target_id.to_owned())
                .with_param("requested_mode", mode_code(mode))
                .with_action(RecoveryAction::InspectTarget),
        );
    }
    Ok(mode)
}

fn mode_warnings(mode: DeploymentMode, capabilities: &DeploymentCapability) -> Vec<String> {
    match mode {
        DeploymentMode::SymbolicLink => Vec::new(),
        DeploymentMode::DirectoryJunction => {
            let mut warnings = vec!["deployment.mode.directory_junction".to_owned()];
            if !capabilities.symlink {
                warnings.push("deployment.mode.symbolic_link_unavailable".to_owned());
            }
            warnings
        }
        DeploymentMode::ManagedCopy => {
            let mut warnings = vec!["deployment.mode.managed_copy".to_owned()];
            if !capabilities.symlink {
                warnings.push("deployment.mode.symbolic_link_unavailable".to_owned());
            }
            if !capabilities.junction {
                warnings.push("deployment.mode.directory_junction_unavailable".to_owned());
            }
            warnings
        }
    }
}

fn conflicts_for(
    physical_target_id: &str,
    target_path: &str,
    existing_deployments: &[ExistingDeployment],
    runtime_name: &str,
    skill_id: crate::SkillId,
    version_id: &crate::VersionId,
    case_sensitive: bool,
) -> Vec<TargetConflict> {
    existing_deployments
        .iter()
        .filter(|existing| names_equal(&existing.runtime_name, runtime_name, case_sensitive))
        .filter(|existing| {
            !is_same_managed_deployment(
                existing,
                runtime_name,
                skill_id,
                version_id,
                case_sensitive,
            )
        })
        .filter(|existing| {
            !(existing.ownership == ExistingOwnership::Managed
                && existing.skill_id == Some(skill_id))
        })
        .map(|existing| TargetConflict {
            physical_target_id: physical_target_id.to_owned(),
            target_path: target_path.to_owned(),
            runtime_name: runtime_name.to_owned(),
            reason: match existing.ownership {
                ExistingOwnership::Unknown => TargetConflictReason::OwnershipUnknown,
                ExistingOwnership::Managed => TargetConflictReason::ManagedByAnotherSkill,
                ExistingOwnership::AgentBuiltin
                | ExistingOwnership::Plugin
                | ExistingOwnership::OtherTool => TargetConflictReason::RuntimeNameAlreadyExists,
            },
            existing_ownership: existing.ownership.clone(),
        })
        .collect()
}

fn is_same_managed_deployment(
    existing: &ExistingDeployment,
    runtime_name: &str,
    skill_id: crate::SkillId,
    version_id: &crate::VersionId,
    case_sensitive: bool,
) -> bool {
    existing.ownership == ExistingOwnership::Managed
        && names_equal(&existing.runtime_name, runtime_name, case_sensitive)
        && existing.skill_id == Some(skill_id)
        && existing.version_id.as_ref() == Some(version_id)
}

fn names_equal(left: &str, right: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        left == right
    } else {
        left.eq_ignore_ascii_case(right)
    }
}

fn validate_runtime_name(value: &str) -> AppResult<()> {
    if value.trim().is_empty()
        || value == "."
        || value == ".."
        || value.contains('\0')
        || value.contains('/')
        || value.contains('\\')
        || value.contains(':')
    {
        return Err(invalid_input(
            "runtime name must be one safe path component",
        ));
    }
    Ok(())
}

fn conflict_error(conflict: &TargetConflict, count: usize) -> AppError {
    AppError::new(ErrorCode::TargetExists, Severity::Error)
        .with_param("physical_target_id", conflict.physical_target_id.clone())
        .with_param("target_path", conflict.target_path.clone())
        .with_param("runtime_name", conflict.runtime_name.clone())
        .with_param("conflict_count", count as u64)
        .with_action(RecoveryAction::ChooseAnotherName)
        .with_action(RecoveryAction::InspectTarget)
}

fn invalid_input(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Acknowledge)
}

// ---------------------------------------------------------------------------
// Task 6: deterministic copy / shared-reference -> managed-link conversion.
// The plan is pure and decides only facts: which technical link form the
// platform supports, whether shared impact needs explicit confirmation, and
// when a conversion must be refused instead of silently degrading to a copy.
// ---------------------------------------------------------------------------

/// Deterministic input facts for planning one relation conversion.  The
/// caller supplies the probed platform capabilities and shared-consumer
/// counts; this planner never touches the filesystem.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelationConversionFacts {
    pub relationship: RelationshipType,
    /// Link capabilities probed where the replacement entry will be created.
    pub link_capabilities: DeploymentCapability,
    /// `false` when the relation entry and the central-library target live on
    /// volumes the selected link kind cannot span.
    pub link_target_same_volume: bool,
    /// Other active relations that still consume the shared body this entry
    /// points at.
    pub other_shared_consumers: usize,
}

/// The deterministic part of a conversion decision.  Filesystem effects,
/// backups and journaling stay in the application layer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelationConversionPlan {
    /// Technical link form chosen from the probed capabilities via
    /// `DeploymentMode::select`.  It is never `ManagedCopy`: a conversion that
    /// cannot link must fail and keep the original entry instead of replacing
    /// it with a copy.
    pub mode: DeploymentMode,
    /// The shared directory body is never cleaned by a conversion, no matter
    /// how many consumers remain.
    pub keeps_shared_body: bool,
    /// Shared impact requires an explicit user confirmation before commit.
    pub requires_shared_impact_confirmation: bool,
    pub warnings: Vec<String>,
}

/// Plans one observed-copy or shared-reference conversion into a SkillHub
/// managed link.
pub fn plan_relation_conversion(
    facts: &RelationConversionFacts,
) -> AppResult<RelationConversionPlan> {
    if !matches!(
        facts.relationship,
        RelationshipType::ObservedCopy
            | RelationshipType::ManagedCopy
            | RelationshipType::ObservedLink
            | RelationshipType::ManagedLink
            | RelationshipType::SharedDirectoryReference
    ) {
        // A direct shared-directory read has no per-agent entry to replace,
        // and everything else is not a deployment entry at all.  Converting
        // it would have to rewrite the shared body, which only an explicit
        // governance decision may ever do.
        return Err(conversion_not_convertible(facts.relationship));
    }

    // DeploymentMode::select owns the platform decision; a conversion only
    // refuses the copy fallback instead of accepting it.
    let mode = match DeploymentMode::select(&facts.link_capabilities) {
        Some(DeploymentMode::ManagedCopy) | None => {
            return Err(link_unavailable());
        }
        Some(mode) => mode,
    };
    if mode == DeploymentMode::DirectoryJunction && !facts.link_target_same_volume {
        return Err(junction_cannot_span_volumes());
    }

    let shared = matches!(
        facts.relationship,
        RelationshipType::SharedDirectoryReference
    );
    let mut warnings = Vec::new();
    if shared {
        warnings.push("relationship.conversion.shared_body_kept".to_owned());
    }
    Ok(RelationConversionPlan {
        mode,
        keeps_shared_body: true,
        requires_shared_impact_confirmation: shared && facts.other_shared_consumers > 0,
        warnings,
    })
}

fn conversion_not_convertible(relationship: RelationshipType) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Warning)
        .with_param(
            "detail",
            format!(
                "relationship type {:?} has no convertible entry; record a governance task instead",
                relationship
            ),
        )
        .with_action(RecoveryAction::Acknowledge)
}

fn link_unavailable() -> AppError {
    AppError::new(ErrorCode::SymlinkNotSupported, Severity::Warning)
        .with_param(
            "detail",
            "link creation is unavailable at the relation location; conversion keeps the original entry instead of replacing it with a copy",
        )
        .with_action(RecoveryAction::OpenReadOnly)
}

fn junction_cannot_span_volumes() -> AppError {
    AppError::new(ErrorCode::JunctionNotSupported, Severity::Warning)
        .with_param(
            "detail",
            "the selected directory-junction link form cannot span the two volumes; conversion keeps the original entry instead of replacing it with a copy",
        )
        .with_action(RecoveryAction::OpenReadOnly)
}

fn mode_code(mode: DeploymentMode) -> &'static str {
    match mode {
        DeploymentMode::SymbolicLink => "symbolic_link",
        DeploymentMode::DirectoryJunction => "directory_junction",
        DeploymentMode::ManagedCopy => "managed_copy",
    }
}

// ---------------------------------------------------------------------------
// Task 13A: preference -> pair disposition.  The automatic planner above
// stays authoritative for which mode a physical target gets; this layer only
// turns user preference plus occupancy facts into a structured disposition
// and a confirmation fingerprint.  Facts carry no pair id and no batch or
// revision counter: pair ids are UI identity, never a confirmation credential.
// ---------------------------------------------------------------------------

/// User-facing preference for how one Skill should land on one target.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentPreference {
    /// Keep the existing per-target automatic mode selection.
    Automatic,
    /// A directory link is required; a copy is only a user-confirmed
    /// fallback, never an automatic substitute.
    Link,
    /// An isolated managed copy is required.
    Copy,
}

/// What the backend proposes for one Skill × target pair.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentPreviewDisposition {
    /// Execute the selected mode without further confirmation.
    SelectedMode,
    /// The link preference cannot link; a managed copy is offered for
    /// explicit confirmation.
    RecommendCopy,
    /// The same managed deployment is already in place.
    NoChange,
    /// The pair cannot execute; `block_reason` carries the structured cause.
    Blocked,
}

/// Structured, user-presentable cause for a blocked or re-planned pair.
/// Users see words, never OS messages: the raw OS detail stays in technical
/// parameters carried beside the plan.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentBlockReason {
    /// The account may not create directory links.
    LinkPermissionUnavailable,
    /// The filesystem or volume cannot host directory links.
    LinkFilesystemUnsupported,
    /// Another entry owns the runtime name at the destination.
    TargetOccupied,
    /// The registered target path is not currently reachable.
    PathUnavailable,
    /// Other agents read this shared directory; deployment needs an
    /// explicit shared-impact decision first.
    SharedImpactRequiresResolution,
    /// No deployment form, not even a managed copy, is executable.
    CopyUnavailable,
}

/// Resolved facts for one Skill × physical-target pair, gathered by the
/// application layer from verified targets, occupancy records and capability
/// probes.  The preview decision itself stays pure.
///
/// The struct deliberately carries no pair id: pair ids are UI identity
/// assigned over this immutable fact set, never a confirmation credential.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentPairFacts {
    pub skill_id: crate::SkillId,
    pub version_id: crate::VersionId,
    pub runtime_name: String,
    pub physical_target_id: String,
    pub destination_path: String,
    pub capabilities: DeploymentCapability,
    /// `true` when link creation fails because the account lacks the
    /// privilege; `false` when the filesystem itself cannot host links.
    pub link_permission_denied: bool,
    pub preference: DeploymentPreference,
    /// Mode the automatic planner selected for this target, if any.
    pub mode: Option<DeploymentMode>,
    pub change: TargetChange,
    pub conflicts: Vec<TargetConflict>,
    /// Occupancy snapshot of the destination at preview time.
    pub occupancy: Vec<ExistingDeployment>,
    pub path_available: bool,
    /// Other agents read this shared directory and the shared-impact
    /// decision is still outstanding.
    pub requires_shared_impact_confirmation: bool,
}

/// The preview decision for one pair.  Executable pairs still end up in a
/// backend-assembled [`DeploymentPlan`]; a preview never authorizes the
/// client to submit one.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PairPreview {
    pub preference: DeploymentPreference,
    pub disposition: DeploymentPreviewDisposition,
    /// Mode to execute for selected and unchanged pairs.
    pub mode: Option<DeploymentMode>,
    /// Copy mode a recommend-copy pair falls back to once confirmed.
    pub fallback_mode: Option<DeploymentMode>,
    pub block_reason: Option<DeploymentBlockReason>,
    /// Server-computed confirmation credential over every deployment fact
    /// and the decision itself.  Recomputed at commit time; a stale or
    /// forged value is rejected instead of trusted.
    pub confirmation_fingerprint: String,
}

/// Decides one pair's disposition from resolved facts.  Blocking facts are
/// decided in a fixed order — reachability, occupancy, shared impact — so
/// stacked causes always surface the same reason.
pub fn plan_target_preview(facts: &DeploymentPairFacts) -> PairPreview {
    if !facts.path_available {
        return preview_with_fingerprint(facts, blocked(DeploymentBlockReason::PathUnavailable));
    }
    if !facts.conflicts.is_empty() {
        return preview_with_fingerprint(facts, blocked(DeploymentBlockReason::TargetOccupied));
    }
    if facts.requires_shared_impact_confirmation {
        return preview_with_fingerprint(
            facts,
            blocked(DeploymentBlockReason::SharedImpactRequiresResolution),
        );
    }

    let link_unavailable_reason = if facts.link_permission_denied {
        DeploymentBlockReason::LinkPermissionUnavailable
    } else {
        DeploymentBlockReason::LinkFilesystemUnsupported
    };
    let mut preview = match facts.preference {
        DeploymentPreference::Automatic => match facts
            .mode
            .or_else(|| DeploymentMode::select(&facts.capabilities))
        {
            Some(mode) => PairPreview {
                preference: facts.preference,
                disposition: DeploymentPreviewDisposition::SelectedMode,
                mode: Some(mode),
                fallback_mode: None,
                block_reason: None,
                confirmation_fingerprint: String::new(),
            },
            None => blocked(DeploymentBlockReason::CopyUnavailable),
        },
        DeploymentPreference::Link => match link_mode(&facts.capabilities) {
            Some(mode) => PairPreview {
                preference: facts.preference,
                disposition: DeploymentPreviewDisposition::SelectedMode,
                mode: Some(mode),
                fallback_mode: None,
                block_reason: None,
                confirmation_fingerprint: String::new(),
            },
            None if facts.capabilities.copy => PairPreview {
                preference: facts.preference,
                disposition: DeploymentPreviewDisposition::RecommendCopy,
                mode: None,
                fallback_mode: Some(DeploymentMode::ManagedCopy),
                block_reason: Some(link_unavailable_reason),
                confirmation_fingerprint: String::new(),
            },
            None => blocked(link_unavailable_reason),
        },
        DeploymentPreference::Copy => {
            if facts.capabilities.copy {
                PairPreview {
                    preference: facts.preference,
                    disposition: DeploymentPreviewDisposition::SelectedMode,
                    mode: Some(DeploymentMode::ManagedCopy),
                    fallback_mode: None,
                    block_reason: None,
                    confirmation_fingerprint: String::new(),
                }
            } else {
                blocked(DeploymentBlockReason::CopyUnavailable)
            }
        }
    };

    // A NoOp outcome outranks mode selection: the same managed deployment is
    // already in place whatever the preference resolves to.
    if facts.change == TargetChange::NoOp {
        preview.disposition = DeploymentPreviewDisposition::NoChange;
        preview.mode = facts.mode;
        preview.fallback_mode = None;
        preview.block_reason = None;
    }
    preview_with_fingerprint(facts, preview)
}

/// The directory link form the capabilities support, or `None` when only a
/// copy (or nothing) is available.  A link preference never accepts the
/// managed-copy result of [`DeploymentMode::select`].
fn link_mode(capabilities: &DeploymentCapability) -> Option<DeploymentMode> {
    match DeploymentMode::select(capabilities) {
        Some(DeploymentMode::ManagedCopy) | None => None,
        Some(mode) => Some(mode),
    }
}

fn blocked(reason: DeploymentBlockReason) -> PairPreview {
    PairPreview {
        preference: DeploymentPreference::Automatic,
        disposition: DeploymentPreviewDisposition::Blocked,
        mode: None,
        fallback_mode: None,
        block_reason: Some(reason),
        confirmation_fingerprint: String::new(),
    }
}

fn preview_with_fingerprint(facts: &DeploymentPairFacts, mut preview: PairPreview) -> PairPreview {
    preview.preference = facts.preference;
    preview.confirmation_fingerprint = confirmation_fingerprint(facts, &preview);
    preview
}

/// Binds every deployment fact plus the decision itself into one credential.
/// Any change to skill, version, runtime name, physical target, destination,
/// preference, outcome, occupancy snapshot or capability invalidates it, and
/// nothing that varies independently of these facts (pair ids, batch order,
/// relationship revisions) can enter.
fn confirmation_fingerprint(facts: &DeploymentPairFacts, preview: &PairPreview) -> String {
    let mut canonical = String::from("deployment-confirmation-v1\n");
    canonical.push_str(facts.skill_id.to_string().as_str());
    canonical.push('\n');
    canonical.push_str(facts.version_id.as_str());
    canonical.push('\n');
    canonical.push_str(&facts.runtime_name);
    canonical.push('\n');
    canonical.push_str(&facts.physical_target_id);
    canonical.push('\n');
    canonical.push_str(&facts.destination_path);
    canonical.push('\n');
    canonical.push_str(&format!(
        "links:{}/{}/{} permission_denied:{}\n",
        facts.capabilities.symlink as u8,
        facts.capabilities.junction as u8,
        facts.capabilities.copy as u8,
        facts.link_permission_denied as u8
    ));
    canonical.push_str(preference_word(facts.preference));
    canonical.push('\n');
    canonical.push_str(change_word(facts.change));
    canonical.push('\n');

    let mut conflicts = facts
        .conflicts
        .iter()
        .map(|conflict| {
            format!(
                "{}|{}|{}|{}",
                conflict.physical_target_id,
                conflict_reason_word(&conflict.reason),
                ownership_word(&conflict.existing_ownership),
                conflict.runtime_name
            )
        })
        .collect::<Vec<_>>();
    conflicts.sort();
    canonical.push_str(&format!("conflicts:{}\n", conflicts.join(";")));

    let mut occupancy = facts
        .occupancy
        .iter()
        .map(|existing| {
            format!(
                "{}|{}|{}|{}",
                existing.runtime_name,
                ownership_word(&existing.ownership),
                existing
                    .skill_id
                    .as_ref()
                    .map(|skill_id| skill_id.to_string())
                    .unwrap_or_else(|| "-".into()),
                existing
                    .version_id
                    .as_ref()
                    .map(|version_id| version_id.as_str().to_owned())
                    .unwrap_or_else(|| "-".into()),
            )
        })
        .collect::<Vec<_>>();
    occupancy.sort();
    canonical.push_str(&format!("occupancy:{}\n", occupancy.join(";")));

    canonical.push_str(&format!("path_available:{}\n", facts.path_available as u8));
    canonical.push_str(&format!(
        "shared_impact_outstanding:{}\n",
        facts.requires_shared_impact_confirmation as u8
    ));

    canonical.push_str(disposition_word(preview.disposition));
    canonical.push('\n');
    canonical.push_str(&format!(
        "mode:{}\n",
        preview.mode.map(mode_code).unwrap_or("-")
    ));
    canonical.push_str(&format!(
        "fallback:{}\n",
        preview.fallback_mode.map(mode_code).unwrap_or("-")
    ));
    canonical.push_str(&format!(
        "reason:{}\n",
        preview.block_reason.map(block_reason_word).unwrap_or("-")
    ));

    format!("sha256:{:x}", Sha256::digest(canonical.as_bytes()))
}

fn preference_word(preference: DeploymentPreference) -> &'static str {
    match preference {
        DeploymentPreference::Automatic => "automatic",
        DeploymentPreference::Link => "link",
        DeploymentPreference::Copy => "copy",
    }
}

fn disposition_word(disposition: DeploymentPreviewDisposition) -> &'static str {
    match disposition {
        DeploymentPreviewDisposition::SelectedMode => "selected_mode",
        DeploymentPreviewDisposition::RecommendCopy => "recommend_copy",
        DeploymentPreviewDisposition::NoChange => "no_change",
        DeploymentPreviewDisposition::Blocked => "blocked",
    }
}

fn block_reason_word(reason: DeploymentBlockReason) -> &'static str {
    match reason {
        DeploymentBlockReason::LinkPermissionUnavailable => "link_permission_unavailable",
        DeploymentBlockReason::LinkFilesystemUnsupported => "link_filesystem_unsupported",
        DeploymentBlockReason::TargetOccupied => "target_occupied",
        DeploymentBlockReason::PathUnavailable => "path_unavailable",
        DeploymentBlockReason::SharedImpactRequiresResolution => {
            "shared_impact_requires_resolution"
        }
        DeploymentBlockReason::CopyUnavailable => "copy_unavailable",
    }
}

fn change_word(change: TargetChange) -> &'static str {
    match change {
        TargetChange::Create => "create",
        TargetChange::NoOp => "no_op",
    }
}

fn conflict_reason_word(reason: &TargetConflictReason) -> &'static str {
    match reason {
        TargetConflictReason::RuntimeNameAlreadyExists => "runtime_name_already_exists",
        TargetConflictReason::OwnershipUnknown => "ownership_unknown",
        TargetConflictReason::ManagedByAnotherSkill => "managed_by_another_skill",
    }
}

fn ownership_word(ownership: &ExistingOwnership) -> &'static str {
    match ownership {
        ExistingOwnership::Managed => "managed",
        ExistingOwnership::Unknown => "unknown",
        ExistingOwnership::AgentBuiltin => "agent_builtin",
        ExistingOwnership::Plugin => "plugin",
        ExistingOwnership::OtherTool => "other_tool",
    }
}
