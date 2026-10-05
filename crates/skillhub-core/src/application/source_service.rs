use std::sync::Arc;

use crate::source::update::{
    AppliedSourceUpdate, SourceUpdateBackend, SourceUpdatePreview, UpdateDecision,
    UpstreamCheckResult,
};
use crate::source::SourceDescriptor;
use crate::{AppResult, OperationId, SkillId};

/// K6：来源更新只有一条预览绑定路径。prepare 产出候选预览；
/// commit 携带 preview_id 与用户决定，重核与消耗由后端完成。
/// 非破坏性决定（KeepLocal/Cancel）不触碰任何文件，也不需要预览。
pub struct SourceService<B> {
    backend: Arc<B>,
}

impl<B> Clone for SourceService<B> {
    fn clone(&self) -> Self {
        Self {
            backend: self.backend.clone(),
        }
    }
}

impl<B> SourceService<B>
where
    B: SourceUpdateBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self { backend }
    }

    pub async fn relink_source(
        &self,
        skill_id: SkillId,
        source: SourceDescriptor,
    ) -> AppResult<()> {
        self.backend.relink_source(skill_id, source).await
    }

    pub async fn check_update(&self, skill_id: SkillId) -> AppResult<UpstreamCheckResult> {
        self.backend.check_source_update(skill_id).await
    }

    pub async fn prepare_update(&self, skill_id: SkillId) -> AppResult<SourceUpdatePreview> {
        self.backend.prepare_source_update(skill_id).await
    }

    pub async fn commit_update(
        &self,
        skill_id: SkillId,
        preview_id: OperationId,
        decision: UpdateDecision,
    ) -> AppResult<AppliedSourceUpdate> {
        if matches!(decision, UpdateDecision::KeepLocal | UpdateDecision::Cancel) {
            return Ok(AppliedSourceUpdate::new(skill_id, decision));
        }
        self.backend
            .commit_source_update(skill_id, preview_id, decision)
            .await
    }
}
