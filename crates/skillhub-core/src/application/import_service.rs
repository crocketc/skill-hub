use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::check::{Finding, ProductLevel};
use crate::import::{
    analyze_import, ExistingSkillRecord, ImportAnalysis, ImportCandidate, ImportDecision,
};
use crate::relationship::GovernanceTaskFact;
use crate::{AppError, AppResult, ErrorCode, OperationId, RecoveryAction, Severity, SkillId};

/// W3-1（FB-003 §23）：单个候选导入的产品级安全分级结论。"放行级"是
/// 无发现的状态；有发现时取发现中的最高产品级。分级只由确定性规则集
/// 产生，AI 结果不参与任何分级或放行判定。
#[derive(
    Clone, Copy, Debug, Default, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum ImportSecurityLevel {
    #[default]
    Pass,
    Warning,
    Danger,
}

/// W3-1：候选徽标的真实基础检查状态（§6.0 既有债修复）。扫描成功时由
/// 分级推导（passed/warning/failed），扫描失败为 `Unavailable`——绝不假
/// 显示 not_checked。
#[derive(
    Clone, Copy, Debug, Default, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum ImportCandidateCheckState {
    #[default]
    Passed,
    Warning,
    Failed,
    Unavailable,
}

/// W3-1（FB-003 裁决第 1 节 / §23）：用户对危险级候选的显式安全决策。
/// 仅危险级候选必填：`Proceed` = 仍要导入（导入后进入预警状态、不可派发，
/// 决定以 decision_source=import 留痕）；`Skip` = 不导入（不落库，按跳过
/// 落账）。警告级/放行级无需该决策；一个候选的决策不牵连批内其他候选。
#[derive(Clone, Copy, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ImportSecurityDecision {
    Proceed,
    Skip,
}

/// 一条发现的分级明细归属：处置环节完整展示所需的稳定字段（内部
/// finding id 不外露，展示名映射由客户端负责）。
#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportSecurityFindingSummary {
    pub code: String,
    pub product_level: ProductLevel,
    pub file: Option<String>,
    pub line_start: Option<u32>,
}

/// W3-1：prepare 阶段确定性扫描的分级摘要，随 `PreparedImport` 返回，
/// 供导入向导处置环节呈现危险明细与候选徽标据实显示。
#[derive(
    Clone, Debug, Default, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type,
)]
#[serde(deny_unknown_fields)]
pub struct ImportSecuritySummary {
    #[serde(default)]
    pub level: ImportSecurityLevel,
    #[serde(default)]
    pub danger_count: u32,
    #[serde(default)]
    pub warning_count: u32,
    #[serde(default)]
    pub findings: Vec<ImportSecurityFindingSummary>,
    #[serde(default)]
    pub check_state: ImportCandidateCheckState,
}

impl ImportSecuritySummary {
    /// 从确定性扫描发现计算分级（§23 定稿映射）：任一 danger 类发现 →
    /// 危险级；否则存在 warning 类发现 → 警告级；无发现 → 放行级。
    /// `product_level` 缺失的历史发现按其 severity 类映射兜底，不因缺
    /// 字段而漏判危险级。
    pub fn from_findings(findings: &[Finding]) -> Self {
        let mut summary = Self {
            level: ImportSecurityLevel::Pass,
            danger_count: 0,
            warning_count: 0,
            findings: Vec::with_capacity(findings.len()),
            check_state: ImportCandidateCheckState::Passed,
        };
        for finding in findings {
            let product_level = finding
                .product_level
                .unwrap_or_else(|| ProductLevel::from_severity(finding.severity));
            match product_level {
                ProductLevel::Danger => summary.danger_count += 1,
                ProductLevel::Warning => summary.warning_count += 1,
            }
            summary.findings.push(ImportSecurityFindingSummary {
                code: finding.code.clone(),
                product_level,
                file: finding.file.clone(),
                line_start: finding.line_start,
            });
        }
        summary.level = if summary.danger_count > 0 {
            ImportSecurityLevel::Danger
        } else if summary.warning_count > 0 {
            ImportSecurityLevel::Warning
        } else {
            ImportSecurityLevel::Pass
        };
        summary.check_state = match summary.level {
            ImportSecurityLevel::Pass => ImportCandidateCheckState::Passed,
            ImportSecurityLevel::Warning => ImportCandidateCheckState::Warning,
            ImportSecurityLevel::Danger => ImportCandidateCheckState::Failed,
        };
        summary
    }
}

/// Side effects required by a committed import. The native adapter owns the
/// actual filesystem/library implementation; this service owns ordering and
/// decision safety.
#[async_trait]
pub trait ImportBackend: Send + Sync {
    async fn copy_into_library(&self, candidate: &ImportCandidate) -> AppResult<SkillId>;
    async fn establish_managed_relation(
        &self,
        candidate: &ImportCandidate,
        skill_id: SkillId,
    ) -> AppResult<()>;
    async fn verify_managed_copy(&self, skill_id: SkillId) -> AppResult<()>;
    async fn remove_original(&self, candidate: &ImportCandidate) -> AppResult<()>;
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PreparedImport {
    pub id: OperationId,
    /// 发现时的原始候选（runtime 名保持发现事实）；落库名以
    /// `runtime_name_override` 解析：有覆盖名用覆盖名，否则用候选名。
    pub candidate: ImportCandidate,
    pub analysis: ImportAnalysis,
    /// W2-2（FB-007）：同名不同内容处置＝独立命名的覆盖名；prepare 时
    /// 已校验非空并以此名重跑库内冲突校验。提交必须携带同一覆盖名。
    #[serde(default)]
    pub runtime_name_override: Option<String>,
    /// W3-1（FB-003）：prepare 阶段确定性扫描的分级摘要与基础检查状态。
    /// 扫描失败时 check_state=unavailable，不假显示已检查。提交期的门禁
    /// 决策依据同一份分级（完整发现由应用层留存，不随 wire 暴露内部
    /// finding id）。
    #[serde(default)]
    pub security: ImportSecuritySummary,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "snake_case")]
pub enum ImportItemStatus {
    Succeeded,
    Skipped,
    Failed,
    Todo,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportItemResult {
    pub skill_id: Option<SkillId>,
    pub decision: ImportDecision,
    pub status: ImportItemStatus,
    pub original_preserved: bool,
    /// Stable machine-readable reason for a skipped or failed item.  Display
    /// copy belongs to the client; callers must not parse a prose message.
    #[serde(default)]
    pub reason_code: Option<String>,
    /// Persisted relationship-governance work created by this import item.
    /// Each fact has a stable `task_id` and is queryable through the existing
    /// relationship overview API.
    #[serde(default)]
    pub governance_tasks: Vec<GovernanceTaskFact>,
    /// OPT-20260914-08：导入即存证。提交成功时携带本次导入落库的溯源
    /// 记录（来源/Agent 形态/原始路径/导入时间/内容指纹/所有权状态），
    /// 供导入摘要展示；复用/跳过等未新建存证的分支为 None。
    #[serde(default)]
    pub provenance: Option<crate::import::ImportProvenance>,
    /// 计划 9.7：本次导入建立或刷新的活动来源副本关系；复用未建关系、
    /// 跳过等分支诚实缺省为 None。导入完成页用它直连“这次导入”的
    /// 治理上下文，绝不从缓存路径反查。
    #[serde(default)]
    pub source_relation_id: Option<String>,
}

/// 本次向导会话的批次上下文；batch_id 只用于结果关联，不作界面展示。
#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportBatchContext {
    pub batch_id: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportSummary {
    pub operation_id: OperationId,
    pub items: Vec<ImportItemResult>,
    pub committed: bool,
    /// 批次级上下文与逐项结果分离；缺省兼容旧客户端载荷。
    #[serde(default)]
    pub batch: Option<ImportBatchContext>,
}

pub struct ImportService<B> {
    backend: Arc<B>,
    prepared: Arc<Mutex<HashMap<OperationId, PreparedImport>>>,
}

impl<B> Clone for ImportService<B> {
    fn clone(&self) -> Self {
        Self {
            backend: self.backend.clone(),
            prepared: self.prepared.clone(),
        }
    }
}

impl<B> ImportService<B>
where
    B: ImportBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self {
            backend,
            prepared: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Analyze without writing to the central library or touching the source.
    pub async fn prepare(
        &self,
        candidate: ImportCandidate,
        candidate_tree_hash: Option<&str>,
        existing: &[ExistingSkillRecord],
        source_facts: &crate::import::ImportSourceFacts,
    ) -> AppResult<PreparedImport> {
        let prepared = PreparedImport {
            id: OperationId::new(),
            analysis: analyze_import(
                candidate.clone(),
                candidate_tree_hash,
                existing,
                source_facts,
            ),
            candidate,
            runtime_name_override: None,
            security: ImportSecuritySummary::default(),
        };
        self.prepared
            .lock()
            .await
            .insert(prepared.id, prepared.clone());
        Ok(prepared)
    }

    /// Commit only an action offered by the immutable preparation result.
    /// Failed side effects leave the preparation available for retry.
    pub async fn commit(
        &self,
        id: OperationId,
        decision: ImportDecision,
    ) -> AppResult<ImportSummary> {
        let prepared = self
            .prepared
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| not_found("prepared_import"))?;
        if !prepared.analysis.actions.contains(&decision) {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "decision")
                .with_action(RecoveryAction::ChooseAnotherName));
        }

        let existing_skill = prepared.analysis.matches.first().map(|item| item.skill_id);
        let (skill_id, original_preserved) = match decision {
            ImportDecision::ReuseExisting => (existing_skill, true),
            ImportDecision::EstablishManagedRelation => {
                let skill_id = existing_skill.ok_or_else(|| not_found("existing_skill"))?;
                self.backend
                    .establish_managed_relation(&prepared.candidate, skill_id)
                    .await?;
                (Some(skill_id), true)
            }
            ImportDecision::CopyIntoLibrary
            | ImportDecision::KeepIndependent
            | ImportDecision::CopyAsIndependentManagedSkill => {
                let skill_id = self.backend.copy_into_library(&prepared.candidate).await?;
                (Some(skill_id), true)
            }
            ImportDecision::TakeOverAfterVerify => {
                let skill_id = self.backend.copy_into_library(&prepared.candidate).await?;
                self.backend.verify_managed_copy(skill_id).await?;
                // Import only creates a managed copy.  Original-source removal
                // is a separate, explicitly prepared governance operation.
                (Some(skill_id), true)
            }
            ImportDecision::Skip => (None, true),
        };

        self.prepared.lock().await.remove(&id);
        Ok(ImportSummary {
            operation_id: id,
            items: vec![ImportItemResult {
                skill_id,
                decision,
                status: if decision == ImportDecision::Skip {
                    ImportItemStatus::Skipped
                } else {
                    ImportItemStatus::Succeeded
                },
                original_preserved,
                reason_code: None,
                governance_tasks: Vec::new(),
                provenance: None,
                source_relation_id: None,
            }],
            committed: true,
            batch: None,
        })
    }

    pub async fn cancel(&self, id: OperationId) -> AppResult<()> {
        if self.prepared.lock().await.remove(&id).is_none() {
            return Err(not_found("prepared_import"));
        }
        Ok(())
    }
}

fn not_found(field: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("field", field)
        .with_action(RecoveryAction::ChooseAnotherName)
}
