use skillhub_core::backup::{
    BackupPackage, RestoreConflict, RestoreConflictDecision, RestoreConflictKind, RestorePlan,
    RestoreResult,
};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity, SkillId};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use super::BackupService;

pub struct RestoreService {
    destination: PathBuf,
    fault: Option<String>,
}

impl RestoreService {
    pub fn new(destination: PathBuf) -> Self {
        Self {
            destination,
            fault: None,
        }
    }

    pub fn with_fault(mut self, fault: impl Into<String>) -> Self {
        self.fault = Some(fault.into());
        self
    }

    pub fn root(&self) -> &Path {
        &self.destination
    }

    pub fn prepare(&self, package: &BackupPackage) -> AppResult<RestorePlan> {
        let verified = BackupService::new(package.root.clone()).verify(package)?;
        let mut skills = HashSet::new();
        for entry in &verified.manifest.entries {
            if let Some(id) = skill_id_from_entry(&entry.path) {
                skills.insert(id);
            }
        }
        let mut conflicts = Vec::new();
        let mut skill_ids: Vec<_> = skills.iter().copied().collect();
        skill_ids.sort_by_key(|id| id.to_string());
        for id in &skill_ids {
            let path = self.destination.join("skills").join(id.to_string());
            if path.join("SKILL.md").exists() {
                conflicts.push(RestoreConflict {
                    skill_id: Some(*id),
                    kind: RestoreConflictKind::ExistingSkill,
                    detail: format!("skill {} already exists", id),
                });
            }
        }
        let deployments_requiring_rediscovery =
            deployment_count(&read_portable_metadata(package).unwrap_or_default());
        Ok(RestorePlan {
            format_version: verified.manifest.format_version,
            skills: skills.len() as u32,
            deployments_requiring_rediscovery,
            conflicts,
        })
    }

    pub fn commit(
        &self,
        package: &BackupPackage,
        plan: &RestorePlan,
        decisions: &[(SkillId, RestoreConflictDecision)],
    ) -> AppResult<RestoreResult> {
        let verified = BackupService::new(package.root.clone()).verify(package)?;
        let decisions: HashMap<SkillId, RestoreConflictDecision> =
            decisions.iter().copied().collect();
        for conflict in &plan.conflicts {
            if let Some(id) = conflict.skill_id {
                if !decisions.contains_key(&id) {
                    return Err(AppError::new(
                        ErrorCode::BackupRestoreDecisionRequired,
                        Severity::Warning,
                    ));
                }
            }
        }
        let stage = staging_path(&self.destination);
        if stage.exists() {
            fs::remove_dir_all(&stage).map_err(io_error)?;
        }
        fs::create_dir_all(&stage).map_err(io_error)?;
        if self.destination.exists() {
            copy_existing_tree(&self.destination, &stage)?;
        }
        if let Err(error) =
            copy_verified_files(package, &verified.manifest.entries, &stage, &decisions)
        {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
        if self.fault.as_deref() == Some("before_restore_switch") {
            let _ = fs::remove_dir_all(&stage);
            return Err(AppError::new(ErrorCode::InternalError, Severity::Error));
        }
        let previous = self.destination.with_extension(format!(
            "restore-previous-{}-{}",
            std::process::id(),
            timestamp()
        ));
        let had_destination = self.destination.exists();
        if had_destination {
            fs::rename(&self.destination, &previous).map_err(io_error)?;
        }
        if let Err(error) = fs::rename(&stage, &self.destination) {
            if had_destination {
                let _ = fs::rename(&previous, &self.destination);
            }
            let _ = fs::remove_dir_all(&stage);
            return Err(io_error(error));
        }
        if had_destination {
            let _ = fs::remove_dir_all(previous);
        }
        let skipped = decisions
            .values()
            .filter(|decision| **decision == RestoreConflictDecision::Skip)
            .count() as u32;
        Ok(RestoreResult {
            skills_restored: plan.skills.saturating_sub(skipped),
            skills_skipped: skipped,
            deployments_requiring_rediscovery: plan.deployments_requiring_rediscovery,
        })
    }
}

fn copy_verified_files(
    package: &BackupPackage,
    entries: &[skillhub_core::backup::BackupEntry],
    stage: &Path,
    decisions: &HashMap<SkillId, RestoreConflictDecision>,
) -> AppResult<()> {
    for entry in entries {
        let Some(id) = skill_id_from_entry(&entry.path) else {
            if entry.path == "portable/skills.json" {
                let metadata = read_portable_metadata(package).unwrap_or_default();
                fs::create_dir_all(stage.join("portable")).map_err(io_error)?;
                fs::write(
                    stage.join(&entry.path),
                    sanitize_portable_metadata(&metadata),
                )
                .map_err(io_error)?;
            }
            continue;
        };
        let decision = decisions.get(&id).copied();
        if decision == Some(RestoreConflictDecision::Skip) {
            continue;
        }
        let output_id = if decision == Some(RestoreConflictDecision::KeepBoth) {
            format!("{}-restored-{}", id, timestamp())
        } else {
            id.to_string()
        };
        let output = stage.join("skills").join(output_id).join("SKILL.md");
        fs::create_dir_all(output.parent().expect("skill output parent")).map_err(io_error)?;
        fs::copy(package.root.join(&entry.path), output).map_err(io_error)?;
    }
    Ok(())
}

fn copy_existing_tree(source: &Path, destination: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(source).map_err(io_error)?;
    if metadata.file_type().is_symlink() {
        return Err(AppError::new(
            ErrorCode::PathOutsideAllowedRoot,
            Severity::Error,
        ));
    }
    fs::create_dir_all(destination).map_err(io_error)?;
    for entry in fs::read_dir(source).map_err(io_error)? {
        let path = entry.map_err(io_error)?.path();
        let name = path
            .file_name()
            .ok_or_else(|| AppError::new(ErrorCode::InternalError, Severity::Error))?;
        let target = destination.join(name);
        if path.is_dir() {
            copy_existing_tree(&path, &target)?;
        } else {
            fs::copy(&path, &target).map_err(io_error)?;
        }
    }
    Ok(())
}

fn skill_id_from_entry(path: &str) -> Option<SkillId> {
    let mut parts = path.split('/');
    if parts.next()? != "skills" || parts.next_back()? != "SKILL.md" {
        return None;
    }
    SkillId::from_str(parts.next()?).ok()
}

fn read_portable_metadata(package: &BackupPackage) -> Option<String> {
    fs::read_to_string(package.root.join("portable/skills.json")).ok()
}

fn deployment_count(metadata: &str) -> u32 {
    serde_json::from_str::<serde_json::Value>(metadata)
        .ok()
        .and_then(|value| {
            value
                .get("deployments")
                .and_then(|items| items.as_array())
                .map(|items| items.len() as u32)
        })
        .unwrap_or_default()
}

fn sanitize_portable_metadata(metadata: &str) -> Vec<u8> {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(metadata) else {
        return metadata.as_bytes().to_vec();
    };
    strip_device_fields(&mut value);
    serde_json::to_vec_pretty(&value).unwrap_or_else(|_| metadata.as_bytes().to_vec())
}

fn strip_device_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            object.retain(|key, _| {
                !matches!(
                    key.to_ascii_lowercase().as_str(),
                    "target_path" | "physical_path" | "absolute_path" | "device_path"
                )
            });
            for child in object.values_mut() {
                strip_device_fields(child);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                strip_device_fields(item);
            }
        }
        _ => {}
    }
}

fn staging_path(destination: &Path) -> PathBuf {
    destination.with_extension(format!(
        "restore-staging-{}-{}",
        std::process::id(),
        timestamp()
    ))
}

fn timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
