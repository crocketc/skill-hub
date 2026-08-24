use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::{
    AppError, AppResult, ErrorCode, OperationId, OperationPhase, OperationProgress, Severity,
};

/// A result produced for one object in a mutation. The journal deliberately
/// keeps this opaque: each operation family can choose its own object id and
/// result payload without changing the operation schema.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OperationObjectResult {
    pub object_id: String,
    pub status: String,
    pub result: Option<Value>,
    pub error_code: Option<ErrorCode>,
}

impl OperationObjectResult {
    pub fn succeeded(object_id: impl Into<String>, result: Option<Value>) -> Self {
        Self {
            object_id: object_id.into(),
            status: "succeeded".to_owned(),
            result,
            error_code: None,
        }
    }
}

/// Facts needed to perform an inverse operation. Facts are intentionally
/// stored as data rather than executable callbacks so a restart can inspect
/// and recover an operation safely.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct InverseOperation {
    pub kind: String,
    pub preconditions: Value,
    pub facts: Value,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Planned,
    Running,
    Completed,
    Failed,
    NeedsRecovery,
    RolledBack,
}

/// The durable operation row. Progress, per-object outcomes and recovery data
/// are all represented here before and after the filesystem mutation starts.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OperationRecord {
    pub operation_id: OperationId,
    pub kind: String,
    pub request_fingerprint: String,
    pub phase: OperationPhase,
    pub progress: OperationProgress,
    pub object_results: Vec<OperationObjectResult>,
    pub inverse: Option<InverseOperation>,
    pub recovery_data: Value,
    pub result: Option<Value>,
    pub error_code: Option<ErrorCode>,
}

impl OperationRecord {
    pub fn planned(
        operation_id: OperationId,
        kind: impl Into<String>,
        request_fingerprint: impl Into<String>,
    ) -> Self {
        let kind = kind.into();
        Self {
            operation_id,
            kind: kind.clone(),
            request_fingerprint: request_fingerprint.into(),
            phase: OperationPhase::Planned,
            progress: OperationProgress {
                operation_id,
                phase: OperationPhase::Planned,
                completed: 0,
                total: 0,
                message_code: format!("operation.{kind}.planned"),
            },
            object_results: Vec::new(),
            inverse: None,
            recovery_data: Value::Object(Default::default()),
            result: None,
            error_code: None,
        }
    }

    pub fn status(&self) -> OperationStatus {
        match self.phase {
            OperationPhase::Planned | OperationPhase::Prepared => OperationStatus::Planned,
            OperationPhase::Applying | OperationPhase::Verifying => OperationStatus::Running,
            OperationPhase::Committed => OperationStatus::Completed,
            OperationPhase::NeedsRecovery => OperationStatus::NeedsRecovery,
            OperationPhase::RolledBack => OperationStatus::RolledBack,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.phase,
            OperationPhase::Committed | OperationPhase::NeedsRecovery | OperationPhase::RolledBack
        )
    }
}

/// Storage boundary for the operation journal. Implementations must update a
/// single record atomically; the in-process writer lock is supplied by
/// `OperationJournal` and this trait is also suitable for a durable backend.
#[async_trait(?Send)]
pub trait OperationRepository {
    async fn get(&self, operation_id: OperationId) -> AppResult<Option<OperationRecord>>;
    async fn insert(&self, record: &OperationRecord) -> AppResult<()>;
    async fn update(&self, record: &OperationRecord) -> AppResult<()>;
    async fn list(&self) -> AppResult<Vec<OperationRecord>>;
}

/// Coordinates all mutations sharing one library. The permit is held from
/// the first persisted `Applying` phase through a terminal phase, including
/// the user operation future, so two mutations cannot overlap.
pub struct OperationJournal<R> {
    repository: Arc<R>,
    writer: Arc<Mutex<()>>,
}

impl<R> Clone for OperationJournal<R> {
    fn clone(&self) -> Self {
        Self {
            repository: self.repository.clone(),
            writer: self.writer.clone(),
        }
    }
}

impl<R> OperationJournal<R> {
    pub fn new(repository: Arc<R>) -> Self {
        Self {
            repository,
            writer: Arc::new(Mutex::new(())),
        }
    }

    pub fn repository(&self) -> &Arc<R> {
        &self.repository
    }

    pub(crate) fn acquire_writer(&self) -> AppResult<MutexGuard<'_, ()>> {
        self.writer.lock().map_err(|_| {
            AppError::new(ErrorCode::InternalError, Severity::Critical)
                .with_param("reason", "operation_writer_poisoned")
        })
    }
}

impl<R> OperationJournal<R>
where
    R: OperationRepository,
{
    pub async fn get(&self, operation_id: OperationId) -> AppResult<Option<OperationRecord>> {
        self.repository.get(operation_id).await
    }

    pub async fn list(&self) -> AppResult<Vec<OperationRecord>> {
        self.repository.list().await
    }
}

/// Mutable operation state passed to a mutation closure.
#[derive(Clone)]
pub struct OperationContext {
    record: Arc<Mutex<OperationRecord>>,
}

impl OperationContext {
    pub(crate) fn new(record: OperationRecord) -> Self {
        Self {
            record: Arc::new(Mutex::new(record)),
        }
    }

    pub fn operation_id(&self) -> OperationId {
        self.record
            .lock()
            .expect("operation context lock")
            .operation_id
    }

    pub fn kind(&self) -> String {
        self.record
            .lock()
            .expect("operation context lock")
            .kind
            .clone()
    }

    pub fn set_progress(&self, completed: u32, total: u32, message_code: impl Into<String>) {
        let mut record = self.record.lock().expect("operation context lock");
        record.progress = OperationProgress {
            operation_id: record.operation_id,
            phase: record.phase,
            completed,
            total,
            message_code: message_code.into(),
        };
    }

    pub fn record_object_result(&self, result: OperationObjectResult) {
        self.record
            .lock()
            .expect("operation context lock")
            .object_results
            .push(result);
    }

    pub fn set_inverse(&self, kind: impl Into<String>, preconditions: Value, facts: Value) {
        self.record.lock().expect("operation context lock").inverse = Some(InverseOperation {
            kind: kind.into(),
            preconditions,
            facts,
        });
    }

    pub fn set_recovery_data(&self, data: Value) {
        self.record
            .lock()
            .expect("operation context lock")
            .recovery_data = data;
    }

    pub fn record(&self) -> OperationRecord {
        self.record.lock().expect("operation context lock").clone()
    }

    pub(crate) fn into_record(self) -> OperationRecord {
        self.record.lock().expect("operation context lock").clone()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct UndoPlan {
    pub id: OperationId,
    pub operation_id: OperationId,
    pub inverse_kind: String,
    pub preconditions: Value,
    pub facts: Value,
}

pub(crate) fn decode_result<T: DeserializeOwned>(record: &OperationRecord) -> AppResult<T> {
    record
        .result
        .clone()
        .ok_or_else(|| AppError::new(ErrorCode::OperationConflict, Severity::Error))
        .and_then(|result| {
            serde_json::from_value(result).map_err(|_| {
                AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "operation_result_corrupt")
            })
        })
}

pub(crate) fn conflict(reason: &'static str) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error).with_param("reason", reason)
}

pub(crate) fn mismatch_error() -> AppError {
    AppError::new(
        ErrorCode::OperationIdReusedWithDifferentRequest,
        Severity::Error,
    )
}
