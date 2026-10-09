//! Deterministic projection of duplicate and same-name facts within one
//! confirmed Agent or Agent × registered Project environment.

use std::collections::{BTreeMap, BTreeSet};

use crate::agent::AgentDirectoryRole;
use crate::import::normalize_runtime_name;
use crate::relationship::{DirectoryRecognition, UsageRelationView};
use crate::{ProjectId, SkillId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageEnvironmentKey {
    pub agent_client_id: String,
    pub project_id: Option<ProjectId>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageEnvironmentDirectory {
    pub directory_id: String,
    pub path: String,
    pub role: AgentDirectoryRole,
    pub recognition: DirectoryRecognition,
    pub physical_identity: Option<String>,
    pub consumers: Vec<UsageEnvironmentKey>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageEnvironmentEntry {
    pub directory_id: String,
    pub relative_entry_path: String,
    pub runtime_name: Option<String>,
    pub content_fingerprint: Option<String>,
    pub physical_identity: Option<String>,
    pub skill_id: Option<SkillId>,
    pub relation_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageEnvironmentProbeLimitationReason {
    RecognitionNotConfirmed,
    DirectoryUnavailable,
    DirectoryIdentityUnavailable,
    EntryIdentityUnavailable,
    RuntimeNameUnavailable,
    ContentFingerprintUnavailable,
    ScanFailed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageEnvironmentProbeLimitation {
    pub directory_id: Option<String>,
    pub relative_entry_path: Option<String>,
    pub reason: UsageEnvironmentProbeLimitationReason,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageEnvironmentSnapshot {
    pub environment: UsageEnvironmentKey,
    pub recognized_directories: Vec<UsageEnvironmentDirectory>,
    pub discovered_entries: Vec<UsageEnvironmentEntry>,
    /// Persisted relationships enrich observed files but do not hide a file
    /// that remains in a recognized directory after a release decision.
    pub usage_relations: Vec<UsageRelationView>,
    pub probe_limitations: Vec<UsageEnvironmentProbeLimitation>,
    pub relationship_revision: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentProblemKind {
    SameSkill,
    NameConflict,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentProblemEnvironmentResult {
    pub environment: UsageEnvironmentKey,
    pub closed: bool,
    pub relationship_revision: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentProblemView {
    pub problem_id: String,
    pub kind: EnvironmentProblemKind,
    pub entries: Vec<UsageEnvironmentEntry>,
    pub consumers: Vec<UsageEnvironmentKey>,
    pub environment_results: Vec<EnvironmentProblemEnvironmentResult>,
    pub closed: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentProblemAnalysis {
    pub problems: Vec<EnvironmentProblemView>,
    pub probe_limitations: Vec<UsageEnvironmentProbeLimitation>,
}

pub fn detect_environment_problems(
    input: &UsageEnvironmentSnapshot,
) -> Vec<EnvironmentProblemView> {
    let directories = input
        .recognized_directories
        .iter()
        .map(|directory| (directory.directory_id.as_str(), directory))
        .collect::<BTreeMap<_, _>>();
    let mut entries_by_identity = BTreeMap::<String, UsageEnvironmentEntry>::new();

    for observed in &input.discovered_entries {
        let Some(directory) = directories.get(observed.directory_id.as_str()) else {
            continue;
        };
        if directory.recognition != DirectoryRecognition::Supported {
            continue;
        }
        let Some(physical_identity) = observed.physical_identity.as_ref() else {
            continue;
        };
        let mut entry = observed.clone();
        enrich_from_relations(&mut entry, &input.usage_relations);
        entries_by_identity
            .entry(physical_identity.clone())
            .and_modify(|existing| merge_entry(existing, &entry))
            .or_insert(entry);
    }

    let entries = entries_by_identity.into_values().collect::<Vec<_>>();
    let mut groups =
        BTreeMap::<(EnvironmentProblemKindKey, String), Vec<UsageEnvironmentEntry>>::new();

    let mut same_skill_by_fingerprint = BTreeMap::<String, Vec<UsageEnvironmentEntry>>::new();
    let mut same_name_by_name = BTreeMap::<String, Vec<UsageEnvironmentEntry>>::new();
    for entry in entries {
        if let Some(fingerprint) = entry.content_fingerprint.as_ref() {
            same_skill_by_fingerprint
                .entry(fingerprint.clone())
                .or_default()
                .push(entry.clone());
        }
        if let (Some(name), Some(_)) = (
            entry.runtime_name.as_deref(),
            entry.content_fingerprint.as_ref(),
        ) {
            let normalized = normalize_runtime_name(name);
            if !normalized.is_empty() {
                same_name_by_name.entry(normalized).or_default().push(entry);
            }
        }
    }

    for (fingerprint, mut matching) in same_skill_by_fingerprint {
        if matching.len() < 2 {
            continue;
        }
        matching.sort_by_key(entry_sort_key);
        groups.insert(
            (EnvironmentProblemKindKey::SameSkill, fingerprint),
            matching,
        );
    }
    for (normalized_name, mut matching) in same_name_by_name {
        let distinct_fingerprints = matching
            .iter()
            .filter_map(|entry| entry.content_fingerprint.as_deref())
            .collect::<BTreeSet<_>>();
        if matching.len() < 2 || distinct_fingerprints.len() < 2 {
            continue;
        }
        matching.sort_by_key(entry_sort_key);
        groups.insert(
            (EnvironmentProblemKindKey::NameConflict, normalized_name),
            matching,
        );
    }

    let mut problems = groups
        .into_iter()
        .map(|((kind_key, signature), entries)| {
            let kind = kind_key.as_problem_kind();
            let problem_id = stable_problem_id(kind, &signature, &entries, &directories);
            let mut consumers = BTreeMap::<String, UsageEnvironmentKey>::new();
            consumers.insert(
                environment_sort_key(&input.environment),
                input.environment.clone(),
            );
            for entry in &entries {
                if let Some(directory) = directories.get(entry.directory_id.as_str()) {
                    for consumer in &directory.consumers {
                        consumers.insert(environment_sort_key(consumer), consumer.clone());
                    }
                }
            }
            EnvironmentProblemView {
                problem_id,
                kind,
                entries,
                consumers: consumers.into_values().collect(),
                environment_results: vec![EnvironmentProblemEnvironmentResult {
                    environment: input.environment.clone(),
                    closed: false,
                    relationship_revision: input.relationship_revision.clone(),
                }],
                closed: false,
            }
        })
        .collect::<Vec<_>>();
    problems.sort_by(|left, right| left.problem_id.cmp(&right.problem_id));
    problems
}

pub fn analyze_environment_problems(
    input: &UsageEnvironmentSnapshot,
) -> EnvironmentProblemAnalysis {
    let mut probe_limitations = input.probe_limitations.clone();
    for directory in &input.recognized_directories {
        if directory.recognition == DirectoryRecognition::Unknown {
            probe_limitations.push(UsageEnvironmentProbeLimitation {
                directory_id: Some(directory.directory_id.clone()),
                relative_entry_path: None,
                reason: UsageEnvironmentProbeLimitationReason::RecognitionNotConfirmed,
            });
        }
    }
    for entry in &input.discovered_entries {
        if entry.physical_identity.is_none() {
            probe_limitations.push(UsageEnvironmentProbeLimitation {
                directory_id: Some(entry.directory_id.clone()),
                relative_entry_path: Some(entry.relative_entry_path.clone()),
                reason: UsageEnvironmentProbeLimitationReason::EntryIdentityUnavailable,
            });
        }
        if entry.runtime_name.as_deref().is_none_or(str::is_empty) {
            probe_limitations.push(UsageEnvironmentProbeLimitation {
                directory_id: Some(entry.directory_id.clone()),
                relative_entry_path: Some(entry.relative_entry_path.clone()),
                reason: UsageEnvironmentProbeLimitationReason::RuntimeNameUnavailable,
            });
        }
        if entry.content_fingerprint.is_none() {
            probe_limitations.push(UsageEnvironmentProbeLimitation {
                directory_id: Some(entry.directory_id.clone()),
                relative_entry_path: Some(entry.relative_entry_path.clone()),
                reason: UsageEnvironmentProbeLimitationReason::ContentFingerprintUnavailable,
            });
        }
    }
    probe_limitations.sort_by_key(limitation_sort_key);
    probe_limitations.dedup();
    EnvironmentProblemAnalysis {
        problems: detect_environment_problems(input),
        probe_limitations,
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum EnvironmentProblemKindKey {
    SameSkill,
    NameConflict,
}

impl EnvironmentProblemKindKey {
    fn as_problem_kind(self) -> EnvironmentProblemKind {
        match self {
            Self::SameSkill => EnvironmentProblemKind::SameSkill,
            Self::NameConflict => EnvironmentProblemKind::NameConflict,
        }
    }
}

fn enrich_from_relations(entry: &mut UsageEnvironmentEntry, relations: &[UsageRelationView]) {
    let matching = relations.iter().filter(|relation| {
        relation.entry_key.as_ref().is_some_and(|key| {
            key.directory_id == entry.directory_id
                && key.relative_entry_path == entry.relative_entry_path
        })
    });
    let mut skill_ids = Vec::new();
    for relation in matching {
        if let Some(skill_id) = relation.skill_id {
            if !skill_ids.contains(&skill_id) {
                skill_ids.push(skill_id);
            }
        }
        entry.relation_ids.push(relation.relation_id.clone());
        entry
            .relation_ids
            .extend(relation.evidence_relation_ids.iter().cloned());
    }
    if skill_ids.len() == 1 {
        entry.skill_id = skill_ids.into_iter().next();
    } else if skill_ids.len() > 1 {
        entry.skill_id = None;
    }
    entry.relation_ids.sort();
    entry.relation_ids.dedup();
}

fn merge_entry(existing: &mut UsageEnvironmentEntry, other: &UsageEnvironmentEntry) {
    if existing.skill_id != other.skill_id {
        existing.skill_id = None;
    }
    existing
        .relation_ids
        .extend(other.relation_ids.iter().cloned());
    existing.relation_ids.sort();
    existing.relation_ids.dedup();
    if entry_sort_key(other) < entry_sort_key(existing) {
        existing.directory_id = other.directory_id.clone();
        existing.relative_entry_path = other.relative_entry_path.clone();
    }
}

fn entry_sort_key(entry: &UsageEnvironmentEntry) -> (String, String, String) {
    (
        entry.physical_identity.clone().unwrap_or_default(),
        entry.directory_id.clone(),
        entry.relative_entry_path.to_lowercase(),
    )
}

fn stable_problem_id(
    kind: EnvironmentProblemKind,
    signature: &str,
    entries: &[UsageEnvironmentEntry],
    directories: &BTreeMap<&str, &UsageEnvironmentDirectory>,
) -> String {
    let stable_entry_key = |entry: &UsageEnvironmentEntry| {
        format!(
            "{}:{}",
            entry.directory_id,
            entry.relative_entry_path.to_lowercase()
        )
    };
    let shared_entry_keys = entries
        .iter()
        .filter(|entry| {
            directories
                .get(entry.directory_id.as_str())
                .is_some_and(|directory| directory.role == AgentDirectoryRole::SharedDirectory)
        })
        .map(stable_entry_key)
        .collect::<BTreeSet<_>>();
    let identity_scope = if shared_entry_keys.is_empty() {
        entries
            .iter()
            .map(stable_entry_key)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join("|")
    } else {
        format!(
            "shared:{}",
            shared_entry_keys.into_iter().collect::<Vec<_>>().join("|")
        )
    };
    let kind_name = match kind {
        EnvironmentProblemKind::SameSkill => "same_skill",
        EnvironmentProblemKind::NameConflict => "name_conflict",
    };
    let stable_signature = match kind {
        EnvironmentProblemKind::SameSkill => "",
        EnvironmentProblemKind::NameConflict => signature,
    };
    let material =
        format!("environment-problem-v1\0{kind_name}\0{identity_scope}\0{stable_signature}");
    let digest = Sha256::digest(material.as_bytes());
    format!(
        "env:{kind_name}:{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn environment_sort_key(environment: &UsageEnvironmentKey) -> String {
    format!(
        "{}:{}",
        environment.agent_client_id,
        environment
            .project_id
            .map(|id| id.to_string())
            .unwrap_or_default()
    )
}

fn limitation_sort_key(limitation: &UsageEnvironmentProbeLimitation) -> (String, String, u8) {
    let reason = match limitation.reason {
        UsageEnvironmentProbeLimitationReason::RecognitionNotConfirmed => 0,
        UsageEnvironmentProbeLimitationReason::DirectoryUnavailable => 1,
        UsageEnvironmentProbeLimitationReason::DirectoryIdentityUnavailable => 2,
        UsageEnvironmentProbeLimitationReason::EntryIdentityUnavailable => 3,
        UsageEnvironmentProbeLimitationReason::RuntimeNameUnavailable => 4,
        UsageEnvironmentProbeLimitationReason::ContentFingerprintUnavailable => 5,
        UsageEnvironmentProbeLimitationReason::ScanFailed => 6,
    };
    (
        limitation.directory_id.clone().unwrap_or_default(),
        limitation.relative_entry_path.clone().unwrap_or_default(),
        reason,
    )
}
