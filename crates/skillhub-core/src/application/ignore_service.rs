use async_trait::async_trait;
use std::sync::Arc;

use crate::ignore::{new_rule, IgnoreRule, IgnoreSubject};
use crate::{AppResult, SkillId};

#[async_trait]
pub trait IgnoreBackend: Send + Sync {
    async fn create(&self, rule: IgnoreRule) -> AppResult<IgnoreRule>;
    async fn remove(&self, id: String) -> AppResult<()>;
    async fn list(&self) -> AppResult<Vec<IgnoreRule>>;
}

pub struct IgnoreService<B> {
    backend: Arc<B>,
}

impl<B> IgnoreService<B>
where
    B: IgnoreBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self { backend }
    }

    pub async fn create(
        &self,
        subject: IgnoreSubject,
        reason: String,
        defer_until: Option<String>,
    ) -> AppResult<IgnoreRule> {
        self.backend
            .create(new_rule(subject, reason, defer_until))
            .await
    }

    pub async fn create_raw(
        &self,
        value: impl Into<String>,
        reason: String,
    ) -> AppResult<IgnoreRule> {
        let subject = IgnoreSubject::from_raw(value)?;
        self.create(subject, reason, None).await
    }

    pub async fn remove(&self, id: String) -> AppResult<()> {
        self.backend.remove(id).await
    }

    pub async fn list(&self) -> AppResult<Vec<IgnoreRule>> {
        self.backend.list().await
    }

    pub async fn is_ignored(&self, subject: &IgnoreSubject) -> AppResult<bool> {
        Ok(self
            .backend
            .list()
            .await?
            .iter()
            .any(|rule| &rule.subject == subject))
    }

    pub async fn is_skill_ignored(&self, skill_id: SkillId) -> AppResult<bool> {
        self.is_ignored(&IgnoreSubject::exact_skill(skill_id)).await
    }
}
