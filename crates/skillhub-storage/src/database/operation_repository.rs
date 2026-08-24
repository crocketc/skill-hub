use super::Database;
use async_trait::async_trait;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use skillhub_core::{
    AppError, AppResult, ErrorCode, InverseOperation, OperationId, OperationObjectResult,
    OperationPhase, OperationProgress, OperationRecord, OperationRepository, RecoveryAction,
    Severity,
};

/// SQLite implementation of the operation journal repository.
pub struct OperationRepositorySqlite<'a> {
    pub(crate) database: &'a Database,
}

impl<'a> OperationRepositorySqlite<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }
}

#[derive(Serialize)]
struct ProgressEnvelope<'a> {
    progress: &'a OperationProgress,
    object_results: &'a [OperationObjectResult],
    recovery_data: &'a Value,
    result: &'a Option<Value>,
}

#[derive(Deserialize, Default)]
struct StoredProgress {
    progress: Option<OperationProgress>,
    #[serde(default)]
    object_results: Vec<OperationObjectResult>,
    #[serde(default)]
    recovery_data: Value,
    result: Option<Value>,
}

#[async_trait(?Send)]
impl OperationRepository for OperationRepositorySqlite<'_> {
    async fn get(&self, operation_id: OperationId) -> AppResult<Option<OperationRecord>> {
        let row = self
            .database
            .connection
            .query_row(
                "SELECT kind, phase, request_fingerprint, progress_json, inverse_json, error_code FROM operations WHERE operation_id=?1",
                [operation_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(error)?;
        row.map(
            |(kind, phase, fingerprint, progress_json, inverse_json, error_code)| {
                decode_record(
                    operation_id,
                    &kind,
                    &phase,
                    &fingerprint,
                    &progress_json,
                    &inverse_json,
                    error_code.as_deref(),
                )
            },
        )
        .transpose()
    }

    async fn insert(&self, record: &OperationRecord) -> AppResult<()> {
        let (progress, inverse) = encode_record(record)?;
        self.database
            .connection
            .execute(
                "INSERT INTO operations(operation_id,kind,state,phase,request_fingerprint,progress_json,inverse_json,error_code,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
                params![
                    record.operation_id.to_string(),
                    record.kind,
                    state_code(record.phase),
                    phase_code(record.phase),
                    record.request_fingerprint,
                    progress,
                    inverse,
                    record.error_code.map(|value| value.as_str()),
                    now(),
                ],
            )
            .map_err(error)?;
        Ok(())
    }

    async fn update(&self, record: &OperationRecord) -> AppResult<()> {
        let (progress, inverse) = encode_record(record)?;
        let changed = self
            .database
            .connection
            .execute(
                "UPDATE operations SET state=?2,phase=?3,request_fingerprint=?4,progress_json=?5,inverse_json=?6,error_code=?7,updated_at=?8 WHERE operation_id=?1",
                params![
                    record.operation_id.to_string(),
                    state_code(record.phase),
                    phase_code(record.phase),
                    record.request_fingerprint,
                    progress,
                    inverse,
                    record.error_code.map(|value| value.as_str()),
                    now(),
                ],
            )
            .map_err(error)?;
        if changed == 0 {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("operation_id", record.operation_id.to_string()));
        }
        Ok(())
    }

    async fn list(&self) -> AppResult<Vec<OperationRecord>> {
        let mut statement = self
            .database
            .connection
            .prepare("SELECT operation_id,kind,phase,request_fingerprint,progress_json,inverse_json,error_code FROM operations ORDER BY created_at,operation_id")
            .map_err(error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(error)?;
        rows.map(|row| {
            let (id, kind, phase, fingerprint, progress, inverse, error_code) =
                row.map_err(error)?;
            let operation_id = id.parse().map_err(|_| invalid_record())?;
            decode_record(
                operation_id,
                &kind,
                &phase,
                &fingerprint,
                &progress,
                &inverse,
                error_code.as_deref(),
            )
        })
        .collect()
    }
}

fn encode_record(record: &OperationRecord) -> AppResult<(String, String)> {
    let progress = serde_json::to_string(&ProgressEnvelope {
        progress: &record.progress,
        object_results: &record.object_results,
        recovery_data: &record.recovery_data,
        result: &record.result,
    })
    .map_err(|_| invalid_record())?;
    let inverse = serde_json::to_string(&record.inverse).map_err(|_| invalid_record())?;
    Ok((progress, inverse))
}

fn decode_record(
    operation_id: OperationId,
    kind: &str,
    phase: &str,
    fingerprint: &str,
    progress_json: &str,
    inverse_json: &str,
    error_code: Option<&str>,
) -> AppResult<OperationRecord> {
    let stored: StoredProgress =
        serde_json::from_str(progress_json).map_err(|_| invalid_record())?;
    let phase = parse_phase(phase)?;
    let progress = stored.progress.unwrap_or(OperationProgress {
        operation_id,
        phase,
        completed: 0,
        total: 0,
        message_code: "operation.unknown".to_owned(),
    });
    let inverse = if inverse_json.trim() == "{}" || inverse_json.trim() == "null" {
        None
    } else {
        serde_json::from_str::<Option<InverseOperation>>(inverse_json)
            .map_err(|_| invalid_record())?
    };
    Ok(OperationRecord {
        operation_id,
        kind: kind.to_owned(),
        request_fingerprint: fingerprint.to_owned(),
        phase,
        progress,
        object_results: stored.object_results,
        inverse,
        recovery_data: stored.recovery_data,
        result: stored.result,
        error_code: error_code.map(parse_error_code).transpose()?,
    })
}

fn parse_phase(value: &str) -> AppResult<OperationPhase> {
    match value {
        "planned" => Ok(OperationPhase::Planned),
        "prepared" => Ok(OperationPhase::Prepared),
        "applying" => Ok(OperationPhase::Applying),
        "verifying" => Ok(OperationPhase::Verifying),
        "committed" => Ok(OperationPhase::Committed),
        "needs_recovery" => Ok(OperationPhase::NeedsRecovery),
        "rolled_back" => Ok(OperationPhase::RolledBack),
        _ => Err(invalid_record()),
    }
}

fn phase_code(value: OperationPhase) -> &'static str {
    match value {
        OperationPhase::Planned => "planned",
        OperationPhase::Prepared => "prepared",
        OperationPhase::Applying => "applying",
        OperationPhase::Verifying => "verifying",
        OperationPhase::Committed => "committed",
        OperationPhase::NeedsRecovery => "needs_recovery",
        OperationPhase::RolledBack => "rolled_back",
    }
}

fn state_code(value: OperationPhase) -> &'static str {
    match value {
        OperationPhase::Planned
        | OperationPhase::Prepared
        | OperationPhase::Applying
        | OperationPhase::Verifying => "running",
        OperationPhase::Committed => "completed",
        OperationPhase::NeedsRecovery => "needs_recovery",
        OperationPhase::RolledBack => "rolled_back",
    }
}

fn parse_error_code(value: &str) -> AppResult<ErrorCode> {
    let all = [
        ErrorCode::InvalidInput,
        ErrorCode::PathOutsideAllowedRoots,
        ErrorCode::ObjectNotFound,
        ErrorCode::TargetExists,
        ErrorCode::OwnershipUnknown,
        ErrorCode::CheckBlocked,
        ErrorCode::OperationConflict,
        ErrorCode::OperationIdReusedWithDifferentRequest,
        ErrorCode::CredentialUnavailable,
        ErrorCode::MigrationRequired,
        ErrorCode::DatabaseNewerSchema,
        ErrorCode::InternalError,
        ErrorCode::CombinationNestingNotAllowed,
        ErrorCode::CatalogInvalidMetadata,
        ErrorCode::RequirementsInvalidDeclaration,
        ErrorCode::AgentProfileInvalidCapability,
    ];
    all.into_iter()
        .find(|candidate| candidate.as_str() == value)
        .ok_or_else(invalid_record)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", "operation_record_corrupt")
        .with_action(RecoveryAction::Retry)
}

fn error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use skillhub_core::OperationRepository;

    #[test]
    fn round_trip_preserves_progress_object_results_inverse_and_result() {
        let database = Database::open_in_memory().unwrap();
        let repository = OperationRepositorySqlite::new(&database);
        let id = OperationId::new();
        let mut record = OperationRecord::planned(id, "rename_skill", "fingerprint");
        record.phase = OperationPhase::Committed;
        record.progress.phase = OperationPhase::Committed;
        record.progress.completed = 1;
        record.progress.total = 1;
        record.object_results.push(OperationObjectResult::succeeded(
            "skill-a",
            Some(serde_json::json!({"name":"after"})),
        ));
        record.inverse = Some(InverseOperation {
            kind: "rename_skill".to_owned(),
            preconditions: serde_json::json!({"name":"after"}),
            facts: serde_json::json!({"name":"before"}),
        });
        record.recovery_data = serde_json::json!({"staging":"staging-a"});
        record.result = Some(serde_json::json!({"name":"after"}));

        block_on(repository.insert(&record)).unwrap();
        let loaded = block_on(repository.get(id)).unwrap().unwrap();
        assert_eq!(loaded, record);
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        fn clone(_: *const ()) -> RawWaker {
            raw_waker()
        }
        fn wake(_: *const ()) {}
        fn raw_waker() -> RawWaker {
            RawWaker::new(
                std::ptr::null(),
                &RawWakerVTable::new(clone, wake, wake, wake),
            )
        }
        let waker = unsafe { Waker::from_raw(raw_waker()) };
        let mut context = Context::from_waker(&waker);
        let mut future = std::pin::pin!(future);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }
}
