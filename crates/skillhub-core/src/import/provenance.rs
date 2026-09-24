use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{CandidateOwnership, ImportSourceClass};
use crate::source::{SourceDescriptor, SourceKind, SourceLocator};
use crate::SkillId;

/// Immutable fact for one successful import, including reuse of an existing Skill.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportProvenanceEvent {
    pub provenance_id: String,
    pub batch_id: String,
    pub skill_id: SkillId,
    pub source_class: ImportSourceClass,
    pub source: SourceDescriptor,
    /// Original local source only; never an online download workspace.
    pub local_source_path: Option<String>,
    pub source_container_id: Option<String>,
    pub physical_source_id: Option<String>,
    pub agent_client_id: Option<String>,
    pub content_fingerprint: String,
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub imported_at: i64,
}

impl ImportProvenanceEvent {
    /// Reject an acquisition cache being recorded as an online source path.
    pub fn has_valid_source_coordinates(&self) -> bool {
        if self.source_class != ImportSourceClass::Online {
            return true;
        }
        if self.local_source_path.is_some() || self.physical_source_id.is_some() {
            return false;
        }
        let (raw, allowed_schemes): (&str, &[&str]) =
            match (&self.source.kind, &self.source.locator) {
                (SourceKind::Https, SourceLocator::HttpsUrl(url)) => (url, &["https"]),
                (SourceKind::Git, SourceLocator::GitUrl(url)) => (url, &["https", "ssh", "git"]),
                _ => return false,
            };
        url::Url::parse(raw)
            .ok()
            .is_some_and(|url| allowed_schemes.contains(&url.scheme()) && url.host_str().is_some())
    }
}

/// Query handle and count for one import operation; the ID is internal UI state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportBatch {
    pub batch_id: String,
    pub imported_count: u32,
}

/// OPT-20260914-08：导入即存证。
///
/// 一次导入提交时落库的不可变事实记录：集中库里的副本从哪里来、经哪种
/// Agent 形态的目录、原始路径是什么、内容指纹是什么。后续用户重新
/// relink 来源不得改写这条历史——它回答的是"导入那一刻"的问题，而不是
/// "现在指向哪里"的问题（后者由 sources/skill_sources 承担）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportProvenance {
    pub skill_id: SkillId,
    /// Agent 形态 client_id（如 "trae.code"）。候选路径无法归属到任何已知
    /// Agent 目录时为 None——来源不明必须显式缺省，不允许猜测归属。
    pub agent_client_id: Option<String>,
    /// 导入时用户文件系统上的原始目录（目录包，含 SKILL.md）。
    pub original_path: String,
    /// 导入时确认的来源快照（kind + locator）。
    pub source: SourceDescriptor,
    /// 导入时确认的所有权状态。
    pub ownership: CandidateOwnership,
    /// 导入时计算的 canonical tree hash，与集中库版本 content_hash 同一
    /// 算法（VersionStore::hash_tree_read_only），保证可与库内版本直接比较。
    pub content_fingerprint: String,
    /// 导入时间（epoch 秒；跨 IPC 以字符串承载，见 `crate::i64_string`）。
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub imported_at: i64,
}

impl ImportProvenance {
    /// 归属不明的存证：Agent 归属留空，绝不推测。
    pub fn new(
        skill_id: SkillId,
        original_path: impl Into<String>,
        source: SourceDescriptor,
        ownership: CandidateOwnership,
        content_fingerprint: impl Into<String>,
        imported_at: i64,
    ) -> Self {
        Self {
            skill_id,
            agent_client_id: None,
            original_path: original_path.into(),
            source,
            ownership,
            content_fingerprint: content_fingerprint.into(),
            imported_at,
        }
    }

    /// 只有当候选路径确实落在某个已知 Agent 目录（logical target）之下时，
    /// 才允许盖上该 Agent 形态的 client_id。
    pub fn with_agent_client_id(mut self, client_id: impl Into<String>) -> Self {
        self.agent_client_id = Some(client_id.into());
        self
    }

    /// Expose the legacy provenance row as a normalized source relationship.
    /// This is a pure legacy compatibility view and does not change persistence.
    /// Its deterministic ID is not the import-event primary key for the future
    /// 0014 relation table.
    pub fn to_source_relation_fact(&self) -> crate::relationship::SourceRelationFact {
        use crate::relationship::{
            FileRepresentation, OwnershipState, RelationshipType, SourceRelationFact,
        };

        let ownership = match self.ownership {
            CandidateOwnership::CentralLibrary => OwnershipState::SkillhubManaged,
            CandidateOwnership::KnownAgentTarget
            | CandidateOwnership::RegisteredProject
            | CandidateOwnership::ReadOnlyBuiltinOrPlugin
            | CandidateOwnership::ArbitraryLocalDirectory
            | CandidateOwnership::DownloadedSource
            | CandidateOwnership::Unclassified => OwnershipState::ObservedUnmanaged,
        };

        SourceRelationFact {
            provenance_id: self.stable_provenance_id(),
            skill_id: self.skill_id,
            directory_node_id: None,
            agent_client_id: self.agent_client_id.clone(),
            source_path: self.original_path.clone(),
            source_path_key: crate::deployment::observed_path_key(&self.original_path),
            relationship: RelationshipType::ImportCopy,
            file_representation: FileRepresentation::Directory,
            ownership,
            link_target_path: None,
            link_target_directory_id: None,
            content_fingerprint: self.content_fingerprint.clone(),
            source: self.source.clone(),
            imported_at: self.imported_at,
        }
    }

    /// Deterministic identifier for the legacy compatibility view only. It is
    /// deliberately not an import-event primary key for the future 0014
    /// relation table; that fact must get its own storage identity.
    fn stable_provenance_id(&self) -> String {
        let identity = (
            self.skill_id.to_string(),
            self.agent_client_id.as_deref(),
            crate::deployment::observed_path_key(&self.original_path),
            &self.source,
            self.ownership,
            &self.content_fingerprint,
            self.imported_at,
        );
        let digest = Sha256::digest(
            serde_json::to_vec(&identity).expect("provenance identity is serializable"),
        );
        format!("provenance:sha256:{digest:x}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{SourceKind, SourceLocator};

    fn descriptor() -> SourceDescriptor {
        SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::local_path("/tmp/agents/trae/skills/demo"),
        )
    }

    // 来源不明（无 Agent 归属）必须显式为 None，不允许默认猜测归属。
    #[test]
    fn provenance_without_agent_keeps_client_id_absent() {
        let provenance = ImportProvenance::new(
            SkillId::new(),
            "/tmp/agents/trae/skills/demo",
            descriptor(),
            CandidateOwnership::ArbitraryLocalDirectory,
            "sha256:aa",
            1_700_000_000,
        );
        assert_eq!(provenance.agent_client_id, None);
        assert_eq!(provenance.original_path, "/tmp/agents/trae/skills/demo");
        assert_eq!(provenance.content_fingerprint, "sha256:aa");
    }

    // Agent 归属只能在确有目录证据时补盖，不允许凭空生成。
    #[test]
    fn provenance_records_verified_agent_client_id() {
        let provenance = ImportProvenance::new(
            SkillId::new(),
            "/tmp/agents/trae/skills/demo",
            descriptor(),
            CandidateOwnership::KnownAgentTarget,
            "sha256:aa",
            1_700_000_000,
        )
        .with_agent_client_id("trae.code");
        assert_eq!(provenance.agent_client_id.as_deref(), Some("trae.code"));
    }

    // 存证是不可变历史：值相等即同一存证，修改任意字段后不再相等。
    #[test]
    fn provenance_equality_is_value_based() {
        let base = ImportProvenance::new(
            SkillId::new(),
            "/tmp/demo",
            descriptor(),
            CandidateOwnership::CentralLibrary,
            "sha256:bb",
            42,
        );
        assert_eq!(base, base.clone());
        let mut changed = base.clone();
        changed.imported_at = 43;
        assert_ne!(base, changed);
    }

    #[test]
    fn normalized_source_relation_id_is_stable_per_import_event() {
        let skill_id = SkillId::new();
        let provenance = ImportProvenance::new(
            skill_id,
            "/tmp/demo",
            descriptor(),
            CandidateOwnership::CentralLibrary,
            "sha256:bb",
            42,
        );

        let first = provenance.to_source_relation_fact();
        let second = provenance.to_source_relation_fact();

        assert!(!first.provenance_id.is_empty());
        assert_eq!(first.provenance_id, second.provenance_id);
        assert_eq!(first.link_target_directory_id, None);

        let mut reimported = provenance;
        reimported.imported_at = 43;
        assert_ne!(
            first.provenance_id,
            reimported.to_source_relation_fact().provenance_id
        );
    }
}
