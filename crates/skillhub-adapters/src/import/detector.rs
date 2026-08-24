use skillhub_core::{
    source::SourceDescriptor, AppError, AppResult, ErrorCode, ImportCandidate, RecoveryAction,
    Severity,
};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillDetectionConfig {
    pub markers: Vec<String>,
    pub allow_nested_candidates: bool,
    pub max_depth: usize,
    pub max_entries: usize,
}

impl Default for SkillDetectionConfig {
    fn default() -> Self {
        Self {
            markers: vec!["SKILL.md".to_owned()],
            allow_nested_candidates: false,
            max_depth: 64,
            max_entries: 100_000,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct SkillDetector {
    config: SkillDetectionConfig,
}

impl SkillDetector {
    pub fn with_config(config: SkillDetectionConfig) -> Self {
        Self { config }
    }

    pub fn detect(
        &self,
        root: impl AsRef<Path>,
        source: SourceDescriptor,
    ) -> AppResult<Vec<ImportCandidate>> {
        self.validate_config()?;
        let root = canonical_directory(root.as_ref())?;
        let mut state = DetectionState {
            scan_root: root.clone(),
            source,
            candidates: Vec::new(),
            entries: 0,
        };
        self.walk(&mut state, &root, 0)?;
        state
            .candidates
            .sort_by(|left, right| left.relative_root.cmp(&right.relative_root));
        Ok(state.candidates)
    }

    fn validate_config(&self) -> AppResult<()> {
        if self.config.markers.is_empty()
            || self.config.markers.iter().any(|marker| {
                marker.trim().is_empty() || marker.contains('/') || marker.contains('\\')
            })
        {
            return Err(invalid_input("skill markers must be explicit file names"));
        }
        Ok(())
    }

    fn walk(&self, state: &mut DetectionState, directory: &Path, depth: usize) -> AppResult<()> {
        if depth > self.config.max_depth {
            return Ok(());
        }
        let marker = find_marker(directory, &self.config.markers);
        if let Some(marker) = marker {
            state.candidates.push(candidate_for(
                &state.scan_root,
                directory,
                &marker,
                state.source.clone(),
            )?);
            if !self.config.allow_nested_candidates {
                return Ok(());
            }
        }

        let mut entries = sorted_entries(directory)?;
        for entry in entries.drain(..) {
            state.entries += 1;
            if state.entries > self.config.max_entries {
                return Err(invalid_input("skill detection entry limit exceeded"));
            }
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            self.walk(state, &path, depth + 1)?;
        }
        Ok(())
    }
}

struct DetectionState {
    scan_root: PathBuf,
    source: SourceDescriptor,
    candidates: Vec<ImportCandidate>,
    entries: usize,
}

fn canonical_directory(path: &Path) -> AppResult<PathBuf> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_input(
            "skill detection root must be a real directory",
        ));
    }
    path.canonicalize().map_err(|error| io_error(path, error))
}

fn sorted_entries(directory: &Path) -> AppResult<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| io_error(directory, error))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

fn find_marker(directory: &Path, markers: &[String]) -> Option<String> {
    let entries = fs::read_dir(directory).ok()?;
    entries.filter_map(Result::ok).find_map(|entry| {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().into_owned();
        (markers.iter().any(|marker| marker == &file_name) && is_regular_file(&path))
            .then_some(file_name)
    })
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn candidate_for(
    scan_root: &Path,
    directory: &Path,
    marker: &str,
    source: SourceDescriptor,
) -> AppResult<ImportCandidate> {
    let absolute = directory
        .canonicalize()
        .map_err(|error| io_error(directory, error))?;
    let relative = absolute
        .strip_prefix(scan_root)
        .unwrap_or(&absolute)
        .to_string_lossy()
        .replace('\\', "/");
    let runtime_name = absolute
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| relative.clone());
    Ok(ImportCandidate::detected(
        source,
        absolute.to_string_lossy().into_owned(),
        relative,
        marker.to_owned(),
        runtime_name,
    ))
}

fn invalid_input(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Acknowledge)
}

fn io_error(path: &Path, error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("path", path.to_string_lossy().into_owned())
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
