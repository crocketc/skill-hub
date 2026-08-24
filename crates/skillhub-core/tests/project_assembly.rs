use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};

use skillhub_core::{
    AppResult, AssemblyChoice, AssemblyItemStatus, CheckPreparation, CheckPreparationPort,
    DeploymentPreparation, DeploymentPreparationPort, ProjectAssemblyService, ProjectId,
    SharedProjectConfig, SharedSkillRequirement, SkillId, SkillResolution, SkillResolutionPort,
    SourcePreparation, SourcePreparationPort, VersionId,
};

#[test]
fn best_effort_assembly_keeps_each_requirement_result() {
    let fixture = AssemblyFixture::new();
    let plan = fixture
        .service
        .prepare_assembly(fixture.project_id)
        .unwrap();

    assert_eq!(plan.items[0].status, AssemblyItemStatus::AlreadySatisfied);
    assert_eq!(plan.items[1].status, AssemblyItemStatus::ReadyToAcquire);
    assert_eq!(
        plan.items[2].status,
        AssemblyItemStatus::ConflictNeedsChoice
    );

    let result = fixture
        .service
        .commit_assembly(plan.with_choice_for_item(2, AssemblyChoice::Skip))
        .unwrap();

    assert_eq!(result.items.len(), 3);
    assert!(result
        .items
        .iter()
        .any(|item| item.status == AssemblyItemStatus::Skipped));
    assert!(result
        .items
        .iter()
        .any(|item| item.status == AssemblyItemStatus::Succeeded));
    assert!(fixture
        .service
        .deployment
        .deployed
        .borrow()
        .contains("missing"));
    assert!(!fixture
        .service
        .deployment
        .deployed
        .borrow()
        .contains("conflict"));
}

#[test]
fn commit_requires_explicit_choice_for_conflict_items() {
    let fixture = AssemblyFixture::new();
    let plan = fixture
        .service
        .prepare_assembly(fixture.project_id)
        .unwrap();

    let error = fixture.service.commit_assembly(plan).unwrap_err();

    assert_eq!(error.code.as_str(), "operation.conflict");
}

struct AssemblyFixture {
    project_id: ProjectId,
    service: ProjectAssemblyService<
        RecordingResolution,
        RecordingSource,
        RecordingCheck,
        RecordingDeployment,
    >,
}

impl AssemblyFixture {
    fn new() -> Self {
        let project_id = ProjectId::new();
        let satisfied = requirement("satisfied");
        let missing = requirement("missing");
        let conflict = requirement("conflict");
        let config = SharedProjectConfig::new(
            "demo",
            vec![satisfied.clone(), missing.clone(), conflict.clone()],
        );
        let resolution = RecordingResolution::new([
            (
                satisfied.skill_id,
                SkillResolution::Satisfied {
                    version_id: version(1),
                },
            ),
            (
                missing.skill_id,
                SkillResolution::Missing {
                    requested_source: "catalog/missing".to_owned(),
                },
            ),
            (
                conflict.skill_id,
                SkillResolution::Conflict {
                    reasons: vec!["assembly.same_name_conflict".to_owned()],
                },
            ),
        ])
        .with_config(project_id, config);
        let service = ProjectAssemblyService::new(
            resolution,
            RecordingSource,
            RecordingCheck,
            RecordingDeployment::default(),
        );
        Self {
            project_id,
            service,
        }
    }
}

#[derive(Default)]
struct RecordingResolution {
    configs: HashMap<ProjectId, SharedProjectConfig>,
    resolutions: HashMap<SkillId, SkillResolution>,
}

impl RecordingResolution {
    fn new(values: impl IntoIterator<Item = (SkillId, SkillResolution)>) -> Self {
        Self {
            configs: HashMap::new(),
            resolutions: values.into_iter().collect(),
        }
    }

    fn with_config(mut self, project_id: ProjectId, config: SharedProjectConfig) -> Self {
        self.configs.insert(project_id, config);
        self
    }
}

impl SkillResolutionPort for RecordingResolution {
    fn shared_config(&self, project_id: ProjectId) -> AppResult<SharedProjectConfig> {
        self.configs.get(&project_id).cloned().ok_or_else(|| {
            skillhub_core::AppError::new(
                skillhub_core::ErrorCode::ObjectNotFound,
                skillhub_core::Severity::Error,
            )
        })
    }

    fn resolve_requirement(
        &self,
        requirement: &SharedSkillRequirement,
    ) -> AppResult<SkillResolution> {
        Ok(self
            .resolutions
            .get(&requirement.skill_id)
            .cloned()
            .unwrap_or(SkillResolution::Missing {
                requested_source: requirement.source.as_str().to_owned(),
            }))
    }
}

#[derive(Default)]
struct RecordingSource;

impl SourcePreparationPort for RecordingSource {
    fn prepare_source(&self, requirement: &SharedSkillRequirement) -> AppResult<SourcePreparation> {
        if requirement.name == "missing" {
            Ok(SourcePreparation::Ready {
                version_id: version(2),
            })
        } else {
            Ok(SourcePreparation::NotNeeded)
        }
    }
}

#[derive(Default)]
struct RecordingCheck;

impl CheckPreparationPort for RecordingCheck {
    fn prepare_checks(
        &self,
        requirement: &SharedSkillRequirement,
        version_id: &VersionId,
    ) -> AppResult<CheckPreparation> {
        let _ = version_id;
        if requirement.name == "missing" {
            Ok(CheckPreparation::Passed)
        } else {
            Ok(CheckPreparation::NotNeeded)
        }
    }
}

#[derive(Default)]
struct RecordingDeployment {
    deployed: RefCell<BTreeSet<String>>,
}

impl DeploymentPreparationPort for RecordingDeployment {
    fn prepare_project_deployment(
        &self,
        requirement: &SharedSkillRequirement,
        version_id: &VersionId,
    ) -> AppResult<DeploymentPreparation> {
        let _ = version_id;
        if requirement.name == "missing" {
            Ok(DeploymentPreparation::Ready)
        } else {
            Ok(DeploymentPreparation::NotNeeded)
        }
    }

    fn commit_project_deployment(
        &self,
        requirement: &SharedSkillRequirement,
        version_id: &VersionId,
    ) -> AppResult<()> {
        let _ = version_id;
        self.deployed.borrow_mut().insert(requirement.name.clone());
        Ok(())
    }
}

fn requirement(name: &str) -> SharedSkillRequirement {
    SharedSkillRequirement {
        skill_id: SkillId::new(),
        source: format!("catalog/{name}").try_into().unwrap(),
        name: name.to_owned(),
        version_constraint: None,
        version_id: None,
        content_identity: None,
        logical_agent_id: None,
        project_subdirectory: None,
        note: None,
    }
}

fn version(byte: u8) -> VersionId {
    VersionId::parse(&format!(
        "sha256:{}",
        char::from(b'0' + byte).to_string().repeat(64)
    ))
    .unwrap()
}
