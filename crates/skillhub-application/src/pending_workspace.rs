use super::*;
use skillhub_core::check::{CheckKind, CheckRunPhase};
use skillhub_core::pending::{DismissPendingWork, PendingWorkspace, WorkItem, WorkKind};
use skillhub_core::relationship::{GovernableRelationFact, GovernableRelationStatus};

fn work(kind: WorkKind, subject: String, occurrence: &str) -> WorkItem {
    let key = serde_json::to_value(kind)
        .expect("serializable kind")
        .as_str()
        .unwrap()
        .to_owned();
    let recommended = matches!(
        kind,
        WorkKind::ImportSkills | WorkKind::AiSetup | WorkKind::BackupSetup | WorkKind::SourceUpdate
    );
    WorkItem {
        id: format!("work:{key}:{subject}:{occurrence}"),
        kind,
        subject,
        display_name: None,
        message_code: format!("pending.reasons.{key}"),
        recommended,
        can_defer: recommended || kind == WorkKind::TrialDue,
        can_ignore: recommended || kind == WorkKind::TrialDue,
        can_confirm: false,
        version_id: None,
        finding_id: None,
        check_kind: None,
        path: None,
        due_date: None,
        risk: None,
        source_roots: Vec::new(),
    }
}

impl LocalApplicationFacade {
    pub(crate) async fn pending_workspace(&self) -> AppResult<PendingWorkspace> {
        let mut result = PendingWorkspace::default();
        let facts = self.with_database("pending.catalog", |database| {
            let catalog = database.catalog_repository()?;
            let mut items = Vec::new();
            let ids = catalog.list_ids_sync()?;
            let initialized = database
                .bootstrap_repository()
                .load_initialization()?
                .is_some_and(|value| {
                    value.state == skillhub_core::bootstrap::InitializationState::Initialized
                });
            if initialized
                && ids.is_empty()
                && !database.bootstrap_repository().has_successful_import()?
            {
                let mut item = work(WorkKind::ImportSkills, "library".into(), "first");
                if let Some(scan) = database.scan_repository().load()? {
                    item.source_roots = scan.roots;
                }
                items.push(item);
            }
            if initialized
                && !ids.is_empty()
                && !database.bootstrap_repository().has_verified_backup()?
            {
                items.push(work(WorkKind::BackupSetup, "library".into(), "first"));
            }
            for id in ids {
                let Some(detail) = catalog.get_detail(id)? else {
                    continue;
                };
                let name = Some(detail.display_name);
                let today = format!(
                    "{:04}-{:02}-{:02}",
                    self.today.0, self.today.1, self.today.2
                );
                if let Some(due) = detail.trial_due.filter(|date| date <= &today) {
                    let mut item = work(WorkKind::TrialDue, id.to_string(), &due);
                    item.display_name = name.clone();
                    item.due_date = Some(due);
                    items.push(item);
                }
                let Some(version) = detail.current_version else {
                    continue;
                };
                for kind in [CheckKind::Basic, CheckKind::Llm] {
                    let run = database
                        .check_repository()
                        .current_for_version_sync(id, &version, kind)?;
                    if kind == CheckKind::Basic
                        && !run
                            .as_ref()
                            .is_some_and(|run| run.phase == CheckRunPhase::Completed)
                    {
                        let mut item =
                            work(WorkKind::BasicCheck, id.to_string(), &version.to_string());
                        item.display_name = name.clone();
                        item.version_id = Some(version.to_string());
                        item.check_kind = Some("basic".into());
                        items.push(item);
                    }
                    if let Some(run) = run {
                        for finding in run
                            .findings
                            .iter()
                            .filter(|finding| finding.is_actionable())
                        {
                            let mut item = work(
                                WorkKind::SecurityFinding,
                                id.to_string(),
                                &format!("{}:{}:{}", version, run.id, finding.id),
                            );
                            item.display_name = name.clone();
                            item.version_id = Some(version.to_string());
                            item.finding_id = Some(finding.id.clone());
                            item.check_kind = Some(
                                if kind == CheckKind::Basic {
                                    "basic"
                                } else {
                                    "llm"
                                }
                                .into(),
                            );
                            item.risk = Some(if finding.is_high_risk() {
                                skillhub_core::pending::PendingRisk::High
                            } else {
                                skillhub_core::pending::PendingRisk::Medium
                            });
                            items.push(item);
                        }
                    }
                }
                if matches!(
                    detail.upstream_state,
                    Some(
                        skillhub_core::source::SourceState::UpdateAvailable
                            | skillhub_core::source::SourceState::UpdateAvailableWithLocalChanges
                    )
                ) {
                    let observation = database.source_repository().last_update_check(id)?;
                    if observation
                        .as_ref()
                        .is_some_and(|value| value.local_version.as_ref() != Some(&version))
                    {
                        continue;
                    }
                    let upstream = observation
                        .and_then(|value| value.upstream_version)
                        .map(|value| value.to_string());
                    let mut item = work(
                        WorkKind::SourceUpdate,
                        id.to_string(),
                        &format!("{version}:{}", upstream.as_deref().unwrap_or("unknown")),
                    );
                    item.display_name = name;
                    item.version_id = Some(version.to_string());
                    // Old observations without a revision cannot safely be ignored forever.
                    item.can_ignore = upstream.is_some();
                    item.can_defer = upstream.is_some();
                    items.push(item);
                }
            }
            Ok((items, initialized))
        });
        let initialized = match facts {
            Ok((items, initialized)) => {
                result.items.extend(items);
                initialized
            }
            Err(_) => {
                result.unavailable_sources.push("catalog".into());
                false
            }
        };
        if initialized {
            match self.list_llm_providers().await {
                Ok(AppQueryResult::LlmProviders(providers)) => {
                    if !providers.iter().any(|provider| {
                        provider.config.enabled
                            && !provider.config.model.trim().is_empty()
                            && (provider.config.deployment
                                == skillhub_core::llm::LlmDeployment::Local
                                || provider.credential_configured)
                    }) {
                        result
                            .items
                            .push(work(WorkKind::AiSetup, "settings".into(), "first"));
                    }
                }
                _ => result.unavailable_sources.push("ai".into()),
            }
        }
        match self.get_conflict_workspace() {
            Ok(AppQueryResult::ConflictWorkspace(workspace)) => {
                for entry in workspace.cases {
                    let mut item = work(
                        WorkKind::Conflict,
                        entry.case.conflict_id.to_string(),
                        "active",
                    );
                    item.display_name = self
                        .with_database("pending.conflict.names", |database| {
                            let catalog = database.catalog_repository()?;
                            let mut names = Vec::new();
                            for id in &entry.case.member_skill_ids {
                                if let Some(skill) = catalog.get_detail(*id)? {
                                    names.push(skill.display_name);
                                }
                            }
                            Ok(Some(names.join(" / ")))
                        })
                        .unwrap_or(None);
                    result.items.push(item);
                }
            }
            _ => result.unavailable_sources.push("conflicts".into()),
        }
        match self.list_relation_governance(Default::default()) {
            Ok(AppQueryResult::RelationGovernanceLedger(ledger)) => {
                for row in ledger.rows {
                    let active = match &row.relation {
                        GovernableRelationFact::SourceCopy(fact) => fact.active,
                        GovernableRelationFact::Deployment(fact) => fact.active,
                    };
                    if !active
                        || !matches!(
                            row.status,
                            GovernableRelationStatus::NeedsValidation
                                | GovernableRelationStatus::NeedsAttention
                                | GovernableRelationStatus::Blocked
                        )
                    {
                        continue;
                    }
                    let mut item = work(WorkKind::Governance, row.relation_id().into(), "active");
                    item.path = Some(row.path().into());
                    item.display_name = row.skill_display_name;
                    result.items.push(item);
                }
            }
            _ => result.unavailable_sources.push("governance".into()),
        }
        match self.recovery_service.list().await {
            Ok(candidates) => {
                for candidate in candidates {
                    result.items.push(work(
                        WorkKind::Recovery,
                        candidate.operation_id.to_string(),
                        "active",
                    ));
                }
            }
            Err(_) => result.unavailable_sources.push("recovery".into()),
        }
        match self.with_database("pending.governance.followups", |database| {
            database.governance_task_repository().list_pending()
        }) {
            Ok(tasks) => {
                for task in tasks {
                    // Other task kinds are represented by the live relation and
                    // recovery projections above, not a second stale reminder.
                    if !task.detail.starts_with("import.governance.task.") {
                        continue;
                    }
                    if result
                        .items
                        .iter()
                        .any(|item| item.subject == task.subject_id)
                    {
                        continue;
                    }
                    let mut item = work(
                        WorkKind::GovernanceFollowup,
                        task.task_id,
                        &task.created_at.to_string(),
                    );
                    if let Some((root, _)) = task.subject_id.rsplit_once(':') {
                        if Path::new(root).is_absolute() {
                            item.path = Some(root.to_owned());
                            item.display_name = Path::new(root)
                                .file_name()
                                .map(|name| name.to_string_lossy().into_owned());
                        }
                    }
                    // This acknowledges only an import advisory. Actual conflicts,
                    // safety findings and recovery remain governed by their own facts.
                    item.can_confirm = task.detail.starts_with("import.governance.task.")
                        && task.kind != skillhub_core::GovernanceTaskKind::OperationFailureRecovery;
                    result.items.push(item);
                }
            }
            Err(_) => result
                .unavailable_sources
                .push("governance_followups".into()),
        }
        // Derive verification work from live directory facts, not notifications.
        match self.get_agent_directory_projection() {
            Ok(AppQueryResult::AgentDirectoryProjection(projection)) => {
                let mut seen = std::collections::BTreeSet::new();
                let catalog = skillhub_core::ProfileCatalog::builtin();
                for directory in projection.directories {
                    if directory.role == skillhub_core::agent::AgentDirectoryRole::Builtin
                        || !directory.exists
                        || !directory.readable
                    {
                        continue;
                    }
                    for member in directory.members {
                        let Some(compatibility) = member.capabilities.compatibility else {
                            continue;
                        };
                        for mode in [
                            skillhub_core::DeploymentMode::ManagedCopy,
                            skillhub_core::DeploymentMode::SymbolicLink,
                            skillhub_core::DeploymentMode::DirectoryJunction,
                        ] {
                            if mode == skillhub_core::DeploymentMode::DirectoryJunction
                                && !cfg!(windows)
                            {
                                continue;
                            }
                            if compatibility.status(mode) != skillhub_core::agent::compatibility::CompatibilityStatus::Unverified { continue; }
                            let mode_key = serde_json::to_value(mode)
                                .unwrap()
                                .as_str()
                                .unwrap()
                                .to_owned();
                            if !seen.insert((member.logical_target_id.clone(), mode_key.clone())) {
                                continue;
                            }
                            let mut item = work(
                                WorkKind::AgentCompatibility,
                                member.logical_target_id.clone(),
                                &mode_key,
                            );
                            item.path = Some(directory.path.clone());
                            item.check_kind = Some(mode_key);
                            item.display_name = member
                                .client_id
                                .as_deref()
                                .and_then(|id| {
                                    catalog
                                        .profiles
                                        .iter()
                                        .flat_map(|p| &p.clients)
                                        .find(|c| c.id == id)
                                })
                                .map(|c| c.display_name.clone())
                                .or_else(|| member.brand.clone());
                            item.can_defer = true;
                            item.can_ignore = false;
                            result.items.push(item);
                        }
                    }
                }
            }
            _ => result
                .unavailable_sources
                .push("agent_compatibility".into()),
        }
        match self.ignore_service.list().await {
            Ok(rules) => {
                let today = format!(
                    "{:04}-{:02}-{:02}",
                    self.today.0, self.today.1, self.today.2
                );
                result.items.retain(|item| !((item.can_ignore || item.can_defer) && rules.iter().any(|rule| {
                    matches!(&rule.subject, skillhub_core::ignore::IgnoreSubject::ExactPending(id) if id == &item.id)
                        && rule.defer_until.as_ref().is_none_or(|until| until > &today)
                })));
            }
            Err(_) => result.unavailable_sources.push("preferences".into()),
        }
        result.items.sort_by_key(|item| {
            (
                item.recommended,
                match item.kind {
                    WorkKind::Recovery => 0,
                    WorkKind::Conflict => 1,
                    WorkKind::Governance => 2,
                    WorkKind::SecurityFinding => 3,
                    _ => 4,
                },
                item.id.clone(),
            )
        });
        Ok(result)
    }

    pub(crate) async fn dismiss_pending_work(
        &self,
        request: DismissPendingWork,
    ) -> AppResult<AppCommandResult> {
        let workspace = self.pending_workspace().await?;
        let item = workspace
            .items
            .iter()
            .find(|item| item.id == request.item_id)
            .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Warning))?;
        if (request.defer_until.is_some() && !item.can_defer)
            || (request.defer_until.is_none() && !item.can_ignore)
        {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("field", "pending_resolution"));
        }
        self.ignore_service
            .create(
                skillhub_core::ignore::IgnoreSubject::exact_pending(item.id.clone()),
                request.reason,
                request.defer_until,
            )
            .await
            .map(AppCommandResult::IgnoreRule)
    }

    pub(crate) async fn confirm_pending_work(
        &self,
        request: skillhub_core::pending::ConfirmPendingWork,
    ) -> AppResult<AppCommandResult> {
        let workspace = self.pending_workspace().await?;
        let item = workspace
            .items
            .iter()
            .find(|item| item.id == request.item_id && item.can_confirm)
            .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, Severity::Warning))?;
        if !workspace.unavailable_sources.is_empty() || request.reason.trim().is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning));
        }
        self.with_database("pending.confirm_handled", |database| {
            database.governance_task_repository().confirm_handled(
                &item.subject,
                &skillhub_core::pending::PendingConfirmation {
                    item_id: item.id.clone(),
                    reason: request.reason,
                    confirmed_at: now_epoch_seconds().to_string(),
                },
                now_epoch_seconds(),
            )
        })?;
        Ok(AppCommandResult::OperationSummary(operation_summary(
            "pending.user_confirmed",
        )))
    }
}
