use async_trait::async_trait;

use super::model::{CredentialRef, LlmProfile, LlmTaskRequest, LlmTaskResponse};
use crate::AppResult;

#[async_trait(?Send)]
pub trait CredentialStore: Send + Sync {
    async fn get(&self, reference: &CredentialRef) -> AppResult<Option<String>>;
}

#[async_trait(?Send)]
pub trait LlmTaskRunner: Send + Sync {
    async fn run(
        &self,
        profile: &LlmProfile,
        request: LlmTaskRequest,
    ) -> AppResult<LlmTaskResponse>;
}
