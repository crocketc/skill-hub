use std::collections::BTreeSet;
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

    pub async fn set_metadata(
        &self,
        id: SkillId,
        display_name: Option<String>,
        note: Option<String>,
        tags: Vec<String>,
        author: Option<String>,
        license: Option<String>,
    ) -> AppResult<Skill> {
        let mut skill = self.require(id).await?;
        skill.set_metadata(
            display_name,
            note,
            tags.into_iter().collect::<BTreeSet<_>>(),
            author,
            license,
        )?;
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
        if let Err(error) = self.catalog.insert(&skill).await {
            return match self.versions.discard(&version).await {
                Ok(()) => Err(error),
                Err(cleanup) => Err(recovery_error(error, cleanup)),
            };
        }
        if let Err(error) = self.versions.set_current(skill.id(), &version.id).await {
            let remove = self.catalog.remove(skill.id()).await;
            let discard = self.versions.discard(&version).await;
            if let Err(cleanup) = remove {
                return Err(recovery_error(error, cleanup));
            }
            if let Err(cleanup) = discard {
                return Err(recovery_error(error, cleanup));
            }
            return Err(error);
        }
        Ok(skill)
    }

    pub async fn save_skill(&self, id: SkillId, source: &Path) -> AppResult<VersionId>
    where
        V: super::VersionCapture,
    {
        validate_skill_directory(source)?;
        self.require(id).await?;
        let version = self.versions.capture(id, source).await?;
        if let Err(error) = self.versions.set_current(id, &version.id).await {
            return match self.versions.discard(&version).await {
                Ok(()) => Err(error),
                Err(cleanup) => Err(recovery_error(error, cleanup)),
            };
        }
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

fn recovery_error(original: AppError, cleanup: AppError) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Critical)
        .with_param("original_error", original.code.as_str())
        .with_param("cleanup_error", cleanup.code.as_str())
        .with_action(RecoveryAction::RollbackOperation)
        .with_action(RecoveryAction::CompleteOperation)
}
