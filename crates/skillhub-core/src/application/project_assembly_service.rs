use std::collections::HashMap;
use std::sync::Mutex;

use crate::{
    AppError, AppResult, AssemblyChoice, AssemblyConflictKind, AssemblyItemPlan,
    AssemblyItemStatus, AssemblyPlan, CheckPreparation, CheckPreparationPort,
    DeploymentPreparation, DeploymentPreparationPort, ErrorCode, OperationId, ProjectId,
    RecoveryAction, Severity, SkillResolution, SkillResolutionPort, SourcePreparation,
    SourcePreparationPort,
};

pub struct ProjectAssemblyService<R, S, C, D> {
    pub resolution: R,
    pub source: S,
    pub check: C,
    pub deployment: D,
    committed_plans: Mutex<HashMap<OperationId, AssemblyPlan>>,
}

impl<R, S, C, D> ProjectAssemblyService<R, S, C, D>
where
    R: SkillResolutionPort,
    S: SourcePreparationPort,
    C: CheckPreparationPort,
    D: DeploymentPreparationPort,
{
    pub fn new(resolution: R, source: S, check: C, deployment: D) -> Self {
        Self {
            resolution,
            source,
            check,
            deployment,
            committed_plans: Mutex::new(HashMap::new()),
        }
    }

    pub fn prepare_assembly(&self, project_id: ProjectId) -> AppResult<AssemblyPlan> {
        let config = self.resolution.shared_config(project_id)?;
        let mut items = Vec::with_capacity(config.required_skills.len());
        for requirement in config.required_skills {
            let item = match self.resolution.resolve_requirement(&requirement) {
                Err(error) => AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                    .with_reasons(vec![error.code.as_str().to_owned()]),
                Ok(resolution) => match resolution {
                    SkillResolution::Satisfied { version_id } => {
                        AssemblyItemPlan::new(requirement, AssemblyItemStatus::AlreadySatisfied)
                            .with_version(version_id)
                    }
                    SkillResolution::Missing { .. } => {
                        match self.prepare_missing_requirement(requirement.clone()) {
                            Ok(item) => item,
                            Err(error) => {
                                AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                                    .with_reasons(vec![error.code.as_str().to_owned()])
                            }
                        }
                    }
                    SkillResolution::Conflict { reasons } => {
                        let kind = AssemblyConflictKind::from_reasons(&reasons);
                        AssemblyItemPlan::new(requirement, AssemblyItemStatus::ConflictNeedsChoice)
                            .with_reasons(reasons)
                            .with_conflict(kind, kind.allowed_choices().to_vec())
                    }
                    SkillResolution::Failed { reasons } => {
                        AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                            .with_reasons(reasons)
                    }
                },
            };
            items.push(item);
        }
        Ok(AssemblyPlan::new(project_id, items))
    }

    pub fn commit_assembly(&self, plan: AssemblyPlan) -> AppResult<AssemblyPlan> {
        if plan.committed {
            return Ok(plan);
        }
        {
            let committed = self.committed_plans.lock().map_err(|_| internal_error())?;
            if let Some(previous) = committed.get(&plan.operation_id) {
                return Ok(previous.clone());
            }
        }

        // Validate the complete request before touching the deployment port. This keeps a
        // missing or invalid choice from leaving a partially applied project assembly.
        self.validate_choices(&plan)?;
        let mut result = plan.clone();
        for item in &mut result.items {
            match item.status {
                AssemblyItemStatus::AlreadySatisfied
                | AssemblyItemStatus::Skipped
                | AssemblyItemStatus::Failed
                | AssemblyItemStatus::Succeeded => {}
                AssemblyItemStatus::ConflictNeedsChoice => match item.choice {
                    Some(AssemblyChoice::Skip) => item.status = AssemblyItemStatus::Skipped,
                    Some(AssemblyChoice::UseExisting) => {
                        item.status = AssemblyItemStatus::Succeeded;
                    }
                    Some(AssemblyChoice::Acquire) => {
                        self.commit_ready_item(item)?;
                    }
                    None => unreachable!("validated assembly choice"),
                },
                AssemblyItemStatus::ReadyToAcquire => {
                    if item.choice == Some(AssemblyChoice::Skip) {
                        item.status = AssemblyItemStatus::Skipped;
                        continue;
                    }
                    self.commit_ready_item(item)?;
                }
            }
        }
        result.committed = true;
        self.committed_plans
            .lock()
            .map_err(|_| internal_error())?
            .insert(result.operation_id, result.clone());
        Ok(result)
    }

    fn validate_choices(&self, plan: &AssemblyPlan) -> AppResult<()> {
        for item in &plan.items {
            match item.status {
                AssemblyItemStatus::ConflictNeedsChoice => {
                    let Some(kind) = item.conflict_kind else {
                        return Err(conflict("assembly conflict kind is missing"));
                    };
                    let Some(choice) = item.choice else {
                        return Err(conflict("assembly choice is required"));
                    };
                    let allowed = if item.allowed_choices.is_empty() {
                        kind.allowed_choices()
                    } else {
                        item.allowed_choices.as_slice()
                    };
                    if !allowed.contains(&choice) {
                        return Err(conflict(format!(
                            "assembly choice is not allowed for {:?}",
                            kind
                        )));
                    }
                    if matches!(
                        (kind, choice),
                        (
                            AssemblyConflictKind::SourceAmbiguity,
                            AssemblyChoice::Acquire
                        ) | (
                            AssemblyConflictKind::SourceAmbiguity,
                            AssemblyChoice::UseExisting
                        ) | (
                            AssemblyConflictKind::SameNameConflict,
                            AssemblyChoice::Acquire
                        ) | (
                            AssemblyConflictKind::HighRiskFinding,
                            AssemblyChoice::UseExisting
                        ) | (
                            AssemblyConflictKind::DeploymentTargetConflict,
                            AssemblyChoice::Acquire
                        )
                    ) {
                        return Err(conflict("assembly choice cannot resolve this conflict"));
                    }
                    if choice == AssemblyChoice::Acquire && item.version_id.is_none() {
                        return Err(conflict("assembly.version_missing"));
                    }
                }
                AssemblyItemStatus::ReadyToAcquire
                    if item.choice == Some(AssemblyChoice::UseExisting) =>
                {
                    return Err(conflict(
                        "use_existing is only valid for an existing-target conflict",
                    ));
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn commit_ready_item(&self, item: &mut AssemblyItemPlan) -> AppResult<()> {
        let Some(version_id) = item.version_id.clone() else {
            item.status = AssemblyItemStatus::Failed;
            item.reasons.push("assembly.version_missing".to_owned());
            return Ok(());
        };
        if let Err(error) = self
            .deployment
            .commit_project_deployment(&item.requirement, &version_id)
        {
            item.status = AssemblyItemStatus::Failed;
            item.reasons.push(error.code.as_str().to_owned());
        } else {
            item.status = AssemblyItemStatus::Succeeded;
        }
        Ok(())
    }

    fn prepare_missing_requirement(
        &self,
        requirement: crate::SharedSkillRequirement,
    ) -> AppResult<AssemblyItemPlan> {
        let version_id = match self.source.prepare_source(&requirement) {
            Err(error) => {
                return Ok(
                    AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                        .with_reasons(vec![error.code.as_str().to_owned()]),
                );
            }
            Ok(preparation) => match preparation {
                SourcePreparation::NotNeeded => requirement.version_id.clone(),
                SourcePreparation::Ready { version_id } => Some(version_id),
                SourcePreparation::Conflict { reasons } => {
                    let kind = AssemblyConflictKind::SourceAmbiguity;
                    return Ok(AssemblyItemPlan::new(
                        requirement,
                        AssemblyItemStatus::ConflictNeedsChoice,
                    )
                    .with_reasons(reasons)
                    .with_conflict(kind, kind.allowed_choices().to_vec()));
                }
                SourcePreparation::Failed { reasons } => {
                    return Ok(
                        AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                            .with_reasons(reasons),
                    );
                }
            },
        };
        let Some(version_id) = version_id else {
            return Ok(
                AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                    .with_reasons(vec!["assembly.version_missing".to_owned()]),
            );
        };
        match self.check.prepare_checks(&requirement, &version_id) {
            Err(error) => {
                return Ok(
                    AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                        .with_version(version_id)
                        .with_reasons(vec![error.code.as_str().to_owned()]),
                );
            }
            Ok(preparation) => match preparation {
                CheckPreparation::NotNeeded | CheckPreparation::Passed => {}
                CheckPreparation::HighRiskNeedsChoice { reasons } => {
                    let kind = AssemblyConflictKind::HighRiskFinding;
                    return Ok(AssemblyItemPlan::new(
                        requirement,
                        AssemblyItemStatus::ConflictNeedsChoice,
                    )
                    .with_version(version_id)
                    .with_reasons(reasons)
                    .with_conflict(kind, kind.allowed_choices().to_vec()));
                }
                CheckPreparation::Failed { reasons } => {
                    return Ok(
                        AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                            .with_version(version_id)
                            .with_reasons(reasons),
                    );
                }
            },
        };
        match self
            .deployment
            .prepare_project_deployment(&requirement, &version_id)
        {
            Err(error) => Ok(
                AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                    .with_version(version_id)
                    .with_reasons(vec![error.code.as_str().to_owned()]),
            ),
            Ok(preparation) => match preparation {
                DeploymentPreparation::NotNeeded | DeploymentPreparation::Ready => Ok(
                    AssemblyItemPlan::new(requirement, AssemblyItemStatus::ReadyToAcquire)
                        .with_version(version_id),
                ),
                DeploymentPreparation::Conflict { reasons } => Ok(AssemblyItemPlan::new(
                    requirement,
                    AssemblyItemStatus::ConflictNeedsChoice,
                )
                .with_version(version_id)
                .with_reasons(reasons.clone())
                .with_conflict(
                    AssemblyConflictKind::from_reasons(&reasons),
                    AssemblyConflictKind::from_reasons(&reasons)
                        .allowed_choices()
                        .to_vec(),
                )),
                DeploymentPreparation::Failed { reasons } => Ok(AssemblyItemPlan::new(
                    requirement,
                    AssemblyItemStatus::Failed,
                )
                .with_version(version_id)
                .with_reasons(reasons)),
            },
        }
    }
}

fn internal_error() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
}

fn conflict(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Acknowledge)
}
