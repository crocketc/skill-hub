use super::skill::Skill;
use crate::{AppResult, SkillId};
use async_trait::async_trait;

#[async_trait(?Send)]
pub trait CatalogRepository {
    async fn insert(&self, skill: &Skill) -> AppResult<()>;
    async fn get(&self, id: SkillId) -> AppResult<Option<Skill>>;
}
