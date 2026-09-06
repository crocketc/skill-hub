use sha2::{Digest, Sha256};
use skillhub_core::backup::SensitiveContentDecision;
use skillhub_core::export::{
    ExportFormat, ExportInput, ExportPlan, ExportSkillSummary, VersionSelection,
};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity, SkillId};
use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct StandardExport {
    /// Folder exports point at the export directory; zip exports point at
    /// the archive file.
    pub root: PathBuf,
}

struct ExportEntry {
    relative: String,
    bytes: Vec<u8>,
    sha256: String,
    skill_id: SkillId,
    version_id: skillhub_core::VersionId,
    display_name: String,
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
        let entries = self.collected_entries(input, &decisions)?;
        let manifest = serde_json::json!({
            "format_version": 1,
            "kind": "skillhub_standard_export",
            "version_selection": selection_name(&input.versions),
            "entries": entries
                .iter()
                .map(|entry| {
                    serde_json::json!({
                        "path": entry.relative,
                        "sha256": entry.sha256,
                        "skill_id": entry.skill_id,
                        "version_id": entry.version_id,
                        "display_name": entry.display_name,
                    })
                })
                .collect::<Vec<_>>(),
        });
        match input.format {
            ExportFormat::Folder => self.write_folder(&entries, &manifest),
            ExportFormat::Zip => self.write_archive(&entries, &manifest),
        }
    }

    fn collected_entries(
        &self,
        input: &ExportInput,
        decisions: &HashMap<SkillId, SensitiveContentDecision>,
    ) -> AppResult<Vec<ExportEntry>> {
        let mut entries = Vec::new();
        for skill in &input.skills {
            if decisions.get(&skill.skill_id) == Some(&SensitiveContentDecision::ExcludeSkill) {
                continue;
            }
            let relative = format!("skills/{}/SKILL.md", skill.skill_id);
            let mut hasher = Sha256::new();
            hasher.update(skill.content.as_bytes());
            entries.push(ExportEntry {
                relative,
                bytes: skill.content.as_bytes().to_vec(),
                sha256: format!("{:x}", hasher.finalize()),
                skill_id: skill.skill_id,
                version_id: skill.version_id.clone(),
                display_name: skill.display_name.clone(),
            });
        }
        Ok(entries)
    }

    fn write_folder(
        &self,
        entries: &[ExportEntry],
        manifest: &serde_json::Value,
    ) -> AppResult<StandardExport> {
        let root = self.destination.join(format!(
            "skillhub-export-{}-{}",
            std::process::id(),
            timestamp()
        ));
        fs::create_dir_all(root.join("skills")).map_err(io_error)?;
        for entry in entries {
            let path = root.join(&entry.relative);
            fs::create_dir_all(path.parent().expect("skill export parent")).map_err(io_error)?;
            fs::write(&path, &entry.bytes).map_err(io_error)?;
        }
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec_pretty(manifest).map_err(json_error)?,
        )
        .map_err(io_error)?;
        Ok(StandardExport { root })
    }

    fn write_archive(
        &self,
        entries: &[ExportEntry],
        manifest: &serde_json::Value,
    ) -> AppResult<StandardExport> {
        let archive_path = self.destination.join(format!(
            "skillhub-export-{}-{}.zip",
            std::process::id(),
            timestamp()
        ));
        let file = fs::File::create(&archive_path).map_err(io_error)?;
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::<()>::default()
            .compression_method(zip::CompressionMethod::Deflated);
        writer
            .add_directory("skills/", options)
            .map_err(zip_error)?;
        for entry in entries {
            writer
                .start_file(entry.relative.as_str(), options)
                .map_err(zip_error)?;
            writer.write_all(&entry.bytes).map_err(io_error)?;
        }
        writer
            .start_file("manifest.json", options)
            .map_err(zip_error)?;
        writer
            .write_all(&serde_json::to_vec_pretty(manifest).map_err(json_error)?)
            .map_err(io_error)?;
        writer.finish().map_err(zip_error)?;
        Ok(StandardExport { root: archive_path })
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

fn zip_error(error: zip::result::ZipError) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
