use super::*;
use skillhub_core::agent::compatibility::{
    CompatibilityStatus, ImportCompatibility, RecordAgentCompatibility,
};

#[derive(Clone, serde::Deserialize, serde::Serialize)]
struct LocalEvidence {
    basis: String,
    decisions: BTreeMap<String, RecordAgentCompatibility>,
    updated_at: i64,
}

fn key(target_id: &str) -> String {
    format!(
        "agent.compatibility.v1:{}:{target_id}",
        std::env::consts::OS
    )
}

pub(crate) fn compatibility_for(
    database: &skillhub_storage::Database,
    target_id: &str,
    declared: Option<&skillhub_core::DeploymentCapability>,
    identity: &str,
) -> ImportCompatibility {
    let mut compatibility = ImportCompatibility::from_declaration(declared);
    let basis = serde_json::to_string(&(declared, identity)).unwrap_or_default();
    match database.ui_preference_repository().get(&key(target_id)) {
        Ok(Some(value)) => {
            let Ok(record) = serde_json::from_str::<LocalEvidence>(&value) else {
                return ImportCompatibility::default();
            };
            if record.basis == basis {
                for decision in record.decisions.values() {
                    compatibility.set(decision.mode, decision.status);
                }
            }
        }
        Err(_) => return ImportCompatibility::default(),
        Ok(None) => {}
    }
    compatibility
}

pub(crate) fn target_compatibility(
    database: &skillhub_storage::Database,
    target: &skillhub_core::LogicalTarget,
) -> ImportCompatibility {
    let catalog = skillhub_core::ProfileCatalog::builtin();
    compatibility_for(
        database,
        &target.id,
        catalog.deployment_capability_for_client(&target.client_id),
        &format!("{}:{}", target.physical_id, target.path),
    )
}

pub(crate) fn custom_identity(agent: &skillhub_core::CustomAgent, physical_id: &str) -> String {
    format!(
        "{physical_id}:{}:{}",
        agent.directory.path,
        serde_json::to_string(&agent.profile).unwrap_or_default()
    )
}

impl LocalApplicationFacade {
    pub(crate) fn record_agent_compatibility(
        &self,
        request: RecordAgentCompatibility,
    ) -> AppResult<AppCommandResult> {
        if request.agent_version.trim().is_empty()
            || request.evidence.trim().is_empty()
            || (request.status != CompatibilityStatus::Unverified && !request.agent_reading_checked)
            || request.agent_version.len() > 200
            || request.evidence.len() > 4000
        {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning));
        }
        self.with_database("agent.compatibility.record", |database| {
            let catalog = skillhub_core::ProfileCatalog::builtin();
            let snapshot = database
                .agent_repository()
                .load()?
                .unwrap_or_else(empty_discovery);
            let custom = database.custom_agent_repository().list()?;
            let (declared, identity) = if let Some(target) = snapshot
                .logical_targets
                .iter()
                .find(|t| t.id == request.target_id)
            {
                if target.builtin
                    || !target.exists
                    || !target.readable
                    || !target.physical_identity_verified
                {
                    return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning));
                }
                let observed =
                    skillhub_adapters::agent::discovery::observe_directory(Path::new(&target.path));
                if observed.physical_id.as_deref() != Some(target.physical_id.as_str()) {
                    return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning));
                }
                (
                    catalog.deployment_capability_for_client(&target.client_id),
                    format!("{}:{}", target.physical_id, target.path),
                )
            } else if let Some(agent) = custom.iter().find(|a| a.id == request.target_id) {
                let observed = skillhub_adapters::agent::discovery::observe_directory(Path::new(
                    &agent.directory.path,
                ));
                if !observed.readable
                    || agent.directory_physical_id.as_deref() != observed.physical_id.as_deref()
                {
                    return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning));
                }
                (
                    None,
                    custom_identity(agent, observed.physical_id.as_deref().unwrap_or_default()),
                )
            } else {
                return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Warning));
            };
            let basis = serde_json::to_string(&(declared, identity))
                .map_err(|_| AppError::new(ErrorCode::InvalidInput, Severity::Warning))?;
            let storage = database.ui_preference_repository();
            let mut record = storage
                .get(&key(&request.target_id))?
                .and_then(|value| serde_json::from_str::<LocalEvidence>(&value).ok())
                .filter(|record| {
                    record.basis == basis
                        && record
                            .decisions
                            .values()
                            .all(|decision| decision.agent_version == request.agent_version)
                })
                .unwrap_or(LocalEvidence {
                    basis,
                    decisions: BTreeMap::new(),
                    updated_at: 0,
                });
            let mode = serde_json::to_string(&request.mode).unwrap_or_default();
            record.decisions.insert(mode, request.clone());
            record.updated_at = now_epoch_seconds();
            storage.set(
                &key(&request.target_id),
                &serde_json::to_string(&record).unwrap(),
            )?;
            Ok(AppCommandResult::OperationSummary(operation_summary(
                "agent.compatibility.recorded",
            )))
        })
    }
}
