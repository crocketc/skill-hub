use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use crate::catalog::{CatalogRepository, Skill, SkillLifecycle};
use crate::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId, VersionId};

use super::VersionService;

#[async_trait::async_trait]
pub trait PortableMetadataRepository: Send + Sync {
    async fn save_skill(&self, skill: &Skill, current: Option<&VersionId>) -> AppResult<()>;
    async fn load_skill(&self, _id: SkillId) -> AppResult<Option<(Skill, Option<VersionId>)>> {
        Ok(None)
    }
    async fn restore_skill(&self, skill: &Skill, current: Option<&VersionId>) -> AppResult<()> {
        self.save_skill(skill, current).await
    }
    async fn remove_skill(&self, _id: SkillId) -> AppResult<()> {
        Ok(())
    }
}

pub struct CatalogService<C, V> {
    catalog: Arc<C>,
    versions: VersionService<V>,
    portable: Option<Arc<dyn PortableMetadataRepository>>,
}

impl<C, V> CatalogService<C, V>
where
    C: CatalogRepository + 'static,
    V: crate::versioning::VersionRepository + Send + Sync + 'static,
{
    pub fn new(catalog: Arc<C>, versions: VersionService<V>) -> Self {
        Self {
            catalog,
            versions,
            portable: None,
        }
    }

    pub fn with_portable_repository(
        mut self,
        portable: Arc<dyn PortableMetadataRepository>,
    ) -> Self {
        self.portable = Some(portable);
        self
    }

    pub async fn create_skill_operation(
        &self,
        name: impl Into<String>,
        source: &Path,
    ) -> AppResult<(crate::OperationSummary, Skill)>
    where
        V: super::VersionCapture,
    {
        let result = self.create_skill(name, source).await?;
        Ok((committed_summary("catalog.skill_created"), result))
    }

    pub async fn save_skill_operation(
        &self,
        id: SkillId,
        source: &Path,
    ) -> AppResult<(crate::OperationSummary, VersionId)>
    where
        V: super::VersionCapture,
    {
        let result = self.save_skill(id, source).await?;
        Ok((committed_summary("catalog.version_saved"), result))
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
        self.persist_portable(&skill, self.versions.current(id).await?.as_ref())
            .await?;
        Ok(skill)
    }

    pub async fn set_lifecycle(&self, id: SkillId, lifecycle: SkillLifecycle) -> AppResult<Skill> {
        let mut skill = self.require(id).await?;
        skill.set_lifecycle(lifecycle);
        self.catalog.insert(&skill).await?;
        self.persist_portable(&skill, self.versions.current(id).await?.as_ref())
            .await?;
        Ok(skill)
    }

    pub async fn set_trial(&self, id: SkillId, due: Option<(i32, u8, u8)>) -> AppResult<Skill> {
        let mut skill = self.require(id).await?;
        skill.set_trial_due(due);
        self.catalog.insert(&skill).await?;
        self.persist_portable(&skill, self.versions.current(id).await?.as_ref())
            .await?;
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
        self.persist_portable(&skill, self.versions.current(id).await?.as_ref())
            .await?;
        Ok(skill)
    }

    pub async fn create_skill(&self, name: impl Into<String>, source: &Path) -> AppResult<Skill>
    where
        V: super::VersionCapture,
    {
        validate_skill_directory(source)?;
        let skill = Skill::new(SkillId::new(), name);
        skill.validate()?;
        let captured = self
            .versions
            .capture_with_status(skill.id(), source)
            .await?;
        let version = &captured.record;
        if let Err(error) = self.catalog.insert(&skill).await {
            return match if captured.created {
                self.versions.discard(version).await
            } else {
                Ok(())
            } {
                Ok(()) => Err(error),
                Err(cleanup) => Err(recovery_error(error, cleanup)),
            };
        }
        if let Err(error) = self.versions.set_current(skill.id(), &version.id).await {
            let remove = self.catalog.remove(skill.id()).await;
            let discard = if captured.created {
                self.versions.discard(version).await
            } else {
                Ok(())
            };
            if let Err(cleanup) = remove {
                return Err(recovery_error(error, cleanup));
            }
            if let Err(cleanup) = discard {
                return Err(recovery_error(error, cleanup));
            }
            return Err(error);
        }
        if let Err(error) = self.persist_portable(&skill, Some(&version.id)).await {
            let remove = self.catalog.remove(skill.id()).await;
            let portable_remove = if let Some(portable) = &self.portable {
                portable.remove_skill(skill.id()).await
            } else {
                Ok(())
            };
            let discard = if captured.created {
                self.versions.discard(version).await
            } else {
                Ok(())
            };
            if let Err(cleanup) = remove {
                return Err(recovery_error(error, cleanup));
            }
            if let Err(cleanup) = portable_remove {
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
        let old_skill = self.require(id).await?;
        let old_current = self.versions.current(id).await?;
        let old_portable = if let Some(portable) = &self.portable {
            portable.load_skill(id).await?
        } else {
            None
        };
        let captured = self.versions.capture_with_status(id, source).await?;
        let version = &captured.record;
        if let Err(error) = self.versions.set_current(id, &version.id).await {
            return match if captured.created {
                self.versions.discard(version).await
            } else {
                Ok(())
            } {
                Ok(()) => Err(error),
                Err(cleanup) => Err(recovery_error(error, cleanup)),
            };
        }
        let skill = self.require(id).await?;
        if let Err(error) = self.persist_portable(&skill, Some(&version.id)).await {
            let restore_catalog = self.catalog.insert(&old_skill).await;
            let restore_current = match old_current.as_ref() {
                Some(previous) => self.versions.set_current(id, previous).await,
                None => Ok(()),
            };
            let restore_portable = if let Some(portable) = &self.portable {
                match old_portable.as_ref() {
                    Some((previous, current)) => {
                        portable.restore_skill(previous, current.as_ref()).await
                    }
                    None => portable.remove_skill(id).await,
                }
            } else {
                Ok(())
            };
            let discard = if captured.created {
                self.versions.discard(version).await
            } else {
                Ok(())
            };
            if let Err(cleanup) = restore_catalog {
                return Err(recovery_error(error, cleanup));
            }
            if let Err(cleanup) = restore_current {
                return Err(recovery_error(error, cleanup));
            }
            if let Err(cleanup) = restore_portable {
                return Err(recovery_error(error, cleanup));
            }
            if let Err(cleanup) = discard {
                return Err(recovery_error(error, cleanup));
            }
            return Err(error);
        }
        Ok(version.id.clone())
    }

    async fn require(&self, id: SkillId) -> AppResult<Skill> {
        self.catalog.get(id).await?.ok_or_else(|| {
            AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("skill_id", id.to_string())
                .with_action(RecoveryAction::ChooseAnotherName)
        })
    }

    async fn persist_portable(&self, skill: &Skill, current: Option<&VersionId>) -> AppResult<()> {
        if let Some(portable) = &self.portable {
            portable.save_skill(skill, current).await?;
        }
        Ok(())
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

fn committed_summary(message_code: &str) -> crate::OperationSummary {
    crate::OperationSummary {
        operation_id: crate::OperationId::new(),
        phase: crate::OperationPhase::Committed,
        message_code: message_code.to_owned(),
        error_code: None,
    }
}
