use std::path::Path;
use std::sync::Arc;

use crate::catalog::{CatalogRepository, Skill, SkillLifecycle};
use crate::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId, VersionId};

use super::VersionService;

pub struct CatalogService<C, V> {
    catalog: Arc<C>,
    versions: VersionService<V>,
}

impl<C, V> CatalogService<C, V>
where
    C: CatalogRepository + 'static,
    V: crate::versioning::VersionRepository + Send + Sync + 'static,
{
    pub fn new(catalog: Arc<C>, versions: VersionService<V>) -> Self {
        Self { catalog, versions }
    }

    pub async fn get_skill(&self, id: SkillId) -> AppResult<Option<Skill>> {
        self.catalog.get(id).await
    }

    pub async fn current_version(&self, id: SkillId) -> AppResult<Option<VersionId>> {
        self.versions.current(id).await
    }

    pub async fn list_versions(&self, id: SkillId) -> AppResult<Vec<crate::VersionRecord>> {
        self.versions.list(id).await
    }

    pub async fn rename_skill(&self, id: SkillId, name: impl Into<String>) -> AppResult<Skill> {
        let mut skill = self.require(id).await?;
        skill.rename(name)?;
        self.catalog.insert(&skill).await?;
        Ok(skill)
    }

    pub async fn set_lifecycle(&self, id: SkillId, lifecycle: SkillLifecycle) -> AppResult<Skill> {
        let mut skill = self.require(id).await?;
        skill.set_lifecycle(lifecycle);
        self.catalog.insert(&skill).await?;
        Ok(skill)
    }

    pub async fn set_trial(&self, id: SkillId, due: Option<(i32, u8, u8)>) -> AppResult<Skill> {
        let mut skill = self.require(id).await?;
        skill.set_trial_due(due);
        self.catalog.insert(&skill).await?;
        Ok(skill)
    }

    pub async fn create_skill(&self, name: impl Into<String>, source: &Path) -> AppResult<Skill>
    where
        V: super::VersionCapture,
    {
        validate_skill_directory(source)?;
        let skill = Skill::new(SkillId::new(), name);
        skill.validate()?;
        let version = self.versions.capture(skill.id(), source).await?;
        self.catalog.insert(&skill).await?;
        self.versions.set_current(skill.id(), &version.id).await?;
        Ok(skill)
    }

    pub async fn save_skill(&self, id: SkillId, source: &Path) -> AppResult<VersionId>
    where
        V: super::VersionCapture,
    {
        validate_skill_directory(source)?;
        self.require(id).await?;
        let version = self.versions.capture(id, source).await?;
        self.versions.set_current(id, &version.id).await?;
        Ok(version.id)
    }

    async fn require(&self, id: SkillId) -> AppResult<Skill> {
        self.catalog.get(id).await?.ok_or_else(|| {
            AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("skill_id", id.to_string())
                .with_action(RecoveryAction::ChooseAnotherName)
        })
    }
}

fn validate_skill_directory(source: &Path) -> AppResult<()> {
    let path = source.join("SKILL.md");
    let metadata = std::fs::metadata(&path).map_err(|_| invalid_skill("SKILL.md"))?;
    if !metadata.is_file()
        || std::fs::read_to_string(path)
            .map_err(|_| invalid_skill("SKILL.md"))?
            .trim()
            .is_empty()
    {
        return Err(invalid_skill("SKILL.md"));
    }
    Ok(())
}

fn invalid_skill(field: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error)
        .with_param("field", field)
        .with_action(RecoveryAction::ChooseAnotherName)
}
