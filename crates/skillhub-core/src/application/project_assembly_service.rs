use crate::{
    AppError, AppResult, AssemblyChoice, AssemblyItemPlan, AssemblyItemStatus, AssemblyPlan,
    CheckPreparation, CheckPreparationPort, DeploymentPreparation, DeploymentPreparationPort,
    ErrorCode, ProjectId, RecoveryAction, Severity, SkillResolution, SkillResolutionPort,
    SourcePreparation, SourcePreparationPort,
};

pub struct ProjectAssemblyService<R, S, C, D> {
    pub resolution: R,
    pub source: S,
    pub check: C,
    pub deployment: D,
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
        }
    }

    pub fn prepare_assembly(&self, project_id: ProjectId) -> AppResult<AssemblyPlan> {
        let config = self.resolution.shared_config(project_id)?;
        let mut items = Vec::with_capacity(config.required_skills.len());
        for requirement in config.required_skills {
            let item = match self.resolution.resolve_requirement(&requirement)? {
                SkillResolution::Satisfied { version_id } => {
                    AssemblyItemPlan::new(requirement, AssemblyItemStatus::AlreadySatisfied)
                        .with_version(version_id)
                }
                SkillResolution::Missing { .. } => self.prepare_missing_requirement(requirement)?,
                SkillResolution::Conflict { reasons } => {
                    AssemblyItemPlan::new(requirement, AssemblyItemStatus::ConflictNeedsChoice)
                        .with_reasons(reasons)
                }
                SkillResolution::Failed { reasons } => {
                    AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                        .with_reasons(reasons)
                }
            };
            items.push(item);
        }
        Ok(AssemblyPlan::new(project_id, items))
    }

    pub fn commit_assembly(&self, plan: AssemblyPlan) -> AppResult<AssemblyPlan> {
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
                    Some(AssemblyChoice::Acquire) | None => {
                        return Err(conflict("assembly choice is required"));
                    }
                },
                AssemblyItemStatus::ReadyToAcquire => {
                    if item.choice == Some(AssemblyChoice::Skip) {
                        item.status = AssemblyItemStatus::Skipped;
                        continue;
                    }
                    let Some(version_id) = item.version_id.clone() else {
                        item.status = AssemblyItemStatus::Failed;
                        item.reasons.push("assembly.version_missing".to_owned());
                        continue;
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
                }
            }
        }
        Ok(result)
    }

    fn prepare_missing_requirement(
        &self,
        requirement: crate::SharedSkillRequirement,
    ) -> AppResult<AssemblyItemPlan> {
        let version_id = match self.source.prepare_source(&requirement)? {
            SourcePreparation::NotNeeded => requirement.version_id.clone(),
            SourcePreparation::Ready { version_id } => Some(version_id),
            SourcePreparation::Conflict { reasons } => {
                return Ok(AssemblyItemPlan::new(
                    requirement,
                    AssemblyItemStatus::ConflictNeedsChoice,
                )
                .with_reasons(reasons));
            }
            SourcePreparation::Failed { reasons } => {
                return Ok(
                    AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                        .with_reasons(reasons),
                );
            }
        };
        let Some(version_id) = version_id else {
            return Ok(
                AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                    .with_reasons(vec!["assembly.version_missing".to_owned()]),
            );
        };
        match self.check.prepare_checks(&requirement, &version_id)? {
            CheckPreparation::NotNeeded | CheckPreparation::Passed => {}
            CheckPreparation::HighRiskNeedsChoice { reasons } => {
                return Ok(AssemblyItemPlan::new(
                    requirement,
                    AssemblyItemStatus::ConflictNeedsChoice,
                )
                .with_version(version_id)
                .with_reasons(reasons));
            }
            CheckPreparation::Failed { reasons } => {
                return Ok(
                    AssemblyItemPlan::new(requirement, AssemblyItemStatus::Failed)
                        .with_version(version_id)
                        .with_reasons(reasons),
                );
            }
        }
        match self
            .deployment
            .prepare_project_deployment(&requirement, &version_id)?
        {
            DeploymentPreparation::NotNeeded | DeploymentPreparation::Ready => Ok(
                AssemblyItemPlan::new(requirement, AssemblyItemStatus::ReadyToAcquire)
                    .with_version(version_id),
            ),
            DeploymentPreparation::Conflict { reasons } => Ok(AssemblyItemPlan::new(
                requirement,
                AssemblyItemStatus::ConflictNeedsChoice,
            )
            .with_version(version_id)
            .with_reasons(reasons)),
            DeploymentPreparation::Failed { reasons } => Ok(AssemblyItemPlan::new(
                requirement,
                AssemblyItemStatus::Failed,
            )
            .with_version(version_id)
            .with_reasons(reasons)),
        }
    }
}

fn conflict(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Acknowledge)
}
