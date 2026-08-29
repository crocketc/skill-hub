use sha2::{Digest, Sha256};
use skillhub_core::backup::SensitiveContentDecision;
use skillhub_core::export::{ExportInput, ExportPlan, ExportSkillSummary, VersionSelection};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity, SkillId};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct StandardExport {
    pub root: PathBuf,
}

pub struct ExportService {
    destination: PathBuf,
}

impl ExportService {
    pub fn new(destination: PathBuf) -> Self {
        Self { destination }
    }

    pub fn prepare(&self, input: &ExportInput) -> AppResult<ExportPlan> {
        let mut sensitive_items = Vec::new();
        for skill in &input.skills {
            let lower = skill.content.to_ascii_lowercase();
            if lower.contains("api_key")
                || lower.contains("token=")
                || skill.content.contains("sk-")
            {
                sensitive_items.push(skillhub_core::backup::SensitiveItem {
                    skill_id: skill.skill_id,
                    reason: "possible_plaintext_credential".into(),
                });
            }
        }
        Ok(ExportPlan {
            selection: input.selection.clone(),
            versions: input.versions.clone(),
            skills: input
                .skills
                .iter()
                .map(|skill| ExportSkillSummary {
                    skill_id: skill.skill_id,
                    version_id: skill.version_id.clone(),
                    display_name: skill.display_name.clone(),
                })
                .collect(),
            sensitive_items,
        })
    }

    pub fn create(
        &self,
        input: &ExportInput,
        plan: &ExportPlan,
        decisions: &[(SkillId, SensitiveContentDecision)],
    ) -> AppResult<StandardExport> {
        let decisions: HashMap<SkillId, SensitiveContentDecision> =
            decisions.iter().copied().collect();
        for item in &plan.sensitive_items {
            if !matches!(
                decisions.get(&item.skill_id),
                Some(
                    SensitiveContentDecision::ExcludeSkill
                        | SensitiveContentDecision::IncludeAndMark
                )
            ) {
                return Err(AppError::new(
                    ErrorCode::BackupExportDecisionRequired,
                    Severity::Warning,
                ));
            }
        }
        let root = self.destination.join(format!(
            "skillhub-export-{}-{}",
            std::process::id(),
            timestamp()
        ));
        fs::create_dir_all(root.join("skills")).map_err(io_error)?;
        let mut entries = Vec::new();
        for skill in &input.skills {
            if decisions.get(&skill.skill_id) == Some(&SensitiveContentDecision::ExcludeSkill) {
                continue;
            }
            let relative = format!("skills/{}/SKILL.md", skill.skill_id);
            let path = root.join(&relative);
            fs::create_dir_all(path.parent().expect("skill export parent")).map_err(io_error)?;
            fs::write(&path, skill.content.as_bytes()).map_err(io_error)?;
            let mut hasher = Sha256::new();
            hasher.update(skill.content.as_bytes());
            entries.push(serde_json::json!({
                "path": relative,
                "sha256": format!("{:x}", hasher.finalize()),
                "skill_id": skill.skill_id,
                "version_id": skill.version_id,
                "display_name": skill.display_name,
            }));
        }
        let manifest = serde_json::json!({
            "format_version": 1,
            "kind": "skillhub_standard_export",
            "version_selection": selection_name(&input.versions),
            "entries": entries,
        });
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).map_err(json_error)?,
        )
        .map_err(io_error)?;
        Ok(StandardExport { root })
    }
}

fn selection_name(selection: &VersionSelection) -> &'static str {
    match selection {
        VersionSelection::Current => "current",
        VersionSelection::History(_) => "history",
    }
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

fn json_error(error: serde_json::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
