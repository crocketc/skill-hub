use async_trait::async_trait;
use std::path::Path;
use std::sync::Arc;

use crate::versioning::{VersionDiff, VersionManifest, VersionRecord, VersionRepository};
use crate::{AppResult, ProjectId, SkillId, VersionId};

#[async_trait]
pub trait VersionCapture: VersionRepository {
    async fn capture(&self, skill_id: SkillId, source: &Path) -> AppResult<VersionRecord>;
    async fn capture_with_status(
        &self,
        skill_id: SkillId,
        source: &Path,
    ) -> AppResult<CapturedVersion> {
        Ok(CapturedVersion {
            record: self.capture(skill_id, source).await?,
            created: true,
        })
    }
    async fn discard(&self, _record: &VersionRecord) -> AppResult<()> {
        Ok(())
    }
}

pub struct CapturedVersion {
    pub record: VersionRecord,
    pub created: bool,
}

#[async_trait]
pub trait ProjectVersionPinRepository: Send + Sync {
    async fn pin(
        &self,
        project_id: ProjectId,
        skill_id: SkillId,
        version_id: &VersionId,
    ) -> AppResult<()>;
}

pub struct VersionService<V> {
    repository: Arc<V>,
}

impl<V> Clone for VersionService<V> {
    fn clone(&self) -> Self {
        Self {
            repository: self.repository.clone(),
        }
    }
}

impl<V> VersionService<V>
where
    V: VersionRepository + Send + Sync + 'static,
{
    pub fn new(repository: Arc<V>) -> Self {
        Self { repository }
    }
    pub async fn current(&self, skill_id: SkillId) -> AppResult<Option<VersionId>> {
        self.repository.current(skill_id).await
    }
    pub async fn list(&self, skill_id: SkillId) -> AppResult<Vec<VersionRecord>> {
        self.repository.list(skill_id).await
    }
    pub async fn diff(&self, left: &VersionId, right: &VersionId) -> AppResult<VersionDiff> {
        self.repository.diff(left, right).await
    }
    pub async fn set_current(&self, skill_id: SkillId, version: &VersionId) -> AppResult<()> {
        self.repository.set_current(skill_id, version).await
    }
    pub async fn pin_project<P: ProjectVersionPinRepository>(
        &self,
        pins: &P,
        project_id: ProjectId,
        skill_id: SkillId,
        version: &VersionId,
    ) -> AppResult<()> {
        let belongs = self
            .repository
            .list(skill_id)
            .await?
            .into_iter()
            .any(|record| record.id == *version);
        if !belongs {
            return Err(crate::AppError::new(
                crate::ErrorCode::InvalidInput,
                crate::Severity::Error,
            )
            .with_param("field", "version_id"));
        }
        pins.pin(project_id, skill_id, version).await
    }
    pub async fn capture(&self, skill_id: SkillId, source: &Path) -> AppResult<VersionRecord>
    where
        V: VersionCapture,
    {
        self.repository.capture(skill_id, source).await
    }
    pub async fn capture_with_status(
        &self,
        skill_id: SkillId,
        source: &Path,
    ) -> AppResult<CapturedVersion>
    where
        V: VersionCapture,
    {
        self.repository.capture_with_status(skill_id, source).await
    }
    pub async fn discard(&self, record: &VersionRecord) -> AppResult<()>
    where
        V: VersionCapture,
    {
        self.repository.discard(record).await
    }
}

#[allow(dead_code)]
fn _manifest_type_is_public(_: VersionManifest) {}
