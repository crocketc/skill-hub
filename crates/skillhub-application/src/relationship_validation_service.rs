//! Governable-relationship validation service (plan Task 5A).
//!
//! Loads active source-copy relations by scope, probes each path, derives the
//! business verdict with the pure core mapping (level-aware: Light never
//! judges occupancy or content), and persists updates or the single archiving
//! transition (MissingWithAccessibleParent → ExternalRemoved + history) in
//! one transaction per relation. Per-item failures are reported; they never
//! abort the batch.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use skillhub_adapters::import::SkillDetector;
use skillhub_adapters::relationship::FilesystemRelationshipProbe;
use skillhub_core::agent::{AgentDirectoryIdentity, AgentDirectoryProjection, AgentDirectoryRole};
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, RelationshipOverviewScope, RunRelationshipCheck,
};
use skillhub_core::project::Project;
use skillhub_core::relationship::{
    analyze_environment_problems, evaluate_relationship_probe, merge_environment_problem_analyses,
    update_is_meaningful, AgentDirectoryCapabilityFact, DirectoryNodeFact, DirectoryRecognition,
    DirectoryRole, EnvironmentProblemAnalysis, RelationshipCheckItem, RelationshipCheckItemStatus,
    RelationshipCheckLevel, RelationshipCheckReport, RelationshipCheckScope, RelationshipPathProbe,
    SourceCopyRelationFact, SourceCopyTransition, UsageEnvironmentDirectory, UsageEnvironmentEntry,
    UsageEnvironmentKey, UsageEnvironmentProbeLimitation, UsageEnvironmentProbeLimitationReason,
    UsageEnvironmentSnapshot,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{AppError, AppResult, OperationId, ProjectId};
use skillhub_storage::Database;

use crate::ClassifiedImportSource;
use crate::LocalApplicationFacade;

/// Relationship-path probing abstraction. Production resolves through the
/// real filesystem; tests inject controlled verdicts (permission walls,
/// offline volumes) that cannot be simulated portably.
pub trait RelationshipPathProbing: Send + Sync {
    fn probe(&self, path: &Path) -> RelationshipPathProbe;
}

impl RelationshipPathProbing for FilesystemRelationshipProbe {
    fn probe(&self, path: &Path) -> RelationshipPathProbe {
        FilesystemRelationshipProbe::probe(self, path)
    }
}

pub(crate) fn default_relationship_probe() -> Arc<dyn RelationshipPathProbing> {
    Arc::new(FilesystemRelationshipProbe)
}

impl LocalApplicationFacade {
    /// 扫描所有 Agent 自身与 Agent × 已注册项目环境。只有数据库确认过的
    /// 目录识别关系会进入文件扫描；发现文件不代表 Agent 已加载或执行文件。
    pub(crate) fn get_usage_environment_problems(&self) -> AppResult<AppQueryResult> {
        let (analysis, _) = self.scan_usage_environment_state()?;
        Ok(AppQueryResult::UsageEnvironmentProblems(analysis))
    }

    /// Returns the same fresh scan used by the read query together with the
    /// per-environment snapshots needed to validate a cleanup decision.
    pub(crate) fn scan_usage_environment_state(
        &self,
    ) -> AppResult<(EnvironmentProblemAnalysis, Vec<UsageEnvironmentSnapshot>)> {
        let directory_projection = match self.get_agent_directory_projection()? {
            AppQueryResult::AgentDirectoryProjection(projection) => projection,
            _ => unreachable!("get_agent_directory_projection returns its projection"),
        };
        let overview = match self.get_relationship_overview(RelationshipOverviewScope::All)? {
            AppQueryResult::RelationshipOverview(overview) => overview,
            _ => unreachable!("get_relationship_overview returns its projection"),
        };
        let library = self.library_runtime.snapshot()?;
        let (discovery, projects, revision) =
            self.with_database("query.usage_environment_problems.facts", |database| {
                Ok((
                    database
                        .agent_repository()
                        .load()?
                        .unwrap_or_else(crate::empty_discovery),
                    database.project_repository().list()?,
                    database.relationship_repository().relationship_revision()?,
                ))
            })?;
        let mut environments = Vec::new();
        let mut agent_ids = discovery
            .instances
            .iter()
            .map(|instance| instance.client_id.clone())
            .collect::<BTreeSet<_>>();
        // A declared shared-directory consumer remains in the scan even when
        // discovery no longer reports its client. Governance must surface that
        // unknown scope so destructive shared migration fails closed instead
        // of silently omitting the consumer.
        let shared_directory_ids = overview
            .directory_nodes
            .iter()
            .filter(|node| node.role == DirectoryRole::SharedDirectory)
            .map(|node| node.node_id.as_str())
            .collect::<BTreeSet<_>>();
        agent_ids.extend(
            overview
                .agent_directory_capabilities
                .iter()
                .filter(|capability| {
                    shared_directory_ids.contains(capability.directory_node_id.as_str())
                })
                .map(|capability| capability.agent_client_id.clone()),
        );
        for agent_client_id in &agent_ids {
            environments.push(UsageEnvironmentKey {
                agent_client_id: agent_client_id.clone(),
                project_id: None,
            });
            for project in &projects {
                environments.push(UsageEnvironmentKey {
                    agent_client_id: agent_client_id.clone(),
                    project_id: Some(project.id),
                });
            }
        }
        environments.sort_by_key(usage_environment_sort_key);
        environments.dedup();

        let mut analyses = Vec::<EnvironmentProblemAnalysis>::with_capacity(environments.len());
        let mut snapshots = Vec::with_capacity(environments.len());
        for environment in environments {
            let snapshot = build_usage_environment_snapshot(
                environment,
                &projects,
                &overview.directory_nodes,
                &overview.agent_directory_capabilities,
                &directory_projection,
                &overview.usage_relations,
                &library.store,
                revision,
            );
            analyses.push(analyze_environment_problems(&snapshot));
            snapshots.push(snapshot);
        }
        Ok((merge_environment_problem_analyses(&analyses), snapshots))
    }

    /// 仅供测试：注入受控探测结果（权限/离线卷等无法跨平台模拟的场景）。
    #[doc(hidden)]
    pub fn set_relationship_probe_for_tests(&self, probe: Arc<dyn RelationshipPathProbing>) {
        *self.relationship_probe.lock().expect("relationship probe") = probe;
    }

    pub(crate) fn run_relationship_check(
        &self,
        request: RunRelationshipCheck,
    ) -> AppResult<AppCommandResult> {
        let now = now_epoch_seconds();
        let library = self.library_runtime.snapshot()?;
        let central_root = library.root.to_string_lossy().into_owned();
        let mut items = Vec::new();
        self.with_database("execute.run_relationship_check.select", |database| {
            let selected = select_relations_for_scope(database, &request.scope)?;
            for relation in selected {
                let item = check_one_relation(
                    self,
                    database,
                    relation,
                    &request,
                    &central_root,
                    &library.store,
                    now,
                );
                items.push(item);
            }
            Ok(())
        })?;
        let relationship_revision = self
            .with_database("execute.run_relationship_check.revision", |database| {
                database.relationship_repository().relationship_revision()
            })?;
        items.sort_by(|left, right| left.relation_id.cmp(&right.relation_id));
        Ok(AppCommandResult::RelationshipCheckReport(
            RelationshipCheckReport {
                items,
                relationship_revision,
            },
        ))
    }
}

#[allow(clippy::too_many_arguments)]
fn build_usage_environment_snapshot(
    environment: UsageEnvironmentKey,
    projects: &[Project],
    directory_nodes: &[DirectoryNodeFact],
    capabilities: &[AgentDirectoryCapabilityFact],
    directory_projection: &AgentDirectoryProjection,
    usage_relations: &[skillhub_core::relationship::UsageRelationView],
    store: &skillhub_storage::VersionStore,
    relationship_revision: i64,
) -> UsageEnvironmentSnapshot {
    let mut recognized_directories = Vec::new();
    let mut discovered_entries = Vec::new();
    let mut probe_limitations = Vec::<UsageEnvironmentProbeLimitation>::new();

    for node in directory_nodes {
        if node.role == DirectoryRole::CentralLibrary {
            continue;
        }
        let project_owner = registered_project_containing(&node.path, projects);
        if node.role == DirectoryRole::Project {
            match (environment.project_id, project_owner) {
                (Some(current), Some(owner)) if current == owner => {}
                (None, None) => {}
                _ => continue,
            }
        }
        if node.role != DirectoryRole::SharedDirectory
            && node.agent_client_id.as_deref() != Some(environment.agent_client_id.as_str())
        {
            continue;
        }

        let capability = capabilities.iter().find(|capability| {
            capability.agent_client_id == environment.agent_client_id
                && capability.directory_node_id == node.node_id
        });
        if node.role == DirectoryRole::SharedDirectory && capability.is_none() {
            continue;
        }
        let recognition = capability
            .map(|capability| capability.recognition)
            .unwrap_or(DirectoryRecognition::Unknown);
        let physical_identity = skillhub_core::physical_id_for_path(&node.path);
        if physical_identity.is_none() {
            probe_limitations.push(UsageEnvironmentProbeLimitation {
                directory_id: Some(node.node_id.clone()),
                relative_entry_path: None,
                reason: UsageEnvironmentProbeLimitationReason::DirectoryIdentityUnavailable,
            });
        }
        let role = projected_directory_role(
            node,
            physical_identity.as_deref(),
            directory_projection,
            project_owner,
        );
        let mut consumers = if node.role == DirectoryRole::SharedDirectory {
            capabilities
                .iter()
                .filter(|candidate| {
                    candidate.directory_node_id == node.node_id
                        && candidate.recognition == DirectoryRecognition::Supported
                })
                .map(|candidate| UsageEnvironmentKey {
                    agent_client_id: candidate.agent_client_id.clone(),
                    project_id: None,
                })
                .collect::<Vec<_>>()
        } else {
            vec![environment.clone()]
        };
        consumers.sort_by_key(usage_environment_sort_key);
        consumers.dedup();
        let directory = UsageEnvironmentDirectory {
            directory_id: node.node_id.clone(),
            path: node.path.clone(),
            role,
            recognition,
            physical_identity,
            consumers,
        };
        recognized_directories.push(directory);

        if recognition != DirectoryRecognition::Supported {
            continue;
        }
        let root = Path::new(&node.path);
        if !root.is_dir() {
            probe_limitations.push(UsageEnvironmentProbeLimitation {
                directory_id: Some(node.node_id.clone()),
                relative_entry_path: None,
                reason: UsageEnvironmentProbeLimitationReason::DirectoryUnavailable,
            });
            continue;
        }
        let candidates = match SkillDetector::default().detect(
            root,
            SourceDescriptor::new(
                SourceKind::Local,
                SourceLocator::local_path(PathBuf::from(&node.path)),
            ),
        ) {
            Ok(candidates) => candidates,
            Err(_) => {
                probe_limitations.push(UsageEnvironmentProbeLimitation {
                    directory_id: Some(node.node_id.clone()),
                    relative_entry_path: None,
                    reason: UsageEnvironmentProbeLimitationReason::ScanFailed,
                });
                continue;
            }
        };
        for candidate in candidates {
            let entry_path = PathBuf::from(&candidate.absolute_root);
            let content_fingerprint = match store.hash_tree_read_only(&entry_path) {
                Ok(fingerprint) => Some(fingerprint),
                Err(_) => {
                    probe_limitations.push(UsageEnvironmentProbeLimitation {
                        directory_id: Some(node.node_id.clone()),
                        relative_entry_path: Some(candidate.relative_root.clone()),
                        reason:
                            UsageEnvironmentProbeLimitationReason::ContentFingerprintUnavailable,
                    });
                    None
                }
            };
            let physical_identity = skillhub_core::physical_id_for_path(&entry_path);
            if physical_identity.is_none() {
                probe_limitations.push(UsageEnvironmentProbeLimitation {
                    directory_id: Some(node.node_id.clone()),
                    relative_entry_path: Some(candidate.relative_root.clone()),
                    reason: UsageEnvironmentProbeLimitationReason::EntryIdentityUnavailable,
                });
            }
            discovered_entries.push(UsageEnvironmentEntry {
                directory_id: node.node_id.clone(),
                directory_path: Some(node.path.clone()),
                directory_role: Some(role),
                relative_entry_path: candidate.relative_root,
                runtime_name: Some(candidate.runtime_name),
                content_fingerprint,
                physical_identity,
                skill_id: None,
                relation_ids: Vec::new(),
            });
        }
    }

    recognized_directories.sort_by(|left, right| left.directory_id.cmp(&right.directory_id));
    discovered_entries.sort_by(|left, right| {
        left.directory_id
            .cmp(&right.directory_id)
            .then_with(|| left.relative_entry_path.cmp(&right.relative_entry_path))
    });
    probe_limitations.sort_by_key(|limitation| {
        (
            limitation.directory_id.clone(),
            limitation.relative_entry_path.clone(),
            format!("{:?}", limitation.reason),
        )
    });
    probe_limitations.dedup();

    UsageEnvironmentSnapshot {
        environment,
        recognized_directories,
        discovered_entries,
        usage_relations: usage_relations.to_vec(),
        probe_limitations,
        relationship_revision: relationship_revision.to_string(),
    }
}

fn projected_directory_role(
    node: &DirectoryNodeFact,
    physical_identity: Option<&str>,
    projection: &AgentDirectoryProjection,
    project_owner: Option<ProjectId>,
) -> AgentDirectoryRole {
    let projected = projection.directories.iter().find(|directory| {
        let same_physical_identity = match (&directory.identity, physical_identity) {
            (AgentDirectoryIdentity::VerifiedPhysical(expected), Some(actual)) => {
                expected == actual
            }
            _ => false,
        };
        same_physical_identity || paths_resolve_to_same_directory(&directory.path, &node.path)
    });
    if let Some(projected) = projected {
        if projected.is_shared_directory {
            return AgentDirectoryRole::SharedDirectory;
        }
        if projected.role == AgentDirectoryRole::Project {
            return if project_owner.is_some() {
                AgentDirectoryRole::Project
            } else {
                AgentDirectoryRole::AgentWorkspace
            };
        }
        return projected.role;
    }
    match node.role {
        DirectoryRole::AgentNative => AgentDirectoryRole::AgentUser,
        DirectoryRole::SharedDirectory => AgentDirectoryRole::SharedDirectory,
        DirectoryRole::Project => {
            if project_owner.is_some() {
                AgentDirectoryRole::Project
            } else {
                AgentDirectoryRole::AgentWorkspace
            }
        }
        DirectoryRole::CentralLibrary => AgentDirectoryRole::AgentUser,
    }
}

fn registered_project_containing(path: &str, projects: &[Project]) -> Option<ProjectId> {
    projects
        .iter()
        .find(|project| path_is_within(&project.device_path, path))
        .map(|project| project.id)
}

fn path_is_within(root: &str, candidate: &str) -> bool {
    let root_path = Path::new(root);
    let candidate_path = Path::new(candidate);
    match (
        std::fs::canonicalize(root_path),
        std::fs::canonicalize(candidate_path),
    ) {
        (Ok(root), Ok(candidate)) => candidate.starts_with(root),
        _ => candidate_path.starts_with(root_path),
    }
}

fn paths_resolve_to_same_directory(left: &str, right: &str) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn usage_environment_sort_key(environment: &UsageEnvironmentKey) -> String {
    format!(
        "{}:{}",
        environment.agent_client_id,
        environment
            .project_id
            .map(|id| id.to_string())
            .unwrap_or_default()
    )
}

fn select_relations_for_scope(
    database: &Database,
    scope: &RelationshipCheckScope,
) -> AppResult<Vec<SourceCopyRelationFact>> {
    let active = database
        .relationship_repository()
        .list_source_copy_relations(true)?;
    Ok(match scope {
        RelationshipCheckScope::AllActive => active,
        RelationshipCheckScope::RelationIds { relation_ids } => active
            .into_iter()
            .filter(|relation| relation_ids.contains(&relation.relation_id))
            .collect(),
        RelationshipCheckScope::Skill { skill_id } => active
            .into_iter()
            .filter(|relation| relation.skill_id == *skill_id)
            .collect(),
        RelationshipCheckScope::Agent { client_id } => active
            .into_iter()
            .filter(|relation| relation.agent_client_id.as_deref() == Some(client_id.as_str()))
            .collect(),
        RelationshipCheckScope::Project { project_id } => active
            .into_iter()
            .filter(|relation| relation.source_container_id.as_deref() == Some(project_id))
            .collect(),
        RelationshipCheckScope::Batch { batch_id } => {
            let relation_ids = database
                .provenance_repository()
                .list_batch_relation_ids(batch_id)?;
            active
                .into_iter()
                .filter(|relation| relation_ids.contains(&relation.relation_id))
                .collect()
        }
    })
}

#[allow(clippy::too_many_arguments)]
fn check_one_relation(
    facade: &LocalApplicationFacade,
    database: &Database,
    relation: SourceCopyRelationFact,
    request: &RunRelationshipCheck,
    central_root: &str,
    store: &skillhub_storage::VersionStore,
    now: i64,
) -> RelationshipCheckItem {
    let probe = facade
        .relationship_probe
        .lock()
        .expect("relationship probe")
        .probe(Path::new(&relation.source_path));
    match probe {
        // Light 只核可达：可达性声明本身不改写既有健康与指纹裁决（否则
        // 周期性补偿扫描会反复抹掉 Full 核验事实并造成事实抖动）；离线、
        // 权限受限与 Missing 仍照常落库。
        RelationshipPathProbe::Accessible { .. }
            if request.level == RelationshipCheckLevel::Light =>
        {
            RelationshipCheckItem {
                relation_id: relation.relation_id.clone(),
                skill_id: relation.skill_id,
                status: RelationshipCheckItemStatus::Unchanged,
                health: Some(relation.health),
                reason: None,
            }
        }
        probe => {
            let occupied = request.level == RelationshipCheckLevel::Full
                && path_lives_under(&relation.source_path, central_root);
            let fingerprint = if request.level == RelationshipCheckLevel::Full {
                store
                    .hash_tree_read_only(Path::new(&relation.source_path))
                    .ok()
            } else {
                None
            };
            let transition = evaluate_relationship_probe(
                &relation,
                request.level,
                &probe,
                occupied,
                fingerprint.as_deref(),
                now,
            );
            let updated = match transition {
                SourceCopyTransition::Update(updated) => updated,
                SourceCopyTransition::Archive { .. } => {
                    unreachable!("relationship validation cannot end a relationship")
                }
            };
            if !update_is_meaningful(&relation, &updated) {
                return RelationshipCheckItem {
                    relation_id: relation.relation_id.clone(),
                    skill_id: relation.skill_id,
                    status: RelationshipCheckItemStatus::Unchanged,
                    health: Some(relation.health),
                    reason: None,
                };
            }
            let outcome = (|| -> AppResult<()> {
                let transaction = database.begin_transaction()?;
                skillhub_storage::RelationshipRepository::upsert_source_copy_relation_tx(
                    &transaction,
                    &updated,
                    "fs",
                    1,
                )?;
                Database::commit_transaction(transaction)
            })();
            match outcome {
                Ok(()) => RelationshipCheckItem {
                    relation_id: relation.relation_id.clone(),
                    skill_id: relation.skill_id,
                    status: RelationshipCheckItemStatus::Checked,
                    health: Some(updated.health),
                    reason: None,
                },
                Err(error) => failed_item(&relation, &error),
            }
        }
    }
}

fn failed_item(relation: &SourceCopyRelationFact, error: &AppError) -> RelationshipCheckItem {
    RelationshipCheckItem {
        relation_id: relation.relation_id.clone(),
        skill_id: relation.skill_id,
        status: RelationshipCheckItemStatus::Failed,
        health: None,
        reason: Some(error.code.as_str().to_owned()),
    }
}

/// Separator/case-normalized containment: a relation whose source path fell
/// inside the central library is "managed-occupied" — the directory a user
/// once imported from is now part of the governed library itself.
fn path_lives_under(path: &str, root: &str) -> bool {
    let normalize = |value: &str| -> String {
        let unified = value.replace('\\', "/");
        let trimmed = unified.trim_end_matches('/').to_owned();
        trimmed
    };
    let normalized_path = normalize(path).to_ascii_lowercase();
    let normalized_root = normalize(root).to_ascii_lowercase();
    !normalized_root.is_empty()
        && normalized_path != normalized_root
        && normalized_path.starts_with(&normalized_root)
}

fn now_epoch_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

impl LocalApplicationFacade {
    /// 一次性 legacy 对账（plan 5.13）：对迁移产生的 legacy_unclassified
    /// 事件重新分类。只有能被正面根证据（集中库根、目录节点、Agent 目标、
    /// 项目根、git 上游）证明的来源才追加已分类的继承事件；证明不了的
    /// 原样保留，绝不把 UserLocal 兜底当作证明。幂等：同一
    /// (skill, fingerprint) 已有已分类事件时跳过。
    pub fn reconcile_legacy_import_events(&self) -> AppResult<LegacyReconciliationReport> {
        let library = self.library_runtime.snapshot()?;
        let central_root = library.root.to_string_lossy().into_owned();
        self.with_database("execute.reconcile_legacy_import_events", |database| {
            let repository = database.provenance_repository();
            let legacy = repository.list_unclassified_legacy_events()?;
            let mut reclassified = 0usize;
            let mut retained = 0usize;
            for event in legacy {
                let has_classified_successor = repository
                    .list_provenance_events_for_skill(event.skill_id)?
                    .into_iter()
                    .any(|existing| {
                        existing.provenance_id != event.provenance_id
                            && existing.source_class
                                != skillhub_core::ImportSourceClass::LegacyUnclassified
                            && existing.content_fingerprint == event.content_fingerprint
                    });
                if has_classified_successor {
                    continue;
                }
                let proven = event
                    .local_source_path
                    .as_ref()
                    .and_then(|path| {
                        Self::classify_import_source_core(
                            database,
                            &event.source,
                            path,
                            Some(&central_root),
                        )
                        .ok()
                    })
                    .flatten();
                // git 上游坐标本身就是正面证据（来源是仓库下载）。
                let proven = match proven {
                    Some(classified) => Some(classified),
                    None if event.source.kind == skillhub_core::SourceKind::Git => {
                        Some(ClassifiedImportSource {
                            source_class: skillhub_core::ImportSourceClass::Online,
                            physical_source_id: None,
                            source_container_id: None,
                            agent_client_id: None,
                        })
                    }
                    None => None,
                };
                match proven {
                    Some(classified) => {
                        repository.ensure_batch(RECONCILIATION_BATCH_ID, now_epoch_seconds())?;
                        repository.append_provenance_event(
                            &skillhub_core::import::ImportProvenanceEvent {
                                provenance_id: format!("prov-{}", OperationId::new()),
                                batch_id: RECONCILIATION_BATCH_ID.to_owned(),
                                skill_id: event.skill_id,
                                source_class: classified.source_class,
                                source: event.source.clone(),
                                local_source_path: event.local_source_path.clone(),
                                source_container_id: classified.source_container_id,
                                physical_source_id: classified.physical_source_id,
                                agent_client_id: classified.agent_client_id,
                                content_fingerprint: event.content_fingerprint.clone(),
                                imported_at: now_epoch_seconds(),
                            },
                        )?;
                        reclassified += 1;
                    }
                    None => retained += 1,
                }
            }
            Ok(LegacyReconciliationReport {
                reclassified,
                retained,
            })
        })
    }

    /// 导入成功后的受影响关系校验（plan 5.12）：对刚落库的关系跑一次
    /// Full 校验（指纹即导入哈希），失败只记项不回滚导入。
    pub(crate) fn validate_relationships_after_import(&self, skill_id: skillhub_core::SkillId) {
        let _ = self.run_relationship_check(RunRelationshipCheck {
            level: RelationshipCheckLevel::Full,
            scope: RelationshipCheckScope::Skill { skill_id },
        });
    }

    /// 路径变化后的受影响关系校验（plan 5.12）：只检查 source path 命中
    /// 该路径（或位于其下）的活动关系，绝不触发全量 hash。
    pub(crate) fn validate_relationships_after_path_change(&self, path: &str) {
        let Ok(report) = self.run_relationship_check_for_path(path, RelationshipCheckLevel::Light)
        else {
            return;
        };
        let _ = report;
    }

    /// 仅供测试：按路径选择关系并执行校验，返回报告供断言。
    #[doc(hidden)]
    pub fn run_relationship_check_for_path_for_tests(
        &self,
        path: &str,
        level: RelationshipCheckLevel,
    ) -> AppResult<RelationshipCheckReport> {
        self.run_relationship_check_for_path(path, level)
    }

    fn run_relationship_check_for_path(
        &self,
        path: &str,
        level: RelationshipCheckLevel,
    ) -> AppResult<RelationshipCheckReport> {
        let path_key = skillhub_core::deployment::observed_path_key(path);
        let scope =
            self.with_database("execute.relationship_check_for_path.select", |database| {
                let relation_ids = database
                    .relationship_repository()
                    .list_source_copy_relations(true)?
                    .into_iter()
                    .filter(|relation| {
                        relation.source_path_key == path_key
                            || path_lives_under(&relation.source_path, path)
                    })
                    .map(|relation| relation.relation_id)
                    .collect::<Vec<_>>();
                Ok(RelationshipCheckScope::RelationIds { relation_ids })
            })?;
        match self.run_relationship_check(RunRelationshipCheck { level, scope })? {
            AppCommandResult::RelationshipCheckReport(report) => Ok(report),
            _ => Err(AppError::new(
                skillhub_core::ErrorCode::InternalError,
                skillhub_core::Severity::Error,
            )
            .with_param("operation", "relationship_check_for_path")),
        }
    }
}

/// legacy 对账统一挂靠的批次；与迁移的 `legacy:` 约定区分开。
pub const RECONCILIATION_BATCH_ID: &str = "legacy-reconciliation";

/// legacy 对账结果摘要。
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyReconciliationReport {
    pub reclassified: usize,
    pub retained: usize,
}
