use sha2::{Digest, Sha256};
use skillhub_core::backup::SensitiveContentDecision;
use skillhub_core::export::{
    ExportFormat, ExportInput, ExportPlan, ExportSkillSummary, VersionSelection,
};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity, SkillId};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct StandardExport {
    /// AR-025 后两种格式都产出外层压缩包，root 指向该 zip 文件。
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
            "format_version": 2,
            "kind": "skillhub_standard_export",
            "packaging": match input.format {
                ExportFormat::Folder => "folders_in_outer_zip",
                ExportFormat::Zip => "individual_skill_zips_in_outer_zip",
            },
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
            // AR-025：两种格式都产出外层压缩包——Folder 解压后是完整
            // Skill 文件夹；Zip 解压后是独立的 Skill ZIP。
            ExportFormat::Folder => self.write_outer_archive(&entries, &manifest, false),
            ExportFormat::Zip => self.write_outer_archive(&entries, &manifest, true),
        }
    }

    fn collected_entries(
        &self,
        input: &ExportInput,
        decisions: &HashMap<SkillId, SensitiveContentDecision>,
    ) -> AppResult<Vec<ExportEntry>> {
        let mut used_dirs: HashSet<String> = HashSet::new();
        let mut entries = Vec::new();
        for skill in &input.skills {
            if decisions.get(&skill.skill_id) == Some(&SensitiveContentDecision::ExcludeSkill) {
                continue;
            }
            let dir = unique_skill_dir(&skill.display_name, &skill.skill_id, &mut used_dirs);
            let files = version_files(skill)?;
            for (relative_path, bytes) in files {
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                entries.push(ExportEntry {
                    relative: format!("skills/{dir}/{relative_path}"),
                    bytes,
                    sha256: format!("{:x}", hasher.finalize()),
                    skill_id: skill.skill_id,
                    version_id: skill.version_id.clone(),
                    display_name: skill.display_name.clone(),
                });
            }
        }
        Ok(entries)
    }

    fn write_outer_archive(
        &self,
        entries: &[ExportEntry],
        manifest: &serde_json::Value,
        wrap_individual_skill_zips: bool,
    ) -> AppResult<StandardExport> {
        let archive_path = self.destination.join(format!(
            "skillhub-export-{}-{}.zip",
            std::process::id(),
            timestamp()
        ));
        fs::create_dir_all(&self.destination).map_err(io_error)?;
        let file = fs::File::create(&archive_path).map_err(io_error)?;
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::<()>::default()
            .compression_method(zip::CompressionMethod::Deflated);
        if wrap_individual_skill_zips {
            // Zip 模式：把同一 Skill 的全部条目收进 skills/<name>.zip，
            // 内层包根目录即 SKILL.md，供 IDE Agent 直接导入。
            let mut by_dir: HashMap<String, Vec<&ExportEntry>> = HashMap::new();
            for entry in entries {
                let dir = entry
                    .relative
                    .splitn(3, '/')
                    .nth(1)
                    .unwrap_or_default()
                    .to_owned();
                by_dir.entry(dir).or_default().push(entry);
            }
            let mut dirs: Vec<_> = by_dir.keys().cloned().collect();
            dirs.sort();
            for dir in dirs {
                let inner_entries = &by_dir[&dir];
                let mut inner = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
                for entry in inner_entries {
                    let inside = entry
                        .relative
                        .splitn(3, '/')
                        .nth(2)
                        .unwrap_or_default()
                        .to_owned();
                    inner.start_file(inside, options).map_err(zip_error)?;
                    inner.write_all(&entry.bytes).map_err(io_error)?;
                }
                let inner_bytes = inner.finish().map_err(zip_error)?.into_inner();
                writer
                    .start_file(format!("skills/{dir}.zip"), options)
                    .map_err(zip_error)?;
                writer.write_all(&inner_bytes).map_err(io_error)?;
            }
        } else {
            for entry in entries {
                writer
                    .start_file(entry.relative.as_str(), options)
                    .map_err(zip_error)?;
                writer.write_all(&entry.bytes).map_err(io_error)?;
            }
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

/// SKILL.md 之外的完整目录内容（AR-025）；旧载荷没有 files 时回退为
/// 仅 SKILL.md（content 字段），保持兼容。
fn version_files(skill: &skillhub_core::ExportSkill) -> AppResult<Vec<(String, Vec<u8>)>> {
    if skill.files.is_empty() {
        return Ok(vec![("SKILL.md".into(), skill.content.as_bytes().to_vec())]);
    }
    skill
        .files
        .iter()
        .map(|file| {
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(file.data_base64.as_bytes())
                .map_err(|_| {
                    AppError::new(ErrorCode::InvalidInput, Severity::Error)
                        .with_param("path", file.path.clone())
                        .with_param("reason", "export_file_not_base64")
                })?;
            Ok((file.path.clone(), bytes))
        })
        .collect()
}

/// 显示名 → 安全目录名：保留字母数字与 -_.，其余折叠为 -；
/// 同名冲突时追加短 skill id 后缀，保证确定性且互不相同。
fn unique_skill_dir(display_name: &str, skill_id: &SkillId, used: &mut HashSet<String>) -> String {
    let sanitized: String = display_name
        .trim()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let mut candidate = sanitized.trim_matches('-').to_lowercase();
    if candidate.is_empty() {
        candidate = "skill".into();
    }
    if used.contains(&candidate) {
        let id_suffix = skill_id.to_string().replace('-', "");
        let suffix: String = id_suffix.chars().take(8).collect();
        candidate = format!("{candidate}-{suffix}");
    }
    used.insert(candidate.clone());
    candidate
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
