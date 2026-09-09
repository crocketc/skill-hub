use async_trait::async_trait;

use super::model::{CredentialRef, LlmProfile, LlmTaskRequest, LlmTaskResponse};
use crate::AppResult;

#[async_trait(?Send)]
pub trait CredentialStore: Send + Sync {
    async fn get(&self, reference: &CredentialRef) -> AppResult<Option<String>>;

    /// Stores or replaces the secret for a reference. Replacing must
    /// overwrite the previous value, never stack a second one.
    async fn set(&self, reference: &CredentialRef, secret: &str) -> AppResult<()>;

    /// Removes the secret. Deleting an absent reference stays idempotent.
    async fn delete(&self, reference: &CredentialRef) -> AppResult<()>;
}

#[async_trait(?Send)]
pub trait LlmTaskRunner: Send + Sync {
    async fn run(
        &self,
        profile: &LlmProfile,
        request: LlmTaskRequest,
    ) -> AppResult<LlmTaskResponse>;
}
