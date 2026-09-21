mod layout;
mod portable;

pub use layout::CentralLibrary;
pub use portable::{ManifestFaultHandler, PortableManifestStore};

use async_trait::async_trait;
use skillhub_core::application::PortableMetadataRepository;
use skillhub_core::catalog::{Skill, SkillLifecycle};
use skillhub_core::{AppResult, SkillId, VersionId};
use std::collections::BTreeSet;

#[async_trait]
impl PortableMetadataRepository for CentralLibrary {
    async fn save_skill(&self, skill: &Skill, current: Option<&VersionId>) -> AppResult<()> {
        self.save_portable_skill(skill, current)
    }
    async fn load_skill(&self, id: SkillId) -> AppResult<Option<(Skill, Option<VersionId>)>> {
        let Some((record, current)) = self.load_portable_skill(id)? else {
            return Ok(None);
        };
        let invocation_source = match record.invocation_source.as_deref() {
            Some("explicit") => skillhub_core::catalog::InvocationPolicySource::Explicit,
            Some("unknown") => skillhub_core::catalog::InvocationPolicySource::Unknown,
            _ => skillhub_core::catalog::InvocationPolicySource::Default,
        };
        let call_policy = record.call_policy.clone();
        let skill = Skill::from_parts(
            id,
            record.display_name,
            record.runtime_name,
            record.description,
            record.translated_description,
            record.note,
            record.user_purpose,
            record.tags.into_iter().collect::<BTreeSet<_>>(),
            record.author,
            record.license,
            call_policy.clone(),
            SkillLifecycle::Normal,
            Vec::new(),
            None,
        )?
        .with_invocation(
            call_policy,
            invocation_source,
            record.invocation_field.clone(),
        );
        Ok(Some((skill, current)))
    }
    async fn remove_skill(&self, id: SkillId) -> AppResult<()> {
        self.remove_portable_skill(id)
    }
}
