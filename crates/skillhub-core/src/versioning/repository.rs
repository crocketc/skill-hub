use async_trait::async_trait;

use crate::{AppResult, SkillId, VersionId};

use super::{VersionDiff, VersionRecord};

#[async_trait]
pub trait VersionRepository: Send + Sync {
    async fn current(&self, skill_id: SkillId) -> AppResult<Option<VersionId>>;
    async fn set_current(&self, skill_id: SkillId, version_id: &VersionId) -> AppResult<()>;
    async fn clear_current(&self, _skill_id: SkillId) -> AppResult<()> {
        Ok(())
    }
    async fn diff(&self, left: &VersionId, right: &VersionId) -> AppResult<VersionDiff>;
    async fn list(&self, skill_id: SkillId) -> AppResult<Vec<VersionRecord>>;
}
