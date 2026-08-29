use sha2::{Digest, Sha256};
use skillhub_core::backup::{
    BackupInput, BackupManifest, BackupPackage, BackupPlan, SensitiveContentDecision, SensitiveItem,
};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity, SkillId};
use std::collections::HashMap;
use std::path::PathBuf;

pub struct BackupService {
    destination: PathBuf,
}

impl BackupService {
    pub fn new(destination: PathBuf) -> Self {
        Self { destination }
    }

    pub fn prepare(&self, input: &BackupInput) -> AppResult<BackupPlan> {
        let sensitive_items = input
            .skills
            .iter()
            .filter_map(|(skill_id, content)| detect_sensitive(*skill_id, content))
            .collect();
        Ok(BackupPlan {
            scope: input.scope,
            sensitive_items,
        })
    }

    pub fn create(
        &self,
        input: &BackupInput,
        plan: &BackupPlan,
        decisions: &[(SkillId, SensitiveContentDecision)],
    ) -> AppResult<BackupPackage> {
        let chosen: HashMap<SkillId, SensitiveContentDecision> =
            decisions.iter().copied().collect();
        for item in &plan.sensitive_items {
            if !chosen.contains_key(&item.skill_id) {
                return Err(AppError::new(
                    ErrorCode::BackupSensitiveDecisionRequired,
                    Severity::Warning,
                ));
            }
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = self
            .destination
            .join(format!("skillhub-backup-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(root.join("portable")).map_err(io_error)?;
        std::fs::create_dir_all(root.join("skills")).map_err(io_error)?;
        std::fs::write(
            root.join("portable/skills.json"),
            input.portable_metadata.as_bytes(),
        )
        .map_err(io_error)?;
        let mut contains_sensitive = false;
        for (skill_id, content) in &input.skills {
            let decision = chosen.get(skill_id).copied();
            if plan
                .sensitive_items
                .iter()
                .any(|item| item.skill_id == *skill_id)
            {
                match decision {
                    Some(SensitiveContentDecision::ExcludeSkill) => continue,
                    Some(SensitiveContentDecision::IncludeAndMark) => contains_sensitive = true,
                    Some(SensitiveContentDecision::ResolveFirst) | None => {
                        return Err(AppError::new(
                            ErrorCode::BackupSensitiveDecisionRequired,
                            Severity::Warning,
                        ))
                    }
                }
            }
            let path = root.join(format!("skills/{skill_id}/SKILL.md"));
            std::fs::create_dir_all(path.parent().expect("skill parent")).map_err(io_error)?;
            std::fs::write(path, content.as_bytes()).map_err(io_error)?;
        }
        let manifest = build_manifest(&root, contains_sensitive)?;
        let bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?;
        std::fs::write(root.join("backup.json"), bytes).map_err(io_error)?;
        Ok(BackupPackage { root })
    }
}

fn detect_sensitive(skill_id: SkillId, content: &str) -> Option<SensitiveItem> {
    let lower = content.to_ascii_lowercase();
    if lower.contains("api_key") || lower.contains("token=") || content.contains("sk-") {
        Some(SensitiveItem {
            skill_id,
            reason: "possible_plaintext_credential".into(),
        })
    } else {
        None
    }
}

fn build_manifest(root: &std::path::Path, contains_sensitive: bool) -> AppResult<BackupManifest> {
    let mut entries = Vec::new();
    collect_files(root, root, &mut entries)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(BackupManifest {
        format_version: 1,
        entries,
        contains_sensitive_skill_content: contains_sensitive,
    })
}

fn collect_files(
    root: &std::path::Path,
    current: &std::path::Path,
    entries: &mut Vec<skillhub_core::backup::BackupEntry>,
) -> AppResult<()> {
    for entry in std::fs::read_dir(current).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let path = entry.path();
        if path.file_name().and_then(|v| v.to_str()) == Some("backup.json") {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, entries)?;
        } else {
            let bytes = std::fs::read(&path).map_err(io_error)?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?;
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            entries.push(skillhub_core::backup::BackupEntry {
                path: relative.to_string_lossy().replace('\\', "/"),
                sha256: format!("{:x}", hasher.finalize()),
            });
        }
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
