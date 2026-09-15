use std::borrow::Borrow;
use std::collections::BTreeMap;
use std::path::Path;

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
