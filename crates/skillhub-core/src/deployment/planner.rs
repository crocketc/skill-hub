use std::borrow::Borrow;
use std::collections::BTreeMap;
use std::path::Path;

use crate::{AppError, AppResult, DeploymentCapability, ErrorCode, RecoveryAction, Severity};

use super::model::{
    DeploymentMode, DeploymentPlan, DeploymentPlanInput, ExistingDeployment, ExistingOwnership,
    PhysicalTargetInput, TargetChange, TargetConflict, TargetConflictReason, TargetPlan,
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
        if input.logical_targets.is_empty() {
            return Err(invalid_input("at least one logical target is required"));
        }

        let physical = index_physical_targets(&input.physical_targets)?;
        let mut selected: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for logical in &input.logical_targets {
            if logical.id.trim().is_empty() {
                return Err(invalid_input("logical target id is required"));
            }
            if !physical.contains_key(&logical.physical_target_id) {
                return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("physical_target_id", logical.physical_target_id.clone())
                    .with_action(RecoveryAction::InspectTarget));
            }
            selected
                .entry(logical.physical_target_id.clone())
                .or_default()
                .push(logical.id.clone());
        }

        let mut targets = Vec::with_capacity(selected.len());
        let mut warnings = Vec::new();
        let mut conflicts = Vec::new();
        for (physical_id, logical_ids) in selected {
            let target = physical
                .get(&physical_id)
                .expect("selected physical target was indexed above");
            let mode = select_mode(input.mode_override, &target.capabilities, &physical_id)?;
            let target_warnings = mode_warnings(mode, &target.capabilities);
            let target_conflicts = conflicts_for(
                target,
                &input.runtime_name,
                input.skill_id,
                &input.version_id,
            );
            conflicts.extend(target_conflicts.iter().cloned());
            warnings.extend(target_warnings.iter().cloned());

            let change = if target_conflicts.is_empty()
                && target.existing.iter().any(|existing| {
                    is_same_managed_deployment(
                        existing,
                        &input.runtime_name,
                        input.skill_id,
                        &input.version_id,
                        target.case_sensitive,
                    )
                }) {
                TargetChange::NoOp
            } else {
                TargetChange::Create
            };
            let destination_path = Path::new(&target.path)
                .join(&input.runtime_name)
                .to_string_lossy()
                .into_owned();
            targets.push(TargetPlan {
                physical_target_id: physical_id,
                logical_target_ids: logical_ids,
                target_path: target.path.clone(),
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

fn index_physical_targets(
    targets: &[PhysicalTargetInput],
) -> AppResult<BTreeMap<String, &PhysicalTargetInput>> {
    let mut indexed = BTreeMap::new();
    for target in targets {
        if target.id.trim().is_empty() || target.path.trim().is_empty() {
            return Err(invalid_input("physical target id and path are required"));
        }
        if indexed.insert(target.id.clone(), target).is_some() {
            return Err(invalid_input("physical target ids must be unique"));
        }
    }
    Ok(indexed)
}

fn select_mode(
    override_mode: Option<DeploymentMode>,
    capabilities: &DeploymentCapability,
    physical_target_id: &str,
) -> AppResult<DeploymentMode> {
    let mode = override_mode.or_else(|| DeploymentMode::select(capabilities));
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
    target: &PhysicalTargetInput,
    runtime_name: &str,
    skill_id: crate::SkillId,
    version_id: &crate::VersionId,
) -> Vec<TargetConflict> {
    target
        .existing
        .iter()
        .filter(|existing| names_equal(&existing.runtime_name, runtime_name, target.case_sensitive))
        .filter(|existing| {
            !is_same_managed_deployment(
                existing,
                runtime_name,
                skill_id,
                version_id,
                target.case_sensitive,
            )
        })
        .filter(|existing| {
            !(existing.ownership == ExistingOwnership::Managed
                && existing.skill_id == Some(skill_id))
        })
        .map(|existing| TargetConflict {
            physical_target_id: target.id.clone(),
            target_path: target.path.clone(),
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

fn mode_code(mode: DeploymentMode) -> &'static str {
    match mode {
        DeploymentMode::SymbolicLink => "symbolic_link",
        DeploymentMode::DirectoryJunction => "directory_junction",
        DeploymentMode::ManagedCopy => "managed_copy",
    }
}
