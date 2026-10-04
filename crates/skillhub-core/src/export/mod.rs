use crate::backup::SensitiveContentDecision;
use crate::deployment::DeploymentRecord;
use crate::{CombinationId, OperationId, SkillId, VersionId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExportSelection {
    Skills(Vec<SkillId>),
    Combination(CombinationId),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum VersionSelection {
    Current,
    History(Vec<VersionId>),
}

/// AR-025：版本内的单个文件。`path` 是版本内安全相对路径；
/// `data_base64` 是文件字节的 base64 编码（wire 层只传文本）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportFile {
    pub path: String,
    pub data_base64: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportSkill {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub content: String,
    pub display_name: String,
    /// 版本内全部文件（AR-025：导出完整目录内容，而不只是 SKILL.md）。
    /// 旧载荷可以缺省；缺省时导出回退为仅 SKILL.md。
    #[serde(default)]
    pub files: Vec<ExportFile>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    #[default]
    Folder,
    Zip,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportInput {
    pub selection: ExportSelection,
    pub versions: VersionSelection,
    pub skills: Vec<ExportSkill>,
    /// Export packaging. Defaults to the legacy folder layout so payloads
    /// recorded before the field existed keep deserializing.
    #[serde(default)]
    pub format: ExportFormat,
    /// AR-025：用户通过系统目录选择器选定的输出目录；缺省时仍写到集中库
    /// 的导出目录。宿主必须先为该路径签发 grant（选择器已自动签发）。
    #[serde(default)]
    pub output_dir: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportPlan {
    pub selection: ExportSelection,
    pub versions: VersionSelection,
    pub skills: Vec<ExportSkillSummary>,
    pub sensitive_items: Vec<ExportSensitiveItem>,
}

/// K3：导出专用敏感项（§K3 DTO 落点）。`path` 是经校验的版本内相对
/// 路径；不复用备份共享的 `SensitiveItem`，避免把版本内文件事实塞进
/// 备份模型。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportSensitiveItem {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub path: String,
    pub reason: String,
}

/// K3 预览三件套（§2）：`preview_id` + `expires_at` +
/// `confirmation_fingerprint` 绑定主体/版本/全部文件字节/格式/授权输出
/// 位置。指纹不含用户敏感决定——决定是 Commit 阶段随 `preview_id`
/// 一并提交的响应，不参与预览失效判定。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportPreview {
    pub selection: ExportSelection,
    pub versions: VersionSelection,
    pub skills: Vec<ExportSkillSummary>,
    pub sensitive_items: Vec<ExportSensitiveItem>,
    pub preview_id: OperationId,
    /// RFC 3339（UTC）绝对过期时刻。
    pub expires_at: String,
    pub confirmation_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportSkillSummary {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportDecision {
    pub skill_id: SkillId,
    pub decision: SensitiveContentDecision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportResult {
    pub path: String,
    pub skills_exported: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UninstallAction {
    Backup,
    StandardExport,
    UndeployAll,
    LeaveTargetsIndependent,
    RemoveDeviceData,
    RetainCentralLibrary,
    ClearCredentials,
    Cancel,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UninstallImpact {
    pub deployments: Vec<DeploymentRecord>,
    pub actions: Vec<UninstallAction>,
    pub preserves_central_library: bool,
}

pub struct UninstallService;

impl UninstallService {
    pub fn prepare(deployments: Vec<DeploymentRecord>) -> UninstallImpact {
        UninstallImpact {
            deployments,
            actions: vec![
                UninstallAction::Backup,
                UninstallAction::StandardExport,
                UninstallAction::UndeployAll,
                UninstallAction::LeaveTargetsIndependent,
                UninstallAction::RemoveDeviceData,
                UninstallAction::RetainCentralLibrary,
                UninstallAction::ClearCredentials,
                UninstallAction::Cancel,
            ],
            preserves_central_library: true,
        }
    }
}
