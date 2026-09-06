use skillhub_application::LocalApplicationFacade;
use skillhub_core::check::CheckRepository;
use skillhub_core::{
    agent::{
        ClientInstance, ClientKind, ClientPresence, DirectoryPrecedence, DiscoverySnapshot,
        LogicalTarget, OperatingSystem, PhysicalTarget, TargetScope,
    },
    api::{
        AnalyzeImport, AppCommandResult, AppQueryResult, CommitDeployment, CommitRestore,
        CommitUndeploy, CreateBackup, DiffVersions, DiscoverImportCandidates, GetBasicCheckResult,
        GetDeploymentPlan, GetDeploymentRelations, GetReconcilePlan, GetRemovalImpact, GetSkill,
        KeepIndependentCopy, ListDeployments, ListFindings, ListMarkdownFiles, ListProjects,
        ListSkills, ListVersions, PrepareDeleteSkill, PrepareDeployment, PrepareImport,
        PrepareRestore, PrepareUndeploy, PreviewProjectDirectory, ReadMarkdownFile, RecheckBasic,
        RenameSkill, RestoreDecision, RunBasicCheck, RunLlmSafetyCheck, RunRollingBackup,
        SaveMarkdownContent, SaveSkillContent, SetCurrentVersion, SetFindingDisposition,
        SetLifecycle, SetMetadata, SetTrial, VerifyBackup,
    },
    backup::{
        BackupRetentionPolicy, BackupScope, RestoreConflictDecision, SensitiveContentDecision,
    },
    catalog::{CatalogRepository, Skill},
    check::{CheckKind, CheckState, FindingDisposition},
    deployment::{
        DeploymentMode, DeploymentPlan, DeploymentPlanRequest, DeploymentRecord,
        DeploymentRepository, DeploymentState, RegisteredTargetIndex, TargetChange, TargetFact,
        TargetFactSource, TargetPlan,
    },
    import::ImportCandidate,
    project::{Project, SavedProjectView, SharedProjectConfig},
    search::{SearchDocument, SearchQuery},
    source::{SourceDescriptor, SourceKind, SourceLocator},
    AppCommand, AppQuery as RootAppQuery, ApplicationFacade, DeploymentCapability, ErrorCode,
    ExternalChangeState, PathPolicy, ReconcileAction, RemovalDecision, Severity, SkillId,
};

#[tokio::test]
async fn desktop_preferences_default_and_persist_through_the_real_facade() {
    let facade = LocalApplicationFacade::new(Database::open_in_memory().expect("database"));

    let result = facade
        .query(RootAppQuery::GetDesktopPreferences)
        .await
        .expect("default desktop preferences");
    let AppQueryResult::DesktopPreferences(defaults) = result else {
        panic!("expected desktop preferences");
    };
    assert!(defaults.network_enabled);
    assert_eq!(defaults.language, "system");

    let mut changed = defaults;
    changed.network_enabled = false;
    changed.language = "en-US".into();
    let result = facade
        .execute(AppCommand::SetDesktopPreferences(changed.clone()))
        .await
        .expect("save desktop preferences");
    assert!(matches!(result, AppCommandResult::DesktopPreferences(value) if value == changed));

    let result = facade
        .query(RootAppQuery::GetDesktopPreferences)
        .await
        .expect("saved desktop preferences");
    assert!(matches!(result, AppQueryResult::DesktopPreferences(value) if value == changed));

    let result = facade
        .query(RootAppQuery::GetApplicationUpdatePolicy)
        .await
        .expect("application update policy");
    assert!(matches!(result, AppQueryResult::ApplicationUpdatePolicy(policy) if policy.enabled));
}

#[tokio::test]
async fn project_commands_and_queries_use_the_real_facade() {
    let database = Database::open_in_memory().expect("database");
    let project_root = tempfile::tempdir().expect("project root");
    let project = Project::new(skillhub_core::ProjectId::new(), "Demo", project_root.path());
    let facade = LocalApplicationFacade::new(database);

    let result = facade
        .execute(AppCommand::RegisterProject(
            skillhub_core::api::RegisterProject {
                project: project.clone(),
            },
        ))
        .await
        .expect("register project");
    let AppCommandResult::Project(registered) = result else {
        panic!("expected project result");
    };
    assert_eq!(registered.name, "Demo");

    let result = facade
        .execute(AppCommand::SetProjectTags(
            skillhub_core::api::SetProjectTags {
                project_id: project.id,
                tags: vec!["rust".into(), "client".into()],
            },
        ))
        .await
        .expect("set tags");
    let AppCommandResult::Project(tagged) = result else {
        panic!("expected project result");
    };
    assert_eq!(tagged.tags.len(), 2);

    let result = facade
        .query(RootAppQuery::ListProjects(skillhub_core::api::ListProjects))
        .await
        .expect("list projects");
    let AppQueryResult::Projects(projects) = result else {
        panic!("expected projects result");
    };
    assert_eq!(projects, vec![tagged.clone()]);

    let view = SavedProjectView::all_tags("Rust clients", ["rust", "client"]);
    let result = facade
        .execute(AppCommand::SaveProjectView(
            skillhub_core::api::SaveProjectView { view },
        ))
        .await
        .expect("save project view");
    assert!(matches!(result, AppCommandResult::SavedProjectView(_)));

    let config = SharedProjectConfig::new("demo", Vec::new());
    let result = facade
        .execute(AppCommand::WriteSharedProjectConfig(
            skillhub_core::api::WriteSharedProjectConfig {
                project_id: tagged.id,
                config: config.clone(),
            },
        ))
        .await
        .expect("write config");
    assert!(matches!(result, AppCommandResult::SharedProjectConfig(_)));
    let result = facade
        .execute(AppCommand::ReadSharedProjectConfig(
            skillhub_core::api::ReadSharedProjectConfig {
                project_id: tagged.id,
            },
        ))
        .await
        .expect("read config");
    assert!(matches!(result, AppCommandResult::SharedProjectConfig(value) if value == config));
}

#[tokio::test]
async fn scan_commands_persist_confirmed_results_and_reject_unregistered_paths() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("scan root");
    let skill = root.path().join("example");
    std::fs::create_dir_all(&skill).expect("skill dir");
    std::fs::write(skill.join("SKILL.md"), "# Example\n").expect("marker");
    let facade = LocalApplicationFacade::new(database);
    let project = Project::new(skillhub_core::ProjectId::new(), "Scan", root.path());
    let registered = facade
        .execute(AppCommand::RegisterProject(
            skillhub_core::api::RegisterProject { project },
        ))
        .await
        .expect("register scan project");
    let AppCommandResult::Project(project) = registered else {
        panic!("expected project result");
    };

    let result = facade
        .execute(AppCommand::RunInitializationScan(
            skillhub_core::api::RunInitializationScan {
                scope_ids: vec![project.id.to_string()],
            },
        ))
        .await
        .expect("scan");
    let AppCommandResult::ScanResult(scan) = result else {
        panic!("expected scan result");
    };
    assert_eq!(scan.discovered.len(), 1);
    let result = facade
        .query(RootAppQuery::GetDiscoverySnapshot(
            skillhub_core::api::GetDiscoverySnapshot,
        ))
        .await
        .expect("discovery snapshot");
    assert!(matches!(result, AppQueryResult::DiscoverySnapshot(_)));
    let outside = tempfile::tempdir().expect("outside root");
    let error = facade
        .execute(AppCommand::RescanSkill(skillhub_core::api::RescanSkill {
            scope_id: project.id.to_string(),
            path: outside.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect_err("outside path must fail");
    assert_eq!(error.code, ErrorCode::PathOutsideAllowedRoots);
    let error = facade
        .execute(AppCommand::RescanSkill(skillhub_core::api::RescanSkill {
            scope_id: project.id.to_string(),
            path: root.path().join("missing").to_string_lossy().into_owned(),
        }))
        .await
        .expect_err("missing path must fail");
    assert_eq!(error.code, ErrorCode::InternalError);
}

#[tokio::test]
async fn initialization_scan_without_selection_ignores_unavailable_agent_targets() {
    let database = Database::open_in_memory().expect("database");
    let available_root = tempfile::tempdir().expect("available root");
    let skill = available_root.path().join("example");
    std::fs::create_dir_all(&skill).expect("skill dir");
    std::fs::write(skill.join("SKILL.md"), "# Example\n").expect("marker");
    let unavailable_path = available_root.path().join("missing-agent");
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-09-04T00:00:00Z".into(),
            instances: Vec::new(),
            logical_targets: vec![
                LogicalTarget {
                    id: "available".into(),
                    profile_id: "codex".into(),
                    client_id: "codex".into(),
                    scope: TargetScope::Global,
                    path: available_root.path().to_string_lossy().into_owned(),
                    marker: "SKILL.md".into(),
                    precedence: DirectoryPrecedence::Preferred,
                    exists: true,
                    readable: true,
                    writable: true,
                    available: true,
                    physical_id: skillhub_core::physical_id_for_path(available_root.path())
                        .expect("physical id"),
                },
                LogicalTarget {
                    id: "unavailable".into(),
                    profile_id: "unknown".into(),
                    client_id: "unknown".into(),
                    scope: TargetScope::Global,
                    path: unavailable_path.to_string_lossy().into_owned(),
                    marker: "SKILL.md".into(),
                    precedence: DirectoryPrecedence::Unknown,
                    exists: false,
                    readable: false,
                    writable: false,
                    available: false,
                    physical_id: "missing".into(),
                },
            ],
            physical_targets: vec![PhysicalTarget {
                id: skillhub_core::physical_id_for_path(available_root.path())
                    .expect("physical id"),
                path: available_root.path().to_string_lossy().into_owned(),
                exists: true,
                readable: true,
                writable: true,
                case_behavior: "unknown".into(),
                logical_target_ids: vec!["available".into()],
            }],
        })
        .expect("save discovery");
    let facade = LocalApplicationFacade::new(database);
    let result = facade
        .execute(AppCommand::RunInitializationScan(
            skillhub_core::api::RunInitializationScan {
                scope_ids: Vec::new(),
            },
        ))
        .await
        .expect("scan");
    let AppCommandResult::ScanResult(scan) = result else {
        panic!("expected scan result");
    };
    assert_eq!(scan.discovered.len(), 1);
}

#[tokio::test]
async fn initialization_scan_accepts_legacy_profile_client_scope_ids() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("root");
    let skill = root.path().join("example");
    std::fs::create_dir_all(&skill).expect("skill dir");
    std::fs::write(skill.join("SKILL.md"), "# Example\n").expect("marker");
    let physical_id = skillhub_core::physical_id_for_path(root.path()).expect("physical id");
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-09-04T00:00:00Z".into(),
            instances: vec![ClientInstance {
                profile_id: "codex".into(),
                client_id: "codex".into(),
                kind: ClientKind::Cli,
                supported_os: vec![OperatingSystem::Windows],
                client_presence: ClientPresence::Unknown,
            }],
            logical_targets: vec![LogicalTarget {
                id: "target-1".into(),
                profile_id: "codex".into(),
                client_id: "codex".into(),
                scope: TargetScope::Global,
                path: root.path().to_string_lossy().into_owned(),
                marker: "SKILL.md".into(),
                precedence: DirectoryPrecedence::Preferred,
                exists: true,
                readable: true,
                writable: true,
                available: true,
                physical_id: physical_id.clone(),
            }],
            physical_targets: vec![PhysicalTarget {
                id: physical_id,
                path: root.path().to_string_lossy().into_owned(),
                exists: true,
                readable: true,
                writable: true,
                case_behavior: "unknown".into(),
                logical_target_ids: vec!["target-1".into()],
            }],
        })
        .expect("save discovery");
    let facade = LocalApplicationFacade::new(database);
    let result = facade
        .execute(AppCommand::RunInitializationScan(
            skillhub_core::api::RunInitializationScan {
                scope_ids: vec!["codex:codex".into()],
            },
        ))
        .await
        .expect("scan");
    assert!(matches!(result, AppCommandResult::ScanResult(_)));
}

#[tokio::test]
async fn custom_agent_rejects_unregistered_picker_grants() {
    let facade = LocalApplicationFacade::new(Database::open_in_memory().expect("database"));
    let profile = skillhub_core::AgentProfile {
        profile_version: 1,
        research_date: "2026-08-30".into(),
        official_references: vec!["https://example.com/agent".into()],
        brand: "Custom".into(),
        clients: vec![skillhub_core::AgentClient {
            id: "custom.cli".into(),
            kind: skillhub_core::ClientKind::Cli,
            supported_os: vec![skillhub_core::OperatingSystem::Windows],
            path_candidates: vec![skillhub_core::PathCandidate {
                path: "C:/Users/demo/.custom/skills".into(),
                scope: skillhub_core::TargetScope::Global,
                precedence: skillhub_core::DirectoryPrecedence::Preferred,
                marker: "SKILL.md".into(),
            }],
            skill_marker: "SKILL.md".into(),
            deployment: skillhub_core::DeploymentCapability {
                copy: true,
                symlink: false,
                junction: false,
                limitations: Vec::new(),
            },
            call_policy: skillhub_core::CallPolicy::Unknown,
        }],
    };
    let error = facade
        .execute(AppCommand::CreateCustomAgent(
            skillhub_core::api::CreateCustomAgent {
                agent: skillhub_core::CustomAgentDraft {
                    id: "custom".into(),
                    display_name: "Custom".into(),
                    directory: skillhub_core::PathGrant::from_file_picker("not-registered"),
                    profile,
                },
            },
        ))
        .await
        .expect_err("unregistered grant must be rejected");
    assert_eq!(error.code, ErrorCode::AgentProfileInvalidCapability);
}

#[tokio::test]
async fn project_assembly_prepare_uses_local_config_and_is_queryable() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Assembly\n").expect("marker");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Assembly");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let central = CentralLibrary::initialize(library_root.path()).expect("central library");
    let version = VersionStore::from_library(&central)
        .capture(skill.id(), source.path())
        .expect("capture version");
    VersionStore::from_library(&central)
        .set_current(skill.id(), &version.id)
        .expect("current version");
    let project_root = tempfile::tempdir().expect("project root");
    let project = Project::new(
        skillhub_core::ProjectId::new(),
        "Assembly project",
        project_root.path(),
    );
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let registered = facade
        .execute(AppCommand::RegisterProject(
            skillhub_core::api::RegisterProject { project },
        ))
        .await
        .expect("register project");
    let AppCommandResult::Project(project) = registered else {
        panic!("expected project result");
    };
    let config = SharedProjectConfig::new(
        "assembly",
        vec![skillhub_core::SharedSkillRequirement {
            skill_id: skill.id(),
            source: skillhub_core::PortableSource::catalog("local").expect("source"),
            name: "Assembly".into(),
            version_constraint: None,
            version_id: Some(version.id),
            content_identity: None,
            logical_agent_id: None,
            project_subdirectory: None,
            note: None,
        }],
    );
    facade
        .execute(AppCommand::WriteSharedProjectConfig(
            skillhub_core::api::WriteSharedProjectConfig {
                project_id: project.id,
                config,
            },
        ))
        .await
        .expect("write config");
    let result = facade
        .execute(AppCommand::PrepareProjectAssembly(
            skillhub_core::api::PrepareProjectAssembly {
                project_id: project.id,
            },
        ))
        .await
        .expect("prepare assembly");
    let AppCommandResult::AssemblyPlan(plan) = result else {
        panic!("expected assembly plan");
    };
    assert_eq!(
        plan.items[0].status,
        skillhub_core::AssemblyItemStatus::AlreadySatisfied
    );
    let result = facade
        .query(RootAppQuery::GetProjectAssemblyPlan(
            skillhub_core::api::GetProjectAssemblyPlan {
                project_id: project.id,
            },
        ))
        .await
        .expect("assembly query");
    assert!(matches!(result, AppQueryResult::AssemblyPlan(_)));
}

#[tokio::test]
async fn standard_export_prepare_uses_the_real_facade_and_stays_read_only() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Standard export");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Portable\n").expect("write skill");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let version = VersionStore::from_library(&library)
        .capture(skill.id(), source.path())
        .expect("capture version");
    VersionStore::from_library(&library)
        .set_current(skill.id(), &version.id)
        .expect("set current");

    let facade = LocalApplicationFacade::new_with_library(database, root.path());
    let result = facade
        .execute(AppCommand::PrepareStandardExport(
            skillhub_core::PrepareStandardExport {
                input: skillhub_core::ExportInput {
                    selection: skillhub_core::ExportSelection::Skills(vec![skill.id()]),
                    versions: skillhub_core::VersionSelection::Current,
                    skills: vec![skillhub_core::ExportSkill {
                        skill_id: skill.id(),
                        version_id: version.id.clone(),
                        content: "# Portable\n".into(),
                        display_name: "Standard export".into(),
                    }],
                    format: skillhub_core::ExportFormat::Folder,
                },
            },
        ))
        .await
        .expect("export plan");
    let AppCommandResult::ExportPlan(plan) = result else {
        panic!("expected export plan");
    };
    assert_eq!(plan.skills.len(), 1);
    assert!(plan.sensitive_items.is_empty());
    assert!(!root.path().join(".skillhub/exports").exists());
}

#[tokio::test]
async fn standard_export_create_requires_sensitive_decision_and_returns_neutral_package() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Sensitive export");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    let secret = "OPENAI_API_KEY=sk-live-secret\n";
    std::fs::write(source.path().join("SKILL.md"), secret).expect("write skill");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let version = VersionStore::from_library(&library)
        .capture(skill.id(), source.path())
        .expect("capture version");
    VersionStore::from_library(&library)
        .set_current(skill.id(), &version.id)
        .expect("set current");
    let input = skillhub_core::ExportInput {
        selection: skillhub_core::ExportSelection::Skills(vec![skill.id()]),
        versions: skillhub_core::VersionSelection::Current,
        skills: vec![skillhub_core::ExportSkill {
            skill_id: skill.id(),
            version_id: version.id,
            content: secret.into(),
            display_name: "Sensitive export".into(),
        }],
        format: skillhub_core::ExportFormat::Folder,
    };
    let facade = LocalApplicationFacade::new_with_library(database, root.path());
    let missing = facade
        .execute(AppCommand::CreateStandardExport(
            skillhub_core::CreateStandardExport {
                input: input.clone(),
                decisions: Vec::new(),
            },
        ))
        .await
        .expect_err("sensitive decision is required");
    assert_eq!(missing.code, ErrorCode::BackupExportDecisionRequired);

    let result = facade
        .execute(AppCommand::CreateStandardExport(
            skillhub_core::CreateStandardExport {
                input,
                decisions: vec![skillhub_core::ExportDecision {
                    skill_id: skill.id(),
                    decision: skillhub_core::backup::SensitiveContentDecision::IncludeAndMark,
                }],
            },
        ))
        .await
        .expect("create export");
    let AppCommandResult::ExportResult(result) = result else {
        panic!("expected export result");
    };
    let export_root = std::path::Path::new(&result.path);
    assert!(export_root.is_dir());
    assert_eq!(result.skills_exported, 1);
    let manifest = std::fs::read_to_string(export_root.join("manifest.json")).expect("manifest");
    assert!(!manifest.contains(root.path().to_string_lossy().as_ref()));
    assert!(!manifest.contains("sk-live-secret"));
}

#[tokio::test]
async fn uninstall_prepare_returns_selected_impact_without_mutating_relations() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Uninstall candidate");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let version_id = skillhub_core::VersionId::parse(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("version id");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES (?1,?2,'hash','{}',0)",
            rusqlite::params![version_id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('target-uninstall','agent','global','C:/agent',0)",
            [],
        )
        .expect("insert target");
    let deployment = DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id: skill.id(),
        version_id,
        target_id: "target-uninstall".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "uninstall-candidate".into(),
        expected_hash: "sha256:tree".into(),
        observed_hash: Some("sha256:tree".into()),
    };
    database
        .deployment_repository()
        .insert(&deployment)
        .await
        .expect("insert deployment");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 30));

    let result = facade
        .execute(AppCommand::PrepareUninstall(
            skillhub_core::PrepareUninstall {
                deployment_ids: vec![deployment.id],
            },
        ))
        .await
        .expect("uninstall impact");
    let AppCommandResult::UninstallImpact(impact) = result else {
        panic!("expected uninstall impact");
    };
    assert_eq!(impact.deployments, vec![deployment.clone()]);
    assert!(impact
        .actions
        .contains(&skillhub_core::UninstallAction::RetainCentralLibrary));

    let listed = facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill.id()),
        }))
        .await
        .expect("deployment list");
    let AppQueryResult::Deployments(listed) = listed else {
        panic!("expected deployments");
    };
    assert_eq!(listed[0], deployment);
}

#[tokio::test]
async fn uninstall_decision_can_cancel_or_detach_management_without_deleting_library_data() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Uninstall decision");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Keep me\n").expect("write skill");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let store = VersionStore::from_library(&library);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    let deployment = DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id: skill.id(),
        version_id: version.id,
        target_id: "target-uninstall-decision".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "uninstall-decision".into(),
        expected_hash: "sha256:tree".into(),
        observed_hash: Some("sha256:tree".into()),
    };
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES (?1,?2,'hash','{}',0)",
            rusqlite::params![deployment.version_id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('target-uninstall-decision','agent','global','C:/agent',0)",
            [],
        )
        .expect("insert target");
    database
        .deployment_repository()
        .insert(&deployment)
        .await
        .expect("insert deployment");
    let facade = LocalApplicationFacade::new_with_library(database, root.path());

    facade
        .execute(AppCommand::PrepareUninstall(
            skillhub_core::PrepareUninstall {
                deployment_ids: vec![deployment.id],
            },
        ))
        .await
        .expect("prepare cancellation");
    facade
        .execute(AppCommand::ApplyUninstallDecision(
            skillhub_core::ApplyUninstallDecision {
                actions: vec![skillhub_core::UninstallAction::Cancel],
            },
        ))
        .await
        .expect("cancel uninstall");
    let cancelled = facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill.id()),
        }))
        .await
        .expect("list after cancellation");
    let AppQueryResult::Deployments(cancelled) = cancelled else {
        panic!("expected deployments");
    };
    assert_eq!(cancelled[0], deployment);

    facade
        .execute(AppCommand::PrepareUninstall(
            skillhub_core::PrepareUninstall {
                deployment_ids: vec![deployment.id],
            },
        ))
        .await
        .expect("prepare detach");
    facade
        .execute(AppCommand::ApplyUninstallDecision(
            skillhub_core::ApplyUninstallDecision {
                actions: vec![skillhub_core::UninstallAction::LeaveTargetsIndependent],
            },
        ))
        .await
        .expect("detach management");
    let detached = facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill.id()),
        }))
        .await
        .expect("list after detach");
    let AppQueryResult::Deployments(detached) = detached else {
        panic!("expected deployments");
    };
    assert!(!detached[0].managed);
    assert!(root.path().join(".skillhub/versions").is_dir());
}
use skillhub_storage::Database;
use skillhub_storage::{CentralLibrary, VersionStore};

struct StaticLlmRunner;

#[async_trait::async_trait(?Send)]
impl skillhub_core::LlmTaskRunner for StaticLlmRunner {
    async fn run(
        &self,
        _profile: &skillhub_core::LlmProfile,
        request: skillhub_core::LlmTaskRequest,
    ) -> skillhub_core::AppResult<skillhub_core::LlmTaskResponse> {
        Ok(skillhub_core::LlmTaskResponse {
            request_id: "test-request".to_owned(),
            kind: request.kind,
            output: serde_json::json!({
                "findings": [{
                    "code": "llm.prompt_injection",
                    "severity": "warning",
                    "file": "SKILL.md",
                    "line_start": 1,
                    "line_end": 1,
                    "explanation": "test finding"
                }]
            }),
        })
    }
}

#[tokio::test]
async fn bootstrap_query_reads_counts_from_the_shared_database() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Markdown");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 29));
    let result = facade
        .query(RootAppQuery::GetBootstrapSnapshot)
        .await
        .expect("bootstrap result");

    let AppQueryResult::BootstrapSnapshot(snapshot) = result else {
        panic!("expected bootstrap snapshot");
    };
    assert_eq!(snapshot.skill_count, 1);
    assert_eq!(snapshot.project_count, 0);
    assert_eq!(snapshot.agent_count, 0);
    assert_eq!(snapshot.deployed_count, 0);
}

#[tokio::test]
async fn bootstrap_query_reports_a_fresh_library_as_not_initialized() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());

    let result = facade
        .query(RootAppQuery::GetBootstrapSnapshot)
        .await
        .expect("bootstrap result");

    let AppQueryResult::BootstrapSnapshot(snapshot) = result else {
        panic!("expected bootstrap snapshot");
    };
    assert_eq!(
        snapshot.initialization_state,
        skillhub_core::InitializationState::NotInitialized
    );
    assert_eq!(snapshot.library_path, library_root.path().to_string_lossy());
    assert!(!snapshot.onboarding_skipped);
}

#[tokio::test]
async fn completing_onboarding_persists_the_selected_library_and_skip_state() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    let selected_path = library_root.path().to_string_lossy().into_owned();
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());

    let completion = facade
        .execute(AppCommand::CompleteOnboarding(
            skillhub_core::api::CompleteOnboarding {
                library_path: selected_path.clone(),
                skipped: true,
            },
        ))
        .await
        .expect("complete onboarding");
    let AppCommandResult::InitializationStatus(status) = completion else {
        panic!("expected initialization status");
    };
    assert_eq!(
        status.state,
        skillhub_core::InitializationState::Initialized
    );
    assert_eq!(status.library_path, selected_path);
    assert!(status.skipped);

    let result = facade
        .query(RootAppQuery::GetBootstrapSnapshot)
        .await
        .expect("persisted bootstrap result");
    let AppQueryResult::BootstrapSnapshot(snapshot) = result else {
        panic!("expected bootstrap snapshot");
    };
    assert_eq!(
        snapshot.initialization_state,
        skillhub_core::InitializationState::Initialized
    );
    assert_eq!(snapshot.library_path, selected_path);
    assert!(snapshot.onboarding_skipped);
}

#[tokio::test]
async fn onboarding_completion_is_repeatable_and_rejects_an_unconfigured_path() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    let other_root = tempfile::tempdir().expect("other root");
    let selected_path = library_root.path().to_string_lossy().into_owned();
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());

    for _ in 0..2 {
        facade
            .execute(AppCommand::CompleteOnboarding(
                skillhub_core::api::CompleteOnboarding {
                    library_path: selected_path.clone(),
                    skipped: false,
                },
            ))
            .await
            .expect("repeat completion");
    }

    let error = facade
        .execute(AppCommand::CompleteOnboarding(
            skillhub_core::api::CompleteOnboarding {
                library_path: other_root.path().to_string_lossy().into_owned(),
                skipped: false,
            },
        ))
        .await
        .expect_err("unconfigured library path must be rejected");
    assert_eq!(error.code, ErrorCode::InvalidInput);

    let result = facade
        .query(RootAppQuery::GetBootstrapSnapshot)
        .await
        .expect("bootstrap result");
    let AppQueryResult::BootstrapSnapshot(snapshot) = result else {
        panic!("expected bootstrap snapshot");
    };
    assert_eq!(snapshot.library_path, selected_path);
    assert!(!snapshot.onboarding_skipped);
}

#[tokio::test]
async fn set_library_root_persists_the_chosen_root_before_initialization() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    let chosen_root = tempfile::tempdir().expect("chosen root");
    let chosen_path = chosen_root.path().to_string_lossy().into_owned();
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());

    let result = facade
        .execute(AppCommand::SetLibraryRoot(
            skillhub_core::api::SetLibraryRoot {
                path: chosen_path.clone(),
            },
        ))
        .await
        .expect("set library root");
    let AppCommandResult::InitializationStatus(status) = result else {
        panic!("expected initialization status");
    };
    assert_eq!(status.library_path, chosen_path);

    // The bootstrap snapshot immediately reflects the chosen root.
    let result = facade
        .query(RootAppQuery::GetBootstrapSnapshot)
        .await
        .expect("bootstrap result");
    let AppQueryResult::BootstrapSnapshot(snapshot) = result else {
        panic!("expected bootstrap snapshot");
    };
    assert_eq!(snapshot.library_path, chosen_path);
    assert_eq!(
        snapshot.initialization_state,
        skillhub_core::InitializationState::NotInitialized
    );

    // The chosen root was materialized as a central library directory.
    let paths = skillhub_storage::LibraryPaths::from_root(chosen_root.path());
    assert!(
        paths.management_dir.exists(),
        "library management dir must be materialized"
    );

    // Completion now accepts the newly configured root in the same session.
    let completion = facade
        .execute(AppCommand::CompleteOnboarding(
            skillhub_core::api::CompleteOnboarding {
                library_path: chosen_path.clone(),
                skipped: false,
            },
        ))
        .await
        .expect("complete onboarding with the chosen root");
    let AppCommandResult::InitializationStatus(status) = completion else {
        panic!("expected initialization status");
    };
    assert_eq!(
        status.state,
        skillhub_core::InitializationState::Initialized
    );
}

#[tokio::test]
async fn set_library_root_rejects_empty_paths_and_initialized_libraries() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    let chosen_root = tempfile::tempdir().expect("chosen root");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());

    let empty = facade
        .execute(AppCommand::SetLibraryRoot(
            skillhub_core::api::SetLibraryRoot { path: "   ".into() },
        ))
        .await
        .expect_err("empty path must be rejected");
    assert_eq!(empty.code, ErrorCode::InvalidInput);

    facade
        .execute(AppCommand::CompleteOnboarding(
            skillhub_core::api::CompleteOnboarding {
                library_path: library_root.path().to_string_lossy().into_owned(),
                skipped: false,
            },
        ))
        .await
        .expect("complete onboarding");

    let conflict = facade
        .execute(AppCommand::SetLibraryRoot(
            skillhub_core::api::SetLibraryRoot {
                path: chosen_root.path().to_string_lossy().into_owned(),
            },
        ))
        .await
        .expect_err("changing root after initialization must be rejected");
    assert_eq!(conflict.code, ErrorCode::OperationConflict);
}

#[tokio::test]
async fn pending_query_uses_the_same_date_boundary_as_bootstrap() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Trial").with_trial_due(2026, 8, 29);
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 29));
    let result = facade
        .query(RootAppQuery::ListPendingItems(
            skillhub_core::ListPendingItems,
        ))
        .await
        .expect("pending result");

    let AppQueryResult::PendingItems(items) = result else {
        panic!("expected pending items");
    };
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].code, "trial.due");
}

#[tokio::test]
async fn ignore_rules_survive_reopening_the_application_database() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let facade = LocalApplicationFacade::open(&database_path).expect("open facade");
    facade
        .execute(AppCommand::CreateIgnoreRule(
            skillhub_core::CreateIgnoreRule {
                subject: skillhub_core::IgnoreSubject::exact_pending("trial_due:skill-a:trial.due"),
                reason: "review after the release".into(),
                defer_until: Some("2026-09-10".into()),
            },
        ))
        .await
        .expect("create ignore rule");
    drop(facade);

    let reopened = LocalApplicationFacade::open(&database_path).expect("reopen facade");
    let result = reopened
        .query(RootAppQuery::ListIgnoreRules)
        .await
        .expect("list persisted ignore rules");
    assert!(
        matches!(result, AppQueryResult::IgnoreRules(rules) if rules.len() == 1
        && rules[0].reason == "review after the release"
        && rules[0].defer_until.as_deref() == Some("2026-09-10"))
    );
}

#[tokio::test]
async fn deferred_pending_item_is_hidden_until_its_due_date() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Trial").with_trial_due(2026, 8, 29);
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 29));
    facade
        .execute(AppCommand::CreateIgnoreRule(
            skillhub_core::CreateIgnoreRule {
                subject: skillhub_core::IgnoreSubject::exact_pending(format!(
                    "trial_due:{}:trial.due",
                    skill.id()
                )),
                reason: "deferred for review".into(),
                defer_until: Some("2026-08-30".into()),
            },
        ))
        .await
        .expect("defer pending item");

    let result = facade
        .query(RootAppQuery::ListPendingItems(
            skillhub_core::ListPendingItems,
        ))
        .await
        .expect("pending result");
    assert!(matches!(result, AppQueryResult::PendingItems(items) if items.is_empty()));
}

#[tokio::test]
async fn deferred_pending_item_reappears_on_its_due_date() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Trial").with_trial_due(2026, 8, 29);
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 30));
    facade
        .execute(AppCommand::CreateIgnoreRule(
            skillhub_core::CreateIgnoreRule {
                subject: skillhub_core::IgnoreSubject::exact_pending(format!(
                    "trial_due:{}:trial.due",
                    skill.id()
                )),
                reason: "deferred for review".into(),
                defer_until: Some("2026-08-30".into()),
            },
        ))
        .await
        .expect("defer pending item");

    let result = facade
        .query(RootAppQuery::ListPendingItems(
            skillhub_core::ListPendingItems,
        ))
        .await
        .expect("pending result");
    assert!(matches!(result, AppQueryResult::PendingItems(items) if items.len() == 1));
}

#[tokio::test]
async fn unsupported_operations_return_a_structured_internal_error() {
    let facade = LocalApplicationFacade::new_with_today(
        Database::open_in_memory().expect("database"),
        (2026, 8, 29),
    );

    let error = facade
        .execute(AppCommand::AcknowledgeRecovery {
            operation_id: skillhub_core::OperationId::new(),
        })
        .await
        .expect_err("unsupported command should fail explicitly");

    assert_eq!(error.code, ErrorCode::InternalError);
    assert_eq!(error.severity, Severity::Error);
    assert_eq!(error.params["operation"], "execute.unsupported");
}

#[tokio::test]
async fn analyze_import_query_returns_deterministic_conflict_matches() {
    let database = Database::open_in_memory().expect("database");
    let existing = Skill::new(skillhub_core::SkillId::new(), "PDF Reader");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&existing)
        .await
        .expect("insert skill");

    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path("C:/incoming")),
        "C:/incoming/pdf-reader",
        "pdf-reader",
        "SKILL.md",
        "PDF Reader",
    );
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 29));

    let result = facade
        .query(RootAppQuery::AnalyzeImport(AnalyzeImport {
            candidate,
            tree_hash: None,
        }))
        .await
        .expect("import analysis");
    let AppQueryResult::ImportAnalysis(analysis) = result else {
        panic!("expected import analysis");
    };

    assert_eq!(analysis.matches.len(), 1);
    assert_eq!(analysis.matches[0].skill_id, existing.id());
    assert_eq!(
        analysis.matches[0].duplicate_kind,
        skillhub_core::DuplicateKind::SameRuntimeNameDifferentContent
    );
    assert!(analysis
        .conflicts
        .iter()
        .any(|conflict| conflict.requires_choice));
}

#[tokio::test]
async fn discover_import_candidates_query_reads_local_skill_directories() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("source root");
    std::fs::create_dir_all(root.path().join("nested/notes")).expect("nested directory");
    std::fs::write(root.path().join("nested/notes/SKILL.md"), "# Notes\n").expect("write skill");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 29));

    let result = facade
        .query(RootAppQuery::DiscoverImportCandidates(
            DiscoverImportCandidates {
                source: SourceDescriptor::new(
                    SourceKind::Local,
                    SourceLocator::local_path(root.path()),
                ),
            },
        ))
        .await
        .expect("candidate discovery");
    let AppQueryResult::ImportCandidates(candidates) = result else {
        panic!("expected import candidates");
    };
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].marker, "SKILL.md");
    assert_eq!(candidates[0].runtime_name, "notes");
}

#[tokio::test]
async fn preview_project_directory_query_reports_traces_and_candidates_without_writes() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("project root");
    std::fs::create_dir_all(root.path().join(".claude/skills")).expect("claude skills directory");
    std::fs::create_dir_all(root.path().join(".agents/skills/research"))
        .expect("agents skills directory");
    std::fs::write(
        root.path().join(".agents/skills/research/SKILL.md"),
        "# Research
",
    )
    .expect("write project skill");
    let before = directory_listing(root.path());
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 9, 5));
    let request = PreviewProjectDirectory {
        path: root.path().to_string_lossy().into_owned(),
    };

    async fn run(
        facade: &LocalApplicationFacade,
        request: PreviewProjectDirectory,
    ) -> skillhub_core::api::ProjectDirectoryPreview {
        let result = facade
            .query(RootAppQuery::PreviewProjectDirectory(request))
            .await
            .expect("project preview");
        let AppQueryResult::ProjectDirectoryPreview(preview) = result else {
            panic!("expected project directory preview");
        };
        preview
    }

    let first = run(&facade, request.clone()).await;
    let second = run(&facade, request).await;
    assert_eq!(first, second);

    let claude_trace = first
        .agent_traces
        .iter()
        .find(|trace| trace.client_id == "anthropic.claude-code")
        .expect("claude-code trace");
    let claude_path = claude_trace.path.replace('\\', "/");
    assert!(claude_path.ends_with(".claude/skills"));
    assert!(first
        .agent_traces
        .iter()
        .any(|trace| { trace.path.replace('\\', "/").ends_with(".agents/skills") }));
    assert!(first
        .agent_traces
        .iter()
        .all(|trace| trace.scope == TargetScope::Project));

    assert_eq!(first.skill_candidates.len(), 1);
    assert_eq!(first.skill_candidates[0].runtime_name, "research");
    assert!(first.skill_candidates[0]
        .absolute_root
        .replace('\\', "/")
        .contains("research"));

    // The preview is read-only: no project records and no directory changes.
    let projects = facade
        .query(RootAppQuery::ListProjects(ListProjects))
        .await
        .expect("list projects");
    let AppQueryResult::Projects(projects) = projects else {
        panic!("expected project list");
    };
    assert!(projects.is_empty());
    assert_eq!(before, directory_listing(root.path()));
}

fn directory_listing(root: &std::path::Path) -> Vec<String> {
    let mut entries = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(&directory).expect("read directory") {
            let entry = entry.expect("directory entry");
            let path = entry.path();
            entries.push(path.to_string_lossy().into_owned());
            if path.is_dir() {
                stack.push(path);
            }
        }
    }
    entries.sort();
    entries
}

#[tokio::test]
async fn preview_project_directory_query_rejects_missing_and_non_directory_paths() {
    let database = Database::open_in_memory().expect("database");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 9, 5));

    let missing = facade
        .query(RootAppQuery::PreviewProjectDirectory(
            PreviewProjectDirectory {
                path: "Z:/definitely-not-here".into(),
            },
        ))
        .await;
    assert!(matches!(
        missing.err().map(|error| error.code),
        Some(ErrorCode::InvalidInput)
    ));

    let file = tempfile::NamedTempFile::new().expect("plain file");
    let not_a_directory = facade
        .query(RootAppQuery::PreviewProjectDirectory(
            PreviewProjectDirectory {
                path: file.path().to_string_lossy().into_owned(),
            },
        ))
        .await;
    assert!(matches!(
        not_a_directory.err().map(|error| error.code),
        Some(ErrorCode::InvalidInput)
    ));
}

#[tokio::test]
async fn prepare_import_command_persists_a_retryable_preparation() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("initialize library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Notes\n").expect("write skill");
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(source.path())),
        source.path().to_string_lossy(),
        ".",
        "SKILL.md",
        "Notes",
    );
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());

    let result = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate,
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = result else {
        panic!("expected prepared import");
    };
    assert_eq!(prepared.analysis.candidate.runtime_name, "Notes");
    assert!(!prepared.id.to_string().is_empty());

    let cancelled = facade
        .execute(AppCommand::CancelImport {
            prepared_import_id: prepared.id,
        })
        .await
        .expect("cancelled import");
    let AppCommandResult::OperationSummary(summary) = cancelled else {
        panic!("expected operation summary");
    };
    assert_eq!(summary.operation_id, prepared.id);
    assert_eq!(summary.phase, skillhub_core::OperationPhase::RolledBack);
}

#[tokio::test]
async fn commit_import_copies_skill_into_the_central_library() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("initialize library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Notes\n").expect("write skill");
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(source.path())),
        source.path().to_string_lossy(),
        ".",
        "SKILL.md",
        "Notes",
    );
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate,
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };

    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision: skillhub_core::ImportDecision::CopyIntoLibrary,
        }))
        .await
        .expect("committed import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    assert!(summary.committed);
    let skill_id = summary.items[0].skill_id.expect("imported skill id");
    assert_eq!(
        summary.items[0].decision,
        skillhub_core::ImportDecision::CopyIntoLibrary
    );
    assert!(source.path().join("SKILL.md").is_file());
    let visible_skill_roots = std::fs::read_dir(library_root.path().join("skills"))
        .expect("visible central skill directory")
        .map(|entry| entry.expect("visible skill entry").path())
        .collect::<Vec<_>>();
    assert_eq!(visible_skill_roots.len(), 1);
    assert_eq!(
        std::fs::read_to_string(visible_skill_roots[0].join("SKILL.md"))
            .expect("materialized central skill"),
        "# Notes\n"
    );

    let detail = facade
        .query(RootAppQuery::GetSkill(GetSkill { skill_id }))
        .await
        .expect("imported skill detail");
    let AppQueryResult::Skill(detail) = detail else {
        panic!("expected skill detail");
    };
    assert_eq!(detail.display_name, "Notes");
    assert!(detail.current_version.is_some());
}

#[tokio::test]
async fn failed_import_commit_removes_partial_catalog_and_version_state() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("initialize library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Notes\n").expect("write skill");
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::https_url("https://example.invalid/notes"),
        ),
        source.path().to_string_lossy(),
        ".",
        "SKILL.md",
        "Notes",
    );
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate,
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };

    let error = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision: skillhub_core::ImportDecision::CopyIntoLibrary,
        }))
        .await
        .expect_err("malformed source descriptor should fail");
    assert_eq!(error.code, ErrorCode::InvalidInput);

    let page = facade
        .query(RootAppQuery::ListSkills(ListSkills {
            text: String::new(),
            page: 1,
            page_size: 25,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list after failed import");
    let AppQueryResult::SkillPage(page) = page else {
        panic!("expected skill page");
    };
    assert!(page.items.is_empty());
    let version_files = walk_files(&library_root.path().join(".skillhub/versions"));
    let object_files = walk_files(&library_root.path().join(".skillhub/objects"));
    assert!(version_files.is_empty());
    assert!(object_files.is_empty());
}

fn walk_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory).expect("read directory") {
            let path = entry.expect("directory entry").path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push(path);
            }
        }
    }
    files
}

#[tokio::test]
async fn catalog_queries_return_skill_identity_and_ranked_search_hits() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Markdown tables")
        .with_description("Create PDF tables")
        .with_tag("documents")
        .with_note("Useful for reports")
        .with_license("MIT")
        .with_trial_due(2026, 9, 15);
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    database
        .search_repository()
        .reindex_skill(&SearchDocument {
            skill_id: skill.id(),
            display_name: skill.display_name().to_owned(),
            runtime_name: skill.runtime_name().to_owned(),
            original_description: skill.original_description().to_owned(),
            translated_description: None,
            user_note: None,
            tags: Vec::new(),
            author: None,
            license: None,
            requirements: Vec::new(),
            markdown: "tables".into(),
        })
        .expect("index skill");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 29));
    let detail = facade
        .query(RootAppQuery::GetSkill(GetSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("skill result");
    let AppQueryResult::Skill(detail) = detail else {
        panic!("expected skill result");
    };
    assert_eq!(detail.skill_id, skill.id());
    assert_eq!(detail.display_name, "Markdown tables");
    assert_eq!(detail.runtime_name, "Markdown tables");
    assert_eq!(detail.original_description, "Create PDF tables");
    assert_eq!(detail.user_note.as_deref(), Some("Useful for reports"));
    assert_eq!(
        detail.tags,
        vec!["documents".to_owned(), "temporary_trial".to_owned()]
    );
    assert_eq!(detail.license.as_deref(), Some("MIT"));
    assert_eq!(detail.trial_due.as_deref(), Some("2026-09-15"));

    let search = facade
        .query(RootAppQuery::Search(SearchQuery::new("tables")))
        .await
        .expect("search result");
    let AppQueryResult::SearchResults(hits) = search else {
        panic!("expected search result");
    };
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].skill_id, skill.id());
}

#[tokio::test]
async fn list_skills_query_returns_a_stable_page_and_tag_facets() {
    let database = Database::open_in_memory().expect("database");
    let first = Skill::new(skillhub_core::SkillId::new(), "Alpha").with_tag("documents");
    let second = Skill::new(skillhub_core::SkillId::new(), "Beta").with_tag("media");
    let repository = database.catalog_repository().expect("catalog repository");
    repository.insert(&first).await.expect("insert first");
    repository.insert(&second).await.expect("insert second");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 29));
    let result = facade
        .query(RootAppQuery::ListSkills(ListSkills {
            text: "".into(),
            page: 1,
            page_size: 1,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list result");

    let AppQueryResult::SkillPage(page) = result else {
        panic!("expected skill page");
    };
    assert_eq!(page.total, 2);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].display_name, "Alpha");
    assert_eq!(page.tags, vec!["documents".to_owned(), "media".to_owned()]);
}

async fn query_skill_names(
    facade: &LocalApplicationFacade,
    filters: skillhub_core::api::SkillListFilters,
    sort: skillhub_core::api::SkillListSort,
) -> Vec<String> {
    let result = facade
        .query(RootAppQuery::ListSkills(ListSkills {
            text: String::new(),
            page: 1,
            page_size: 50,
            filters,
            sort,
        }))
        .await
        .expect("list result");
    let AppQueryResult::SkillPage(page) = result else {
        panic!("expected skill page");
    };
    page.items
        .into_iter()
        .map(|item| item.display_name)
        .collect()
}

fn seed_version_and_current_pointer(
    database: &skillhub_storage::Database,
    skill: SkillId,
    version: &skillhub_core::VersionId,
    source_version: &str,
) {
    database
        .connection_for_test()
        .execute_batch(&format!(
            "INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at,source_version) VALUES ('{version}','{}','hash','{{}}',0,'{source_version}');\
             INSERT INTO current_pointers (skill_id,version_id,updated_at) VALUES ('{}','{version}',0);",
            skill, skill
        ))
        .expect("seed version and current pointer");
}

#[tokio::test]
async fn list_skills_query_filters_by_tags_lifecycle_and_deployment_state() {
    let database = Database::open_in_memory().expect("database");
    let alpha = Skill::new(SkillId::new(), "Alpha").with_tag("documents");
    let beta = Skill::new(SkillId::new(), "Beta")
        .with_tag("media")
        .with_trial_due(2026, 10, 1);
    let gamma = Skill::from_parts(
        SkillId::new(),
        "Gamma".into(),
        "Gamma".into(),
        String::new(),
        None,
        None,
        ["documents".to_owned(), "media".to_owned()]
            .into_iter()
            .collect(),
        None,
        None,
        skillhub_core::catalog::CallPolicy::AutomaticAndManual,
        skillhub_core::catalog::SkillLifecycle::Archived,
        Vec::new(),
        None,
    )
    .expect("archived skill");
    let repository = database.catalog_repository().expect("catalog repository");
    repository.insert(&alpha).await.expect("insert alpha");
    repository.insert(&beta).await.expect("insert beta");
    repository.insert(&gamma).await.expect("insert gamma");

    let version_id = skillhub_core::VersionId::parse(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("version id");
    seed_version_and_current_pointer(&database, alpha.id(), &version_id, "1.0.0");
    database
        .connection_for_test()
        .execute_batch(
            "INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('agent-codex','codex','global','C:/agents/codex',0);",
        )
        .expect("seed agent target");
    let deployment = DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id: alpha.id(),
        version_id: version_id.clone(),
        target_id: "agent-codex".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "alpha".into(),
        expected_hash: "sha256:tree".into(),
        observed_hash: None,
    };
    database
        .deployment_repository()
        .insert(&deployment)
        .await
        .expect("insert deployment");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 9, 5));
    let default_sort = skillhub_core::api::SkillListSort::default();
    let filters =
        |tags: &[&str], lifecycle: &[skillhub_core::api::SkillLifecycleFilter], deployment| {
            skillhub_core::api::SkillListFilters {
                tags: tags.iter().map(|tag| tag.to_string()).collect(),
                lifecycle: lifecycle.to_vec(),
                deployment,
                ..Default::default()
            }
        };

    assert_eq!(
        query_skill_names(
            &facade,
            filters(
                &["documents"],
                &[],
                skillhub_core::api::SkillDeploymentFilter::Any
            ),
            default_sort.clone()
        )
        .await,
        vec!["Alpha".to_owned(), "Gamma".to_owned()]
    );
    assert_eq!(
        query_skill_names(
            &facade,
            filters(
                &[],
                &[skillhub_core::api::SkillLifecycleFilter::Trial],
                skillhub_core::api::SkillDeploymentFilter::Any
            ),
            default_sort.clone()
        )
        .await,
        vec!["Beta".to_owned()]
    );
    assert_eq!(
        query_skill_names(
            &facade,
            filters(
                &[],
                &[skillhub_core::api::SkillLifecycleFilter::Active],
                skillhub_core::api::SkillDeploymentFilter::Any
            ),
            default_sort.clone()
        )
        .await,
        vec!["Alpha".to_owned()]
    );
    assert_eq!(
        query_skill_names(
            &facade,
            filters(
                &[],
                &[skillhub_core::api::SkillLifecycleFilter::Archived],
                skillhub_core::api::SkillDeploymentFilter::Any
            ),
            default_sort.clone()
        )
        .await,
        vec!["Gamma".to_owned()]
    );
    assert_eq!(
        query_skill_names(
            &facade,
            filters(
                &[],
                &[],
                skillhub_core::api::SkillDeploymentFilter::Deployed
            ),
            default_sort.clone()
        )
        .await,
        vec!["Alpha".to_owned()]
    );
    assert_eq!(
        query_skill_names(
            &facade,
            filters(
                &[],
                &[],
                skillhub_core::api::SkillDeploymentFilter::NotDeployed
            ),
            default_sort
        )
        .await,
        vec!["Beta".to_owned(), "Gamma".to_owned()]
    );
}

#[tokio::test]
async fn list_skills_query_filters_by_current_version_check_state() {
    let database = Database::open_in_memory().expect("database");
    let alpha = Skill::new(SkillId::new(), "Alpha");
    let beta = Skill::new(SkillId::new(), "Beta");
    let repository = database.catalog_repository().expect("catalog repository");
    repository.insert(&alpha).await.expect("insert alpha");
    repository.insert(&beta).await.expect("insert beta");

    let alpha_current = skillhub_core::VersionId::parse(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("alpha current");
    let alpha_stale = skillhub_core::VersionId::parse(
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .expect("alpha stale");
    let beta_current = skillhub_core::VersionId::parse(
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    )
    .expect("beta current");
    seed_version_and_current_pointer(&database, alpha.id(), &alpha_current, "1.0.0");
    database
        .connection_for_test()
        .execute_batch(&format!(
            "INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at,source_version) VALUES ('{alpha_stale}','{}','hash-stale','{{}}',0,'0.9.0');",
            alpha.id()
        ))
        .expect("seed stale version");
    seed_version_and_current_pointer(&database, beta.id(), &beta_current, "2.0.0");

    let check_repository = database.check_repository();
    let mut stale_failed = skillhub_core::check::CheckRun::completed(
        "alpha-stale-basic",
        alpha.id(),
        alpha_stale.clone(),
        CheckKind::Basic,
        vec![skillhub_core::check::Finding::new(
            "stale-finding",
            "security.secret",
            Severity::Error,
        )],
    );
    stale_failed.generation = 1;
    stale_failed.started_at = 10;
    check_repository
        .insert(&stale_failed)
        .await
        .expect("insert stale run");
    let mut current_passed = skillhub_core::check::CheckRun::completed(
        "alpha-current-basic",
        alpha.id(),
        alpha_current.clone(),
        CheckKind::Basic,
        Vec::new(),
    );
    current_passed.generation = 2;
    current_passed.started_at = 20;
    check_repository
        .insert(&current_passed)
        .await
        .expect("insert current run");
    let beta_failed = skillhub_core::check::CheckRun::completed(
        "beta-current-basic",
        beta.id(),
        beta_current.clone(),
        CheckKind::Basic,
        vec![skillhub_core::check::Finding::new(
            "beta-finding",
            "security.secret",
            Severity::Warning,
        )],
    );
    check_repository
        .insert(&beta_failed)
        .await
        .expect("insert beta run");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 9, 5));
    let with_basic = |states: &[CheckState]| skillhub_core::api::SkillListFilters {
        basic_check: states.to_vec(),
        ..Default::default()
    };

    assert_eq!(
        query_skill_names(
            &facade,
            with_basic(&[CheckState::Passed]),
            Default::default()
        )
        .await,
        vec!["Alpha".to_owned()]
    );
    assert_eq!(
        query_skill_names(
            &facade,
            with_basic(&[CheckState::Failed]),
            Default::default()
        )
        .await,
        vec!["Beta".to_owned()]
    );
    assert_eq!(
        query_skill_names(
            &facade,
            skillhub_core::api::SkillListFilters {
                ai_check: vec![CheckState::NotChecked],
                ..Default::default()
            },
            Default::default()
        )
        .await,
        vec!["Alpha".to_owned(), "Beta".to_owned()]
    );
}

#[tokio::test]
async fn list_skills_query_returns_real_status_fields_and_sorts_by_agent_deployments() {
    let database = Database::open_in_memory().expect("database");
    let alpha = Skill::new(SkillId::new(), "Alpha")
        .with_tag("documents")
        .with_author("Ada");
    let beta = Skill::new(SkillId::new(), "Beta");
    let repository = database.catalog_repository().expect("catalog repository");
    repository.insert(&alpha).await.expect("insert alpha");
    repository.insert(&beta).await.expect("insert beta");

    let source_root = tempfile::tempdir().expect("source root");
    database
        .source_repository()
        .relink(
            alpha.id(),
            SourceDescriptor::new(
                SourceKind::Local,
                SourceLocator::LocalPath(source_root.path().to_path_buf()),
            ),
        )
        .expect("relink source");

    let alpha_current = skillhub_core::VersionId::parse(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("alpha current");
    seed_version_and_current_pointer(&database, alpha.id(), &alpha_current, "1.0.0");
    database
        .connection_for_test()
        .execute_batch(
            "INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('agent-codex','codex','global','C:/agents/codex',0);\
             INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('agent-claude','claude','global','C:/agents/claude',0);",
        )
        .expect("seed agent targets");
    let make_deployment = |target_id: &str| DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id: alpha.id(),
        version_id: alpha_current.clone(),
        target_id: target_id.into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "alpha".into(),
        expected_hash: "sha256:tree".into(),
        observed_hash: None,
    };
    let deployment_repository = database.deployment_repository();
    deployment_repository
        .insert(&make_deployment("agent-codex"))
        .await
        .expect("insert codex deployment");
    deployment_repository
        .insert(&make_deployment("agent-claude"))
        .await
        .expect("insert claude deployment");

    let high_risk_run = skillhub_core::check::CheckRun::completed(
        "alpha-basic",
        alpha.id(),
        alpha_current.clone(),
        CheckKind::Basic,
        vec![skillhub_core::check::Finding::new(
            "alpha-finding",
            "security.secret",
            Severity::Error,
        )],
    );
    database
        .check_repository()
        .insert(&high_risk_run)
        .await
        .expect("insert basic run");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 9, 5));
    let result = facade
        .query(RootAppQuery::ListSkills(ListSkills {
            text: String::new(),
            page: 1,
            page_size: 50,
            filters: Default::default(),
            sort: skillhub_core::api::SkillListSort {
                column: skillhub_core::api::SkillSortColumn::AgentDeployments,
                direction: skillhub_core::api::SkillSortDirection::Desc,
            },
        }))
        .await
        .expect("list result");
    let AppQueryResult::SkillPage(page) = result else {
        panic!("expected skill page");
    };
    assert_eq!(page.items.len(), 2);
    let alpha_item = page
        .items
        .iter()
        .find(|item| item.display_name == "Alpha")
        .expect("alpha item");
    assert_eq!(alpha_item.author.as_deref(), Some("Ada"));
    assert_eq!(alpha_item.source_kind.as_deref(), Some("local"));
    assert_eq!(
        alpha_item.source_locator.as_deref(),
        Some(source_root.path().to_string_lossy().as_ref())
    );
    assert_eq!(alpha_item.current_version, Some(alpha_current.clone()));
    assert_eq!(alpha_item.current_version_label.as_deref(), Some("1.0.0"));
    assert_eq!(alpha_item.agent_deployment_count, 2);
    assert_eq!(
        alpha_item.agent_deployment_target_ids,
        vec!["agent-claude".to_owned(), "agent-codex".to_owned()]
    );
    assert_eq!(alpha_item.project_deployment_count, 0);
    assert_eq!(alpha_item.basic_check, CheckState::Failed);
    assert_eq!(alpha_item.ai_check, CheckState::NotChecked);
    assert_eq!(alpha_item.high_risk_count, 1);

    let beta_item = page
        .items
        .iter()
        .find(|item| item.display_name == "Beta")
        .expect("beta item");
    assert_eq!(beta_item.author, None);
    assert_eq!(beta_item.source_kind, None);
    assert_eq!(beta_item.current_version, None);
    assert_eq!(beta_item.agent_deployment_count, 0);
    assert_eq!(beta_item.basic_check, CheckState::NotChecked);
    assert_eq!(beta_item.high_risk_count, 0);

    assert_eq!(page.items[0].display_name, "Alpha");
    assert_eq!(page.items[1].display_name, "Beta");
}

#[tokio::test]
async fn markdown_queries_read_the_current_version_as_read_only_content() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Markdown preview");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Preview\n").expect("write skill");
    std::fs::create_dir_all(source.path().join("docs")).expect("docs");
    std::fs::write(source.path().join("docs/usage.md"), "## Usage\n").expect("write usage");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let store = VersionStore::from_library(&library);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");

    let facade = LocalApplicationFacade::new_with_library(database, root.path());
    let detail = facade
        .query(RootAppQuery::GetSkill(GetSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("skill detail");
    let AppQueryResult::Skill(detail) = detail else {
        panic!("expected skill detail");
    };
    assert_eq!(
        detail.current_version.as_ref().map(|id| id.as_str()),
        Some(version.id.as_str())
    );

    let files = facade
        .query(RootAppQuery::ListMarkdownFiles(ListMarkdownFiles {
            skill_id: skill.id(),
        }))
        .await
        .expect("markdown files");
    let AppQueryResult::MarkdownFiles(files) = files else {
        panic!("expected markdown files");
    };
    assert_eq!(
        files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["SKILL.md", "docs/usage.md"]
    );
    assert!(files[0].primary);
    assert!(!files[1].primary);

    let content = facade
        .query(RootAppQuery::ReadMarkdownFile(ReadMarkdownFile {
            skill_id: skill.id(),
            path: "SKILL.md".into(),
        }))
        .await
        .expect("markdown content");
    let AppQueryResult::MarkdownFile(content) = content else {
        panic!("expected markdown content");
    };
    assert_eq!(content.path, "SKILL.md");
    assert_eq!(content.markdown, "# Preview\n");
    assert_eq!(
        content.content_identity,
        version
            .manifest
            .entries
            .iter()
            .find(|entry| entry.path == "SKILL.md")
            .unwrap()
            .object_id
    );
    assert!(content.editable);

    let versions = facade
        .query(RootAppQuery::ListVersions(ListVersions {
            skill_id: skill.id(),
        }))
        .await
        .expect("versions");
    let AppQueryResult::Versions(versions) = versions else {
        panic!("expected versions");
    };
    assert_eq!(versions.len(), 1);
    assert!(versions[0].current);
    assert_eq!(versions[0].file_count, 2);

    let diff = facade
        .query(RootAppQuery::DiffVersions(DiffVersions {
            left: version.id.clone(),
            right: version.id.clone(),
        }))
        .await
        .expect("version diff");
    let AppQueryResult::VersionDiff(diff) = diff else {
        panic!("expected version diff");
    };
    assert!(diff.added.is_empty());
}

#[tokio::test]
async fn backup_preflight_reads_current_skill_content_and_rejects_unscoped_selection() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Backup candidate");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Safe backup\n").expect("write skill");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let store = VersionStore::from_library(&library);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    library
        .save_portable_skill(&skill, Some(&version.id))
        .expect("save portable skill");

    let facade = LocalApplicationFacade::new_with_library(database, root.path());
    let result = facade
        .execute(AppCommand::PrepareBackup(
            skillhub_core::api::PrepareBackup {
                scope: BackupScope::Full,
            },
        ))
        .await
        .expect("backup plan");
    let AppCommandResult::BackupPlan(plan) = result else {
        panic!("expected backup plan");
    };
    assert_eq!(plan.scope, BackupScope::Full);
    assert!(plan.sensitive_items.is_empty());

    let error = facade
        .execute(AppCommand::PrepareBackup(
            skillhub_core::api::PrepareBackup {
                scope: BackupScope::SelectedSkills,
            },
        ))
        .await
        .expect_err("selected scope should require skill IDs");
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[tokio::test]
async fn backup_preflight_reports_sensitive_skill_content() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Sensitive backup candidate");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "api_key=placeholder\n").expect("write skill");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let store = VersionStore::from_library(&library);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    library
        .save_portable_skill(&skill, Some(&version.id))
        .expect("save portable skill");

    let facade = LocalApplicationFacade::new_with_library(database, root.path());
    let result = facade
        .execute(AppCommand::PrepareBackup(
            skillhub_core::api::PrepareBackup {
                scope: BackupScope::Full,
            },
        ))
        .await
        .expect("backup plan");
    let AppCommandResult::BackupPlan(plan) = result else {
        panic!("expected backup plan");
    };
    assert_eq!(plan.sensitive_items.len(), 1);
    assert_eq!(plan.sensitive_items[0].skill_id, skill.id());
    assert_eq!(
        plan.sensitive_items[0].reason,
        "possible_plaintext_credential"
    );
}

#[tokio::test]
async fn backup_create_returns_a_verified_package_path_and_verify_rejects_missing_decision() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Backup export");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "api_key=placeholder\n").expect("write skill");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let store = VersionStore::from_library(&library);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    library
        .save_portable_skill(&skill, Some(&version.id))
        .expect("save portable skill");
    let facade = LocalApplicationFacade::new_with_library(database, root.path());

    let missing = facade
        .execute(AppCommand::CreateBackup(CreateBackup {
            scope: BackupScope::Full,
            decisions: vec![],
        }))
        .await
        .expect_err("sensitive decision is required");
    assert_eq!(missing.code, ErrorCode::BackupSensitiveDecisionRequired);

    let result = facade
        .execute(AppCommand::CreateBackup(CreateBackup {
            scope: BackupScope::Full,
            decisions: vec![skillhub_core::BackupDecision {
                skill_id: skill.id(),
                decision: skillhub_core::backup::SensitiveContentDecision::IncludeAndMark,
            }],
        }))
        .await
        .expect("create backup");
    let AppCommandResult::BackupCreated(created) = result else {
        panic!("expected created backup result");
    };
    assert!(std::path::Path::new(&created.path).is_dir());
    let backup_json =
        std::fs::read_to_string(std::path::Path::new(&created.path).join("backup.json"))
            .expect("backup manifest");
    assert!(!backup_json.contains(root.path().to_string_lossy().as_ref()));

    let verified = facade
        .execute(AppCommand::VerifyBackup(VerifyBackup {
            path: created.path,
        }))
        .await
        .expect("verify backup");
    let AppCommandResult::BackupManifest(manifest) = verified else {
        panic!("expected backup manifest");
    };
    assert!(manifest.contains_sensitive_skill_content);
}

#[tokio::test]
async fn restore_commands_prepare_and_commit_portable_package_with_explicit_conflict_choice() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Restorable skill");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let package_root = tempfile::tempdir().expect("package root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Restored\n").expect("write skill");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let store = VersionStore::from_library(&library);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    library
        .save_portable_skill(&skill, Some(&version.id))
        .expect("save portable skill");

    let backup = skillhub_storage::backup::BackupService::new(package_root.path().to_path_buf());
    let input = skillhub_core::backup::BackupInput::new(
        BackupScope::Full,
        r#"{"deployments":[{"target_path":"C:\\Users\\old\\.agents"}]}"#,
        vec![(skill.id(), "# Restored\n".to_owned())],
    );
    let package = backup
        .create(&input, &backup.prepare(&input).expect("backup plan"), &[])
        .expect("backup package");
    std::fs::create_dir_all(root.path().join("skills").join(skill.id().to_string()))
        .expect("existing skill dir");
    std::fs::write(
        root.path()
            .join("skills")
            .join(skill.id().to_string())
            .join("SKILL.md"),
        "# Keep live\n",
    )
    .expect("existing live skill");
    let facade = LocalApplicationFacade::new_with_library(database, root.path());

    let prepared = facade
        .execute(AppCommand::PrepareRestore(PrepareRestore {
            path: package.root.to_string_lossy().into_owned(),
        }))
        .await
        .expect("prepare restore");
    let AppCommandResult::RestorePlan(plan) = prepared else {
        panic!("expected restore plan");
    };
    assert_eq!(plan.skills, 1);
    assert_eq!(plan.deployments_requiring_rediscovery, 1);
    assert_eq!(plan.conflicts.len(), 1);

    let missing = facade
        .execute(AppCommand::CommitRestore(CommitRestore {
            path: package.root.to_string_lossy().into_owned(),
            decisions: Vec::new(),
        }))
        .await
        .expect_err("conflict decision is required");
    assert_eq!(missing.code, ErrorCode::BackupRestoreDecisionRequired);

    let committed = facade
        .execute(AppCommand::CommitRestore(CommitRestore {
            path: package.root.to_string_lossy().into_owned(),
            decisions: vec![RestoreDecision {
                skill_id: skill.id(),
                decision: RestoreConflictDecision::Skip,
            }],
        }))
        .await
        .expect("commit restore");
    let AppCommandResult::RestoreResult(result) = committed else {
        panic!("expected restore result");
    };
    assert_eq!(result.skills_restored, 0);
    assert_eq!(result.skills_skipped, 1);
    assert_eq!(result.deployments_requiring_rediscovery, 1);
    assert_eq!(
        std::fs::read_to_string(
            root.path()
                .join("skills")
                .join(skill.id().to_string())
                .join("SKILL.md")
        )
        .expect("live skill"),
        "# Keep live\n"
    );
    let restored_metadata = std::fs::read_to_string(root.path().join("portable/skills.json"))
        .expect("restored portable metadata");
    assert!(!restored_metadata.contains("C:\\Users\\old"));
}

#[tokio::test]
async fn restore_prepare_rejects_missing_package_path() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(root.path()).expect("central library");
    let facade = LocalApplicationFacade::new_with_library(database, root.path());
    let missing_path = root.path().join("does-not-exist");

    let error = facade
        .execute(AppCommand::PrepareRestore(PrepareRestore {
            path: missing_path.to_string_lossy().into_owned(),
        }))
        .await
        .expect_err("missing package must fail");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
}

#[tokio::test]
async fn rolling_backup_creates_verified_package_then_applies_retention() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Rolling backup skill");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "api_key=placeholder\n")
        .expect("write sensitive skill");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let store = VersionStore::from_library(&library);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    library
        .save_portable_skill(&skill, Some(&version.id))
        .expect("save portable skill");
    let facade = LocalApplicationFacade::new_with_library(database, root.path());

    let missing = facade
        .execute(AppCommand::RunRollingBackup(RunRollingBackup {
            scope: BackupScope::Full,
            retention: BackupRetentionPolicy { max_backups: 1 },
            decisions: Vec::new(),
        }))
        .await
        .expect_err("sensitive decision is required");
    assert_eq!(missing.code, ErrorCode::BackupSensitiveDecisionRequired);
    assert_eq!(
        std::fs::read_dir(root.path().join(".skillhub").join("backups"))
            .expect("backup directory")
            .count(),
        0
    );

    for _ in 0..2 {
        let result = facade
            .execute(AppCommand::RunRollingBackup(RunRollingBackup {
                scope: BackupScope::Full,
                retention: BackupRetentionPolicy { max_backups: 1 },
                decisions: vec![skillhub_core::BackupDecision {
                    skill_id: skill.id(),
                    decision: SensitiveContentDecision::IncludeAndMark,
                }],
            }))
            .await
            .expect("rolling backup");
        let AppCommandResult::BackupRetentionResult(retention) = result else {
            panic!("expected retention result");
        };
        assert_eq!(retention.retained, 1);
    }
    let backups = std::fs::read_dir(root.path().join(".skillhub").join("backups"))
        .expect("backup directory")
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1);
    assert!(backups[0]
        .file_name()
        .to_string_lossy()
        .starts_with("skillhub-backup-"));
}

#[tokio::test]
async fn current_version_command_switches_only_to_a_version_of_the_same_skill() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Versioned skill");
    let other_skill = Skill::new(skillhub_core::SkillId::new(), "Other skill");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&other_skill)
        .await
        .expect("insert other skill");

    let root = tempfile::tempdir().expect("library root");
    let source_a = tempfile::tempdir().expect("source a");
    std::fs::write(source_a.path().join("SKILL.md"), "# First\n").expect("write first");
    let source_b = tempfile::tempdir().expect("source b");
    std::fs::write(source_b.path().join("SKILL.md"), "# Second\n").expect("write second");
    let source_other = tempfile::tempdir().expect("other source");
    std::fs::write(source_other.path().join("SKILL.md"), "# Other\n").expect("write other");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let store = VersionStore::from_library(&library);
    let first = store
        .capture(skill.id(), source_a.path())
        .expect("capture first");
    let second = store
        .capture(skill.id(), source_b.path())
        .expect("capture second");
    let other = store
        .capture(other_skill.id(), source_other.path())
        .expect("capture other");
    store
        .set_current(skill.id(), &first.id)
        .expect("set initial current");

    let facade = LocalApplicationFacade::new_with_library(database, root.path());
    let result = facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: skill.id(),
            version_id: second.id.clone(),
        }))
        .await
        .expect("switch current version");
    assert!(
        matches!(result, AppCommandResult::OperationSummary(summary) if summary.phase == skillhub_core::OperationPhase::Committed)
    );

    let detail = facade
        .query(RootAppQuery::GetSkill(GetSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("skill detail");
    let AppQueryResult::Skill(detail) = detail else {
        panic!("expected skill detail");
    };
    assert_eq!(detail.current_version, Some(second.id.clone()));
    assert_eq!(
        CentralLibrary::initialize(root.path())
            .expect("central library")
            .load_portable_skill(skill.id())
            .expect("portable skill")
            .and_then(|(_, current)| current),
        Some(second.id.clone())
    );

    let error = facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: skill.id(),
            version_id: other.id,
        }))
        .await
        .expect_err("cross-skill version must be rejected");
    assert_eq!(error.code, ErrorCode::InvalidInput);
    let current = facade
        .query(RootAppQuery::GetSkill(GetSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("skill detail after rejection");
    let AppQueryResult::Skill(current) = current else {
        panic!("expected skill detail");
    };
    assert_eq!(current.current_version, Some(second.id));
}

#[tokio::test]
async fn save_skill_content_captures_a_new_version_and_rejects_invalid_sources() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Editable skill");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let store = VersionStore::from_library(&library);
    let initial = tempfile::tempdir().expect("initial source");
    std::fs::write(initial.path().join("SKILL.md"), "# Initial\n").expect("write initial");
    let first = store
        .capture(skill.id(), initial.path())
        .expect("capture initial");
    store
        .set_current(skill.id(), &first.id)
        .expect("set initial current");

    let updated = tempfile::tempdir().expect("updated source");
    std::fs::write(updated.path().join("SKILL.md"), "# Updated\n").expect("write updated");
    let facade = LocalApplicationFacade::new_with_library(database, root.path());
    let result = facade
        .execute(AppCommand::SaveSkillContent(SaveSkillContent {
            skill_id: skill.id(),
            source_path: updated.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect("save skill content");
    assert!(
        matches!(result, AppCommandResult::OperationSummary(summary) if summary.phase == skillhub_core::OperationPhase::Committed)
    );

    let versions = facade
        .query(RootAppQuery::ListVersions(ListVersions {
            skill_id: skill.id(),
        }))
        .await
        .expect("list versions");
    let AppQueryResult::Versions(versions) = versions else {
        panic!("expected versions");
    };
    assert_eq!(versions.len(), 2);
    assert_eq!(versions.iter().filter(|version| version.current).count(), 1);
    assert!(!versions
        .iter()
        .any(|version| version.current && version.version_id == first.id));

    let invalid = tempfile::tempdir().expect("invalid source");
    let error = facade
        .execute(AppCommand::SaveSkillContent(SaveSkillContent {
            skill_id: skill.id(),
            source_path: invalid.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect_err("missing SKILL.md must be rejected");
    assert_eq!(error.code, ErrorCode::InvalidInput);
    let after = facade
        .query(RootAppQuery::ListVersions(ListVersions {
            skill_id: skill.id(),
        }))
        .await
        .expect("list versions after rejection");
    let AppQueryResult::Versions(after) = after else {
        panic!("expected versions");
    };
    assert_eq!(after.len(), 2);
    assert_eq!(after.iter().filter(|version| version.current).count(), 1);
}

#[tokio::test]
async fn save_markdown_content_creates_a_version_and_rejects_stale_identity() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Markdown editor");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let store = VersionStore::from_library(&library);
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Initial\n").expect("write source");
    let first = store
        .capture(skill.id(), source.path())
        .expect("capture source");
    store
        .set_current(skill.id(), &first.id)
        .expect("set current");
    let (identity, _) = store
        .read_file(&first.id, "SKILL.md", 1024)
        .expect("read identity");

    let facade = LocalApplicationFacade::new_with_library(database, root.path());
    let result = facade
        .execute(AppCommand::SaveMarkdownContent(SaveMarkdownContent {
            skill_id: skill.id(),
            path: "SKILL.md".into(),
            markdown: "# Edited\n".into(),
            expected_identity: identity.clone(),
        }))
        .await
        .expect("save markdown");
    let AppCommandResult::SavedSkillContent(saved) = result else {
        panic!("expected saved skill content");
    };
    assert_eq!(saved.skill_id, skill.id());
    assert_eq!(saved.path, "SKILL.md");
    assert_ne!(saved.version_id, first.id);
    assert_ne!(saved.content_identity, identity);

    let content = facade
        .query(RootAppQuery::ReadMarkdownFile(ReadMarkdownFile {
            skill_id: skill.id(),
            path: "SKILL.md".into(),
        }))
        .await
        .expect("read saved markdown");
    let AppQueryResult::MarkdownFile(content) = content else {
        panic!("expected markdown content");
    };
    assert_eq!(content.markdown, "# Edited\n");
    assert_eq!(content.content_identity, saved.content_identity);

    let error = facade
        .execute(AppCommand::SaveMarkdownContent(SaveMarkdownContent {
            skill_id: skill.id(),
            path: "SKILL.md".into(),
            markdown: "# Stale\n".into(),
            expected_identity: identity,
        }))
        .await
        .expect_err("stale identity must be rejected");
    assert_eq!(error.code, ErrorCode::OperationConflict);
}

#[tokio::test]
async fn prepare_delete_skill_command_returns_explicit_impact() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Delete me");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let facade = LocalApplicationFacade::new(database);
    let result = facade
        .execute(AppCommand::PrepareDeleteSkill(PrepareDeleteSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("prepare delete");
    let AppCommandResult::RemovalImpact(impact) = result else {
        panic!("expected removal impact");
    };
    assert_eq!(impact.skill_id, skill.id());
    assert!(impact.deployments.is_empty());
}

#[tokio::test]
async fn delete_skill_commit_removes_catalog_portable_metadata_and_versions() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Delete me");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Delete me\n").expect("write source");
    let store = VersionStore::from_library(&library);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    library
        .save_portable_skill(&skill, Some(&version.id))
        .expect("save portable metadata");

    let facade = LocalApplicationFacade::new_with_library(database, root.path());
    let prepared = facade
        .execute(AppCommand::PrepareDeleteSkill(PrepareDeleteSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("prepare delete");
    let AppCommandResult::RemovalImpact(impact) = prepared else {
        panic!("expected removal impact");
    };
    let result = facade
        .execute(AppCommand::CommitDeleteSkill(
            skillhub_core::api::CommitDeleteSkill {
                prepared_delete_id: impact.operation_id,
                decisions: Vec::new(),
            },
        ))
        .await
        .expect("commit delete");
    let AppCommandResult::RemovalResult(result) = result else {
        panic!("expected removal result");
    };
    assert!(result.central_skill_deleted);
    assert!(facade
        .query(RootAppQuery::GetSkill(GetSkill {
            skill_id: skill.id()
        }))
        .await
        .is_err());
    assert!(store.list(skill.id()).expect("list versions").is_empty());
    assert!(library
        .load_portable_skill(skill.id())
        .expect("portable metadata")
        .is_none());
}

#[tokio::test]
async fn deployment_queries_return_only_relationships_for_the_requested_skill() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Relations");
    let other_skill = Skill::new(skillhub_core::SkillId::new(), "Other");
    let catalog = database.catalog_repository().expect("catalog repository");
    catalog.insert(&skill).await.expect("insert skill");
    catalog
        .insert(&other_skill)
        .await
        .expect("insert other skill");
    let version_id = skillhub_core::VersionId::parse(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("version id");
    database
        .connection_for_test()
        .execute_batch(&format!(
            "INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES ('{version_id}','{}','hash','{{}}',0);\
             INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES ('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','{}','hash','{{}}',0);\
             INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('agent-codex','codex','global','C:/agents/codex',0);\
             INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('agent-planned','planned','global','C:/agents/planned',0);\
             INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('agent-removed','removed','global','C:/agents/removed',0);\
             INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('agent-other','other','global','C:/agents/other',0);",
            skill.id(), other_skill.id()
        ))
        .expect("insert version and target facts");
    let other_version_id = skillhub_core::VersionId::parse(
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .expect("other version id");
    let make_deployment = |skill_id: skillhub_core::SkillId,
                           version_id: skillhub_core::VersionId,
                           target_id: &str| DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id,
        version_id,
        target_id: target_id.into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "relations".into(),
        expected_hash: "sha256:tree".into(),
        observed_hash: Some("sha256:tree".into()),
    };
    let repository = database.deployment_repository();
    repository
        .insert(&make_deployment(
            skill.id(),
            version_id.clone(),
            "agent-codex",
        ))
        .await
        .expect("insert skill deployment");
    let mut planned = make_deployment(skill.id(), version_id.clone(), "agent-planned");
    planned.state = DeploymentState::Planned;
    repository
        .insert(&planned)
        .await
        .expect("insert planned deployment");
    let mut removed = make_deployment(skill.id(), version_id.clone(), "agent-removed");
    removed.state = DeploymentState::Removed;
    repository
        .insert(&removed)
        .await
        .expect("insert removed deployment");
    repository
        .insert(&make_deployment(
            other_skill.id(),
            other_version_id,
            "agent-other",
        ))
        .await
        .expect("insert other deployment");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 29));
    let list = facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill.id()),
        }))
        .await
        .expect("list deployments");
    let AppQueryResult::Deployments(deployments) = list else {
        panic!("expected deployment list");
    };
    assert_eq!(deployments.len(), 3);
    assert!(deployments
        .iter()
        .any(|deployment| deployment.target_id == "agent-codex"));

    let relations = facade
        .query(RootAppQuery::GetDeploymentRelations(
            GetDeploymentRelations {
                skill_id: skill.id(),
            },
        ))
        .await
        .expect("deployment relations");
    let AppQueryResult::DeploymentRelations(relations) = relations else {
        panic!("expected deployment relations");
    };
    assert_eq!(relations.len(), 1);
    assert_eq!(relations[0].target_id, "agent-codex");
}

#[tokio::test]
async fn deployment_plan_query_resolves_registered_target_and_returns_preview() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Deployable");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let library_root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Deployable\n").expect("write skill");
    let library = CentralLibrary::initialize(library_root.path()).expect("central library");
    let version = VersionStore::from_library(&library)
        .capture(skill.id(), source.path())
        .expect("capture version");
    let target = tempfile::tempdir().expect("target");
    let physical_id = skillhub_core::physical_id_for_path(target.path()).expect("target id");
    let targets = RegisteredTargetIndex::from_facts(
        [TargetFact::registered(
            "agent-codex",
            target.path(),
            physical_id,
            TargetFactSource::Discovery,
            DeploymentCapability::new(false, false, true),
        )],
        PathPolicy::from_roots([skillhub_core::AllowedRoot::new(target.path()).expect("root")])
            .expect("policy"),
    )
    .expect("target index");

    let facade = LocalApplicationFacade::new_with_library_and_targets(
        database,
        library_root.path(),
        targets,
    );
    let result = facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: DeploymentPlanRequest {
                skill_id: skill.id(),
                version_id: version.id.clone(),
                runtime_name: "deployable".into(),
                logical_target_ids: vec!["agent-codex".into()],
                mode_override: Some(DeploymentMode::ManagedCopy),
            },
        }))
        .await
        .expect("deployment plan");
    let AppQueryResult::DeploymentPlan(plan) = result else {
        panic!("expected deployment plan");
    };
    assert_eq!(plan.skill_id, skill.id());
    assert_eq!(plan.version_id, version.id);
    assert_eq!(plan.targets.len(), 1);
    assert_eq!(plan.targets[0].logical_target_ids, ["agent-codex"]);
}

#[tokio::test]
async fn deployment_plan_query_rejects_unregistered_target() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Deployable");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("central library");
    let target = tempfile::tempdir().expect("target");
    let physical_id = skillhub_core::physical_id_for_path(target.path()).expect("target id");
    let targets = RegisteredTargetIndex::from_facts(
        [TargetFact::registered(
            "agent-codex",
            target.path(),
            physical_id,
            TargetFactSource::Discovery,
            DeploymentCapability::new(false, false, true),
        )],
        PathPolicy::from_roots([skillhub_core::AllowedRoot::new(target.path()).expect("root")])
            .expect("policy"),
    )
    .expect("target index");
    let facade = LocalApplicationFacade::new_with_library_and_targets(
        database,
        library_root.path(),
        targets,
    );
    let error = facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: DeploymentPlanRequest {
                skill_id: skill.id(),
                version_id: skillhub_core::VersionId::parse(
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                )
                .expect("version id"),
                runtime_name: "deployable".into(),
                logical_target_ids: vec!["missing".into()],
                mode_override: None,
            },
        }))
        .await
        .expect_err("unregistered target should fail");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
}

#[tokio::test]
async fn deployment_plan_query_builds_target_index_from_discovery_for_production_facade() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Deployable");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let library_root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Deployable\n").expect("write skill");
    let library = CentralLibrary::initialize(library_root.path()).expect("central library");
    let version = VersionStore::from_library(&library)
        .capture(skill.id(), source.path())
        .expect("capture version");
    let target = tempfile::tempdir().expect("target");
    let physical_id = skillhub_core::physical_id_for_path(target.path()).expect("target id");
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-08-30T00:00:00Z".into(),
            instances: Vec::new(),
            logical_targets: vec![LogicalTarget {
                id: "agent-codex".into(),
                profile_id: "codex".into(),
                client_id: "codex.cli".into(),
                scope: TargetScope::Global,
                path: target.path().to_string_lossy().into_owned(),
                marker: "SKILL.md".into(),
                precedence: DirectoryPrecedence::Preferred,
                exists: true,
                readable: true,
                writable: true,
                available: true,
                physical_id,
            }],
            physical_targets: Vec::new(),
        })
        .expect("save discovery");

    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let result = facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: DeploymentPlanRequest {
                skill_id: skill.id(),
                version_id: version.id,
                runtime_name: "deployable".into(),
                logical_target_ids: vec!["agent-codex".into()],
                mode_override: Some(DeploymentMode::ManagedCopy),
            },
        }))
        .await
        .expect("production deployment plan");
    let AppQueryResult::DeploymentPlan(plan) = result else {
        panic!("expected deployment plan");
    };
    assert_eq!(plan.targets.len(), 1);
    assert_eq!(plan.targets[0].logical_target_ids, ["agent-codex"]);
}

#[tokio::test]
async fn deployment_plan_query_resolves_registered_project_with_copy_as_default() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Deployable");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let library_root = tempfile::tempdir().expect("library root");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Deployable\n").expect("write skill");
    let library = CentralLibrary::initialize(library_root.path()).expect("central library");
    let version = VersionStore::from_library(&library)
        .capture(skill.id(), source.path())
        .expect("capture version");
    let project_root = tempfile::tempdir().expect("project root");
    let project = database
        .project_repository()
        .register(Project::new(
            skillhub_core::ProjectId::new(),
            "Aurora",
            project_root.path(),
        ))
        .expect("register project");

    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let result = facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: DeploymentPlanRequest {
                skill_id: skill.id(),
                version_id: version.id,
                runtime_name: "deployable".into(),
                logical_target_ids: vec![project.id.to_string()],
                mode_override: None,
            },
        }))
        .await
        .expect("project deployment plan");
    let AppQueryResult::DeploymentPlan(plan) = result else {
        panic!("expected deployment plan");
    };
    assert_eq!(plan.targets.len(), 1);
    assert_eq!(plan.targets[0].logical_target_ids, [project.id.to_string()]);
    assert_eq!(plan.targets[0].mode, DeploymentMode::ManagedCopy);
}

#[tokio::test]
async fn deployment_target_query_includes_discovery_and_registered_project_targets() {
    let database = Database::open_in_memory().expect("database");
    let snapshot = DiscoverySnapshot {
        generation: "1".into(),
        observed_at: "2026-08-30T00:00:00Z".into(),
        instances: vec![ClientInstance {
            profile_id: "codex".into(),
            client_id: "codex.cli".into(),
            kind: ClientKind::Cli,
            supported_os: vec![OperatingSystem::Windows],
            client_presence: ClientPresence::Unknown,
        }],
        logical_targets: vec![LogicalTarget {
            id: "codex-global".into(),
            profile_id: "codex".into(),
            client_id: "codex.cli".into(),
            scope: TargetScope::Global,
            path: "C:/Users/demo/.codex/skills".into(),
            marker: "SKILL.md".into(),
            precedence: DirectoryPrecedence::Preferred,
            exists: true,
            readable: true,
            writable: true,
            available: true,
            physical_id: "fs:codex".into(),
        }],
        physical_targets: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save discovery");
    let project_root = tempfile::tempdir().expect("project root");
    let project = Project::new(
        skillhub_core::ProjectId::new(),
        "Aurora",
        project_root.path(),
    );
    let project = database
        .project_repository()
        .register(project)
        .expect("register project");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 30));
    let result = facade
        .query(RootAppQuery::ListDeploymentTargets(
            skillhub_core::ListDeploymentTargets,
        ))
        .await
        .expect("deployment targets");
    let AppQueryResult::DeploymentTargets(targets) = result else {
        panic!("expected deployment targets");
    };
    assert_eq!(targets.len(), 2);
    assert_eq!(targets[0].id, "codex-global");
    // The advertised modes mirror the running environment's link support, so
    // derive the expectation from the same probe instead of hard-coding it.
    let symlink_supported = skillhub_adapters::deployment::DeploymentFilesystem::new()
        .available_capabilities()
        .symlink;
    let mut expected_modes = vec![DeploymentMode::ManagedCopy];
    if symlink_supported {
        expected_modes.insert(0, DeploymentMode::SymbolicLink);
    }
    assert_eq!(targets[0].modes, expected_modes);
    assert!(targets[0].available);
    let project_target = targets
        .iter()
        .find(|target| target.id == project.id.to_string())
        .expect("project target");
    assert_eq!(project_target.label, "Aurora");
    assert_eq!(project_target.path, project.device_path);
    assert!(project_target.available);
    assert!(project_target.modes.contains(&DeploymentMode::ManagedCopy));
}

#[tokio::test]
async fn deployment_commands_prepare_commit_and_persist_managed_copy() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Deployable");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Deployable\n").expect("write source");
    let target = tempfile::tempdir().expect("target");
    let version_id = skillhub_core::VersionId::parse(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("version id");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version_id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    let target_id = skillhub_core::physical_id_for_path(target.path()).expect("target id");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'agent-codex', 'global', ?2, 0)",
            rusqlite::params![target_id, target.path().to_string_lossy().into_owned()],
        )
        .expect("insert target");
    let plan = DeploymentPlan {
        skill_id: skill.id(),
        version_id: version_id.clone(),
        runtime_name: "deployable".into(),
        mode: DeploymentMode::ManagedCopy,
        warnings: Vec::new(),
        conflicts: Vec::new(),
        targets: vec![TargetPlan {
            physical_target_id: target_id,
            logical_target_ids: vec!["agent-codex".into()],
            target_path: target.path().to_string_lossy().into_owned(),
            destination_path: target
                .path()
                .join("deployable")
                .to_string_lossy()
                .into_owned(),
            source_path: source.path().to_string_lossy().into_owned(),
            runtime_name: "deployable".into(),
            skill_id: skill.id(),
            version_id: version_id.clone(),
            mode: DeploymentMode::ManagedCopy,
            change: TargetChange::Create,
            warnings: Vec::new(),
            conflicts: Vec::new(),
        }],
    };
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("central library");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let prepared = facade
        .execute(AppCommand::PrepareDeployment(PrepareDeployment { plan }))
        .await
        .expect("prepare deployment");
    let AppCommandResult::PreparedDeployment(prepared) = prepared else {
        panic!("expected prepared deployment");
    };
    let summary = facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("commit deployment");
    let AppCommandResult::DeploymentSummary(summary) = summary else {
        panic!("expected deployment summary");
    };
    assert!(summary.committed);
    assert!(target.path().join("deployable/SKILL.md").is_file());
    let records = facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill.id()),
        }))
        .await
        .expect("deployment records");
    let AppQueryResult::Deployments(records) = records else {
        panic!("expected deployment records");
    };
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].version_id, version_id);

    let impact = facade
        .query(RootAppQuery::GetRemovalImpact(GetRemovalImpact {
            skill_id: skill.id(),
        }))
        .await
        .expect("removal impact");
    let AppQueryResult::RemovalImpact(impact) = impact else {
        panic!("expected removal impact");
    };
    assert_eq!(impact.skill_id, skill.id());
    assert_eq!(impact.deployments, records);
    assert!(!impact.requires_shared_target_choice);

    let prepared = facade
        .execute(AppCommand::PrepareUndeploy(PrepareUndeploy {
            deployment_id: impact.deployments[0].id,
        }))
        .await
        .expect("prepare undeploy");
    let AppCommandResult::RemovalImpact(prepared) = prepared else {
        panic!("expected prepared removal impact");
    };
    let removed = facade
        .execute(AppCommand::CommitUndeploy(CommitUndeploy {
            prepared_undeploy_id: prepared.operation_id,
            decision: RemovalDecision::RemoveOwnedTarget,
        }))
        .await
        .expect("commit undeploy");
    let AppCommandResult::RemovalResult(removed) = removed else {
        panic!("expected removal result");
    };
    assert!(removed.decisions[0].target_removed);
    assert!(removed.decisions[0].relation_removed);
    assert!(!target.path().join("deployable").exists());
    let after_removal = facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill.id()),
        }))
        .await
        .expect("deployment records after removal");
    let AppQueryResult::Deployments(after_removal) = after_removal else {
        panic!("expected deployment records after removal");
    };
    assert_eq!(after_removal.len(), 1);
    assert_eq!(after_removal[0].state, DeploymentState::Removed);
}

#[tokio::test]
async fn failed_deployment_keeps_prepared_operation_and_source_for_retry() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Retryable");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let source = tempfile::tempdir().expect("source");
    let source_file = source.path().join("SKILL.md");
    std::fs::write(&source_file, "# Retryable\n").expect("write source");
    let target = tempfile::tempdir().expect("target");
    let version_id = skillhub_core::VersionId::parse(
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .expect("version id");
    let target_id = skillhub_core::physical_id_for_path(target.path()).expect("target id");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version_id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'agent-codex', 'global', ?2, 0)",
            rusqlite::params![target_id, target.path().to_string_lossy().into_owned()],
        )
        .expect("insert target");
    let missing_parent = target.path().join("not-ready");
    let plan = DeploymentPlan {
        skill_id: skill.id(),
        version_id: version_id.clone(),
        runtime_name: "retryable".into(),
        mode: DeploymentMode::ManagedCopy,
        warnings: Vec::new(),
        conflicts: Vec::new(),
        targets: vec![TargetPlan {
            physical_target_id: target_id,
            logical_target_ids: vec!["agent-codex".into()],
            target_path: missing_parent.to_string_lossy().into_owned(),
            destination_path: missing_parent
                .join("retryable")
                .to_string_lossy()
                .into_owned(),
            source_path: source.path().to_string_lossy().into_owned(),
            runtime_name: "retryable".into(),
            skill_id: skill.id(),
            version_id: version_id.clone(),
            mode: DeploymentMode::ManagedCopy,
            change: TargetChange::Create,
            warnings: Vec::new(),
            conflicts: Vec::new(),
        }],
    };
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("central library");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let prepared = facade
        .execute(AppCommand::PrepareDeployment(PrepareDeployment { plan }))
        .await
        .expect("prepare deployment");
    let AppCommandResult::PreparedDeployment(prepared) = prepared else {
        panic!("expected prepared deployment");
    };
    let first = facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("failed commit should return summary");
    let AppCommandResult::DeploymentSummary(first) = first else {
        panic!("expected deployment summary");
    };
    assert!(!first.committed);
    assert!(source_file.is_file());
    std::fs::create_dir_all(&missing_parent).expect("repair target");
    let second = facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("retry commit");
    let AppCommandResult::DeploymentSummary(second) = second else {
        panic!("expected deployment summary");
    };
    assert!(second.committed);
    assert!(missing_parent.join("retryable/SKILL.md").is_file());
}

#[tokio::test]
async fn undeploy_preserves_modified_target_and_relation_for_review() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Protected");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let version_id = skillhub_core::VersionId::parse(
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    )
    .expect("version id");
    let target = tempfile::tempdir().expect("target");
    let destination = target.path().join("protected");
    std::fs::create_dir_all(&destination).expect("create destination");
    std::fs::write(destination.join("SKILL.md"), "# original\n").expect("write destination");
    let target_id = skillhub_core::physical_id_for_path(target.path()).expect("target id");
    let expected_hash =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&destination)
            .expect("hash destination");
    let deployment_id = skillhub_core::DeploymentId::new();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version_id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'agent-codex', 'global', ?2, 0)",
            rusqlite::params![target_id, target.path().to_string_lossy().into_owned()],
        )
        .expect("insert target");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO deployments (id, skill_id, version_id, target_id, state, method, managed, runtime_name, expected_hash, observed_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'deployed', 'managed_copy', 1, 'protected', ?5, ?5, 0, 0)",
            rusqlite::params![
                deployment_id.to_string(),
                skill.id().to_string(),
                version_id.to_string(),
                target_id,
                expected_hash,
            ],
        )
        .expect("insert deployment");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 30));
    let prepared = facade
        .execute(AppCommand::PrepareUndeploy(PrepareUndeploy {
            deployment_id,
        }))
        .await
        .expect("prepare undeploy");
    let AppCommandResult::RemovalImpact(prepared) = prepared else {
        panic!("expected prepared removal impact");
    };
    std::fs::write(destination.join("SKILL.md"), "# changed\n").expect("modify destination");
    let error = facade
        .execute(AppCommand::CommitUndeploy(CommitUndeploy {
            prepared_undeploy_id: prepared.operation_id,
            decision: RemovalDecision::RemoveOwnedTarget,
        }))
        .await
        .expect_err("modified target must be protected");
    assert_eq!(error.code, ErrorCode::OwnershipMismatch);
    assert!(destination.is_dir());
    let records = facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill.id()),
        }))
        .await
        .expect("deployment records");
    let AppQueryResult::Deployments(records) = records else {
        panic!("expected deployment records");
    };
    assert_eq!(records[0].state, DeploymentState::Deployed);
}

#[tokio::test]
async fn reconcile_query_detects_modified_target_and_keep_independent_updates_relation() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Reconcile");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let version_id = skillhub_core::VersionId::parse(
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    )
    .expect("version id");
    let target = tempfile::tempdir().expect("target");
    let destination = target.path().join("reconcile");
    std::fs::create_dir_all(&destination).expect("create destination");
    std::fs::write(destination.join("SKILL.md"), "# changed\n").expect("write destination");
    let target_id = skillhub_core::physical_id_for_path(target.path()).expect("target id");
    let original_hash = "sha256:original-tree";
    let deployment_id = skillhub_core::DeploymentId::new();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version_id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'agent-codex', 'global', ?2, 0)",
            rusqlite::params![target_id, target.path().to_string_lossy().into_owned()],
        )
        .expect("insert target");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO deployments (id, skill_id, version_id, target_id, state, method, managed, runtime_name, expected_hash, observed_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'deployed', 'managed_copy', 1, 'reconcile', ?5, ?5, 0, 0)",
            rusqlite::params![
                deployment_id.to_string(),
                skill.id().to_string(),
                version_id.to_string(),
                target_id,
                original_hash,
            ],
        )
        .expect("insert deployment");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 30));
    let plan = facade
        .query(RootAppQuery::GetReconcilePlan(GetReconcilePlan {
            deployment_id,
        }))
        .await
        .expect("reconcile plan");
    let AppQueryResult::ReconcilePlan(plan) = plan else {
        panic!("expected reconcile plan");
    };
    assert_eq!(plan.state, ExternalChangeState::Modified);
    assert!(plan
        .allowed_actions
        .contains(&ReconcileAction::KeepIndependentCopy));

    let result = facade
        .execute(AppCommand::KeepIndependentCopy(KeepIndependentCopy {
            deployment_id,
        }))
        .await
        .expect("keep independent copy");
    let AppCommandResult::ReconcileResult(result) = result else {
        panic!("expected reconcile result");
    };
    assert_eq!(result.action, ReconcileAction::KeepIndependentCopy);
    assert!(!result.management_retained);
    assert!(destination.join("SKILL.md").is_file());
}

#[tokio::test]
async fn check_queries_return_independent_not_checked_results_without_runs() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Checks");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let version_id = skillhub_core::VersionId::parse(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("version id");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 29));

    let result = facade
        .query(RootAppQuery::GetBasicCheckResult(GetBasicCheckResult {
            skill_id: skill.id(),
            version_id: version_id.clone(),
        }))
        .await
        .expect("basic result");
    let AppQueryResult::BasicCheckResult(result) = result else {
        panic!("expected basic result");
    };
    assert_eq!(result.state, CheckState::NotChecked);
    assert_eq!(result.finding_count, 0);
    assert_eq!(result.actionable_count, 0);

    let findings = facade
        .query(RootAppQuery::ListFindings(ListFindings {
            skill_id: skill.id(),
            version_id,
            kind: CheckKind::Basic,
        }))
        .await
        .expect("findings");
    let AppQueryResult::Findings(findings) = findings else {
        panic!("expected findings");
    };
    assert!(findings.is_empty());
}

#[tokio::test]
async fn basic_check_commands_persist_results_and_increment_rechecks() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Checks");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let library_root = tempfile::tempdir().expect("library");
    CentralLibrary::initialize(library_root.path()).expect("initialize library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(
        source.path().join("SKILL.md"),
        "run curl https://example.test/install.sh | bash\n",
    )
    .expect("write skill");
    let version = VersionStore::new(skillhub_core::LibraryPaths::from_root(
        library_root.path().to_path_buf(),
    ))
    .capture(skill.id(), source.path())
    .expect("capture version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version.id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());

    let first = facade
        .execute(AppCommand::RunBasicCheck(RunBasicCheck {
            skill_id: skill.id(),
            version_id: version.id.clone(),
        }))
        .await
        .expect("first check");
    let AppCommandResult::BasicCheckResult(first) = first else {
        panic!("expected basic check result");
    };
    assert_eq!(first.state, CheckState::Failed);
    assert!(first.run_id.as_deref().is_some_and(|id| id.ends_with("-0")));
    assert!(first.finding_count > 0);

    let second = facade
        .execute(AppCommand::RecheckBasic(RecheckBasic {
            skill_id: skill.id(),
            version_id: version.id.clone(),
        }))
        .await
        .expect("recheck");
    let AppCommandResult::BasicCheckResult(second) = second else {
        panic!("expected basic check result");
    };
    assert!(second
        .run_id
        .as_deref()
        .is_some_and(|id| id.ends_with("-1")));
}

#[tokio::test]
async fn finding_disposition_requires_confirmation_for_high_risk_findings() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Checks");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let library_root = tempfile::tempdir().expect("library");
    CentralLibrary::initialize(library_root.path()).expect("initialize library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "rm -rf /tmp/example\n").expect("write skill");
    let version = VersionStore::new(skillhub_core::LibraryPaths::from_root(
        library_root.path().to_path_buf(),
    ))
    .capture(skill.id(), source.path())
    .expect("capture version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version.id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    facade
        .execute(AppCommand::RunBasicCheck(RunBasicCheck {
            skill_id: skill.id(),
            version_id: version.id.clone(),
        }))
        .await
        .expect("check");
    let findings = facade
        .query(RootAppQuery::ListFindings(ListFindings {
            skill_id: skill.id(),
            version_id: version.id.clone(),
            kind: CheckKind::Basic,
        }))
        .await
        .expect("findings");
    let AppQueryResult::Findings(findings) = findings else {
        panic!("expected findings");
    };
    let finding = findings
        .iter()
        .find(|finding| finding.high_risk)
        .expect("high risk finding");
    let error = facade
        .execute(AppCommand::SetFindingDisposition(SetFindingDisposition {
            skill_id: skill.id(),
            version_id: version.id.clone(),
            kind: CheckKind::Basic,
            finding_id: finding.id.clone(),
            disposition: FindingDisposition::Acknowledged,
            high_risk_confirmed: false,
        }))
        .await
        .expect_err("high risk confirmation required");
    assert_eq!(error.code, ErrorCode::InvalidInput);
    facade
        .execute(AppCommand::SetFindingDisposition(SetFindingDisposition {
            skill_id: skill.id(),
            version_id: version.id,
            kind: CheckKind::Basic,
            finding_id: finding.id.clone(),
            disposition: FindingDisposition::Acknowledged,
            high_risk_confirmed: true,
        }))
        .await
        .expect("acknowledge finding");
}

#[tokio::test]
async fn llm_check_without_configuration_returns_info_without_persisting_a_run() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Checks");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let library_root = tempfile::tempdir().expect("library");
    CentralLibrary::initialize(library_root.path()).expect("initialize library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "safe content\n").expect("write skill");
    let version = VersionStore::new(skillhub_core::LibraryPaths::from_root(
        library_root.path().to_path_buf(),
    ))
    .capture(skill.id(), source.path())
    .expect("capture version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version.id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let error = facade
        .execute(AppCommand::RunLlmSafetyCheck(RunLlmSafetyCheck {
            skill_id: skill.id(),
            version_id: version.id.clone(),
        }))
        .await
        .expect_err("LLM must be optional");
    assert_eq!(error.code, ErrorCode::LlmNotConfigured);
    assert_eq!(error.severity, Severity::Info);
    let result = facade
        .query(RootAppQuery::GetLlmSafetyCheckResult(
            skillhub_core::GetLlmSafetyCheckResult {
                skill_id: skill.id(),
                version_id: version.id,
            },
        ))
        .await
        .expect("LLM result");
    let AppQueryResult::LlmSafetyCheckResult(result) = result else {
        panic!("expected LLM result");
    };
    assert_eq!(result.state, CheckState::NotChecked);
}

#[tokio::test]
async fn configured_llm_check_persists_structured_findings_and_rechecks() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Checks");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let profile = skillhub_core::LlmProfile::new(
        "test",
        "https://llm.example.test/v1/chat/completions",
        "test-model",
        None,
    )
    .expect("profile");
    database
        .llm_profile_repository()
        .save(&profile)
        .expect("save profile");
    let library_root = tempfile::tempdir().expect("library");
    CentralLibrary::initialize(library_root.path()).expect("initialize library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "quoted content\n").expect("write skill");
    let version = VersionStore::new(skillhub_core::LibraryPaths::from_root(
        library_root.path().to_path_buf(),
    ))
    .capture(skill.id(), source.path())
    .expect("capture version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version.id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    let facade = LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        library_root.path(),
        std::sync::Arc::new(StaticLlmRunner),
    );
    let result = facade
        .execute(AppCommand::RunLlmSafetyCheck(RunLlmSafetyCheck {
            skill_id: skill.id(),
            version_id: version.id.clone(),
        }))
        .await
        .expect("LLM check");
    let AppCommandResult::LlmSafetyCheckResult(result) = result else {
        panic!("expected LLM result");
    };
    assert_eq!(result.state, CheckState::Failed);
    assert_eq!(result.finding_count, 1);
    let rechecked = facade
        .execute(AppCommand::RecheckLlmSafety(
            skillhub_core::RecheckLlmSafety {
                skill_id: skill.id(),
                version_id: version.id,
            },
        ))
        .await
        .expect("LLM recheck");
    let AppCommandResult::LlmSafetyCheckResult(rechecked) = rechecked else {
        panic!("expected LLM result");
    };
    assert!(rechecked
        .run_id
        .as_deref()
        .is_some_and(|id| id.ends_with("-1")));
}

#[tokio::test]
async fn catalog_metadata_commands_update_skill_detail_atomically() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Original");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 30));

    facade
        .execute(AppCommand::RenameSkill(RenameSkill {
            skill_id: skill.id(),
            name: "Renamed".to_owned(),
        }))
        .await
        .expect("rename");
    facade
        .execute(AppCommand::SetMetadata(SetMetadata {
            skill_id: skill.id(),
            display_name: None,
            note: Some("for tests".to_owned()),
            tags: vec!["utility".to_owned(), "utility".to_owned()],
            author: Some("Author".to_owned()),
            license: Some("MIT".to_owned()),
        }))
        .await
        .expect("metadata");
    facade
        .execute(AppCommand::SetLifecycle(SetLifecycle {
            skill_id: skill.id(),
            lifecycle: skillhub_core::catalog::SkillLifecycle::Deprecated,
        }))
        .await
        .expect("lifecycle");
    facade
        .execute(AppCommand::SetTrial(SetTrial {
            skill_id: skill.id(),
            due: Some((2026, 9, 1)),
        }))
        .await
        .expect("trial");

    let AppQueryResult::Skill(detail) = facade
        .query(RootAppQuery::GetSkill(GetSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("detail")
    else {
        panic!("expected skill detail");
    };
    assert_eq!(detail.display_name, "Renamed");
    assert_eq!(detail.user_note.as_deref(), Some("for tests"));
    assert_eq!(detail.tags, vec!["temporary_trial", "utility"]);
    assert_eq!(
        detail.lifecycle,
        skillhub_core::catalog::SkillLifecycle::Deprecated
    );
    assert_eq!(detail.trial_due, Some("2026-09-01".to_owned()));
}

#[tokio::test]
async fn catalog_metadata_rejects_invalid_updates_without_partial_write() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Original");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 30));
    let error = facade
        .execute(AppCommand::RenameSkill(RenameSkill {
            skill_id: skill.id(),
            name: "  ".to_owned(),
        }))
        .await
        .expect_err("empty name");
    assert_eq!(error.code, ErrorCode::InvalidInput);
    let AppQueryResult::Skill(detail) = facade
        .query(RootAppQuery::GetSkill(GetSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("detail")
    else {
        panic!("expected skill detail");
    };
    assert_eq!(detail.display_name, "Original");
}

#[tokio::test]
async fn uninstall_backup_action_creates_restorable_package_before_undeploy() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Backup before removal");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(
        source.path().join("SKILL.md"),
        "# Backup me
",
    )
    .expect("write source");
    let target = tempfile::tempdir().expect("target");
    let root = tempfile::tempdir().expect("library root");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let version = VersionStore::from_library(&library)
        .capture(skill.id(), source.path())
        .expect("capture version");
    VersionStore::from_library(&library)
        .set_current(skill.id(), &version.id)
        .expect("set current");
    let version_id = skillhub_core::VersionId::parse(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("version id");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version_id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    let target_id = skillhub_core::physical_id_for_path(target.path()).expect("target id");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'agent-codex', 'global', ?2, 0)",
            rusqlite::params![target_id, target.path().to_string_lossy().into_owned()],
        )
        .expect("insert target");
    let plan = DeploymentPlan {
        skill_id: skill.id(),
        version_id: version_id.clone(),
        runtime_name: "backup-candidate".into(),
        mode: DeploymentMode::ManagedCopy,
        warnings: Vec::new(),
        conflicts: Vec::new(),
        targets: vec![TargetPlan {
            physical_target_id: target_id,
            logical_target_ids: vec!["agent-codex".into()],
            target_path: target.path().to_string_lossy().into_owned(),
            destination_path: target
                .path()
                .join("backup-candidate")
                .to_string_lossy()
                .into_owned(),
            source_path: source.path().to_string_lossy().into_owned(),
            runtime_name: "backup-candidate".into(),
            skill_id: skill.id(),
            version_id: version_id.clone(),
            mode: DeploymentMode::ManagedCopy,
            change: TargetChange::Create,
            warnings: Vec::new(),
            conflicts: Vec::new(),
        }],
    };
    let facade = LocalApplicationFacade::new_with_library(database, root.path());
    let prepared = facade
        .execute(AppCommand::PrepareDeployment(PrepareDeployment { plan }))
        .await
        .expect("prepare deployment");
    let AppCommandResult::PreparedDeployment(prepared) = prepared else {
        panic!("expected prepared deployment");
    };
    facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("commit deployment");
    let records = facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill.id()),
        }))
        .await
        .expect("deployment records");
    let AppQueryResult::Deployments(records) = records else {
        panic!("expected deployment records");
    };
    assert_eq!(records.len(), 1);

    facade
        .execute(AppCommand::PrepareUninstall(
            skillhub_core::PrepareUninstall {
                deployment_ids: vec![records[0].id],
            },
        ))
        .await
        .expect("prepare uninstall");

    let result = facade
        .execute(AppCommand::ApplyUninstallDecision(
            skillhub_core::ApplyUninstallDecision {
                actions: vec![
                    skillhub_core::UninstallAction::Backup,
                    skillhub_core::UninstallAction::UndeployAll,
                ],
            },
        ))
        .await
        .expect("apply with backup");
    let AppCommandResult::OperationSummary(summary) = result else {
        panic!("expected operation summary");
    };
    assert_eq!(
        summary.message_code,
        "uninstall.decision_applied_with_backup"
    );

    // 卸载备份必须真实落盘（可恢复的包），而不是只改一条状态记录。
    let backups_dir = root.path().join(".skillhub").join("backups");
    assert!(backups_dir.is_dir(), "backups dir missing");
    let manifest_files = walk_files(&backups_dir)
        .into_iter()
        .filter(|file| {
            file.file_name()
                .map(|name| name == "backup.json")
                .unwrap_or(false)
        })
        .count();
    assert!(manifest_files >= 1, "no backup package manifest found");

    // undeploy 依然生效
    let listed = facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill.id()),
        }))
        .await
        .expect("list after uninstall");
    let AppQueryResult::Deployments(listed) = listed else {
        panic!("expected deployments");
    };
    assert!(listed.is_empty() || listed.iter().all(|d| d.state != DeploymentState::Deployed));
}

#[tokio::test]
async fn uninstall_backup_without_library_root_aborts_before_undeploy() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "No library");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let version_id = skillhub_core::VersionId::parse(
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .expect("version id");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES (?1,?2,'hash','{}',0)",
            rusqlite::params![version_id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('target-uninstall','agent','global','C:/agent',0)",
            [],
        )
        .expect("insert target");
    let deployment = DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id: skill.id(),
        version_id,
        target_id: "target-uninstall".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "uninstall-candidate".into(),
        expected_hash: "sha256:tree".into(),
        observed_hash: Some("sha256:tree".into()),
    };
    database
        .deployment_repository()
        .insert(&deployment)
        .await
        .expect("insert deployment");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 30));

    facade
        .execute(AppCommand::PrepareUninstall(
            skillhub_core::PrepareUninstall {
                deployment_ids: vec![deployment.id],
            },
        ))
        .await
        .expect("prepare uninstall");

    // 无集中库根时 backup 无法创建：整体中止，不得先卸载。
    let error = facade
        .execute(AppCommand::ApplyUninstallDecision(
            skillhub_core::ApplyUninstallDecision {
                actions: vec![
                    skillhub_core::UninstallAction::Backup,
                    skillhub_core::UninstallAction::UndeployAll,
                ],
            },
        ))
        .await
        .expect_err("backup without library must abort");
    let _ = error;

    let listed = facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill.id()),
        }))
        .await
        .expect("list after abort");
    let AppQueryResult::Deployments(listed) = listed else {
        panic!("expected deployments");
    };
    assert_eq!(listed[0].managed, true);
    assert_eq!(listed[0].state, DeploymentState::Deployed);
}
