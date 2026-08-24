use sha2::{Digest, Sha256};
use skillhub_core::scan::{DiscoveredSkill, ScanGeneration, ScanIssue, ScanResult, ScanScope};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
pub struct SkillDetectorConfig {
    pub max_depth: usize,
    pub max_entries: usize,
}

impl Default for SkillDetectorConfig {
    fn default() -> Self {
        Self {
            max_depth: 64,
            max_entries: 100_000,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct SkillDetector {
    config: SkillDetectorConfig,
    cache: BTreeMap<String, CachedSkill>,
    baseline: BTreeMap<String, DiscoveredSkill>,
    next_generation: u32,
}

impl SkillDetector {
    pub fn with_config(config: SkillDetectorConfig) -> Self {
        Self {
            config,
            ..Self::default()
        }
    }

    pub fn validate_registered_scope(&self, scope: &ScanScope) -> AppResult<()> {
        validate_scope(scope).map(|_| ())
    }

    pub fn scan(&mut self, scopes: &[ScanScope]) -> AppResult<ScanResult> {
        let mut discovered = Vec::new();
        let mut roots = Vec::new();
        let mut visited_paths = Vec::new();
        let mut errors = Vec::new();
        let mut active = BTreeSet::new();
        let mut reparsed = 0u32;
        let mut unchanged = 0u32;

        for scope in scopes {
            let root = match validate_scope(scope) {
                Ok(root) => root,
                Err(error) => {
                    errors.push(ScanIssue {
                        path: scope.root.clone(),
                        code: error.code.as_str().to_owned(),
                    });
                    continue;
                }
            };
            let root_string = root.to_string_lossy().into_owned();
            roots.push(root_string.clone());
            let mut state = WalkState {
                root: root.clone(),
                scope,
                discovered: &mut discovered,
                visited_paths: &mut visited_paths,
                errors: &mut errors,
                active: &mut active,
                reparsed: &mut reparsed,
                unchanged: &mut unchanged,
                entries: 0,
            };
            self.walk_directory(&mut state, &root, 0)?;
        }

        self.cache.retain(|path, _| active.contains(path));
        self.baseline.clear();
        self.next_generation = self.next_generation.saturating_add(1);
        Ok(ScanResult {
            generation: ScanGeneration {
                generation: self.next_generation,
                observed_at: now_secs(),
            },
            roots,
            discovered,
            visited_paths,
            reparsed_count: reparsed,
            unchanged_count: unchanged,
            errors,
        })
    }

    pub fn scan_with_previous(
        &mut self,
        scopes: &[ScanScope],
        previous: &ScanResult,
    ) -> AppResult<ScanResult> {
        self.baseline = previous
            .discovered
            .iter()
            .map(|skill| (skill.path.clone(), skill.clone()))
            .collect();
        self.scan(scopes)
    }

    pub fn rescan_skill(&mut self, scope: &ScanScope, path: &Path) -> AppResult<ScanResult> {
        let root = validate_scope(scope)?;
        let candidate = path.canonicalize().map_err(|error| io_error(path, error))?;
        if !candidate.starts_with(&root) || !candidate.is_dir() {
            return Err(
                AppError::new(ErrorCode::PathOutsideAllowedRoots, Severity::Error)
                    .with_param("path", path.to_string_lossy().into_owned())
                    .with_action(RecoveryAction::Acknowledge),
            );
        }
        let mut discovered = Vec::new();
        let mut visited_paths = vec![candidate.to_string_lossy().into_owned()];
        let mut errors = Vec::new();
        let mut active = BTreeSet::new();
        let mut reparsed = 0u32;
        let mut unchanged = 0u32;
        let mut state = WalkState {
            root: root.clone(),
            scope,
            discovered: &mut discovered,
            visited_paths: &mut visited_paths,
            errors: &mut errors,
            active: &mut active,
            reparsed: &mut reparsed,
            unchanged: &mut unchanged,
            entries: 0,
        };
        if let Some(marker_path) = find_marker(&candidate, &scope.marker) {
            match self.inspect_candidate(&mut state, &candidate, &marker_path) {
                Ok(Some(skill)) => discovered.push(skill),
                Ok(None) => {}
                Err(error) => errors.push(ScanIssue {
                    path: candidate.to_string_lossy().into_owned(),
                    code: error.code.as_str().to_owned(),
                }),
            }
        }
        self.cache.retain(|path, _| active.contains(path));
        self.baseline.clear();
        self.next_generation = self.next_generation.saturating_add(1);
        Ok(ScanResult {
            generation: ScanGeneration {
                generation: self.next_generation,
                observed_at: now_secs(),
            },
            roots: vec![root.to_string_lossy().into_owned()],
            discovered,
            visited_paths,
            reparsed_count: reparsed,
            unchanged_count: unchanged,
            errors,
        })
    }

    fn walk_directory(
        &mut self,
        state: &mut WalkState<'_>,
        directory: &Path,
        depth: usize,
    ) -> AppResult<()> {
        if depth > self.config.max_depth {
            state.errors.push(ScanIssue {
                path: directory.to_string_lossy().into_owned(),
                code: "scan.depth_limit".into(),
            });
            return Ok(());
        }
        let directory_key = directory.to_string_lossy().into_owned();
        state.visited_paths.push(directory_key);
        let marker_path = find_marker(directory, &state.scope.marker);
        if let Some(marker_path) = marker_path.as_deref() {
            match self.inspect_candidate(state, directory, marker_path) {
                Ok(Some(skill)) => state.discovered.push(skill),
                Ok(None) => {}
                Err(error) => state.errors.push(ScanIssue {
                    path: directory.to_string_lossy().into_owned(),
                    code: error.code.as_str().to_owned(),
                }),
            }
        }
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) => {
                state.errors.push(ScanIssue {
                    path: directory.to_string_lossy().into_owned(),
                    code: io_code(error.kind()),
                });
                return Ok(());
            }
        };
        for entry in entries {
            state.entries += 1;
            if state.entries > self.config.max_entries {
                state.errors.push(ScanIssue {
                    path: directory.to_string_lossy().into_owned(),
                    code: "scan.entry_limit".into(),
                });
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    state.errors.push(ScanIssue {
                        path: directory.to_string_lossy().into_owned(),
                        code: io_code(error.kind()),
                    });
                    continue;
                }
            };
            if entry.file_name().to_string_lossy() == state.scope.marker {
                continue;
            }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                self.walk_directory(state, &path, depth + 1)?;
            }
        }
        Ok(())
    }

    fn inspect_candidate(
        &mut self,
        state: &mut WalkState<'_>,
        directory: &Path,
        marker_path: &Path,
    ) -> AppResult<Option<DiscoveredSkill>> {
        let (signature, files, size, latest_modified_at) =
            collect_tree(directory, &state.scope.marker, &self.config, state)?;
        let path = directory
            .canonicalize()
            .map_err(|error| io_error(directory, error))?;
        let key = path.to_string_lossy().into_owned();
        state.active.insert(key.clone());
        let marker_metadata =
            fs::metadata(marker_path).map_err(|error| io_error(marker_path, error))?;
        let marker_size = marker_metadata.len().min(u32::MAX as u64) as u32;
        let marker_modified_at =
            (modified_at(&marker_metadata) / 1_000_000_000).min(u32::MAX as u64) as u32;
        let relative_path = path
            .strip_prefix(&state.root)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        let cached = self.cache.get(&key);
        let unchanged = cached.is_some_and(|cached| cached.signature == signature);
        let metadata_fingerprint = metadata_fingerprint(&signature);
        let baseline = self.baseline.get(&key).filter(|skill| {
            skill.metadata_fingerprint == metadata_fingerprint && skill.marker == state.scope.marker
        });
        let fingerprint = if let Some(cached) = cached.filter(|_| unchanged) {
            *state.unchanged += 1;
            cached.skill.fingerprint.clone()
        } else if let Some(previous) = baseline {
            *state.unchanged += 1;
            previous.fingerprint.clone()
        } else {
            *state.reparsed += 1;
            fingerprint(&files)?
        };
        let skill = DiscoveredSkill {
            root: state.root.to_string_lossy().into_owned(),
            relative_path,
            path: key.clone(),
            marker: state.scope.marker.clone(),
            marker_size,
            marker_modified_at,
            size: size.min(u32::MAX as u64) as u32,
            latest_modified_at: latest_modified_at.min(u32::MAX as u64) as u32,
            fingerprint,
            metadata_fingerprint,
        };
        self.cache.insert(
            key,
            CachedSkill {
                signature,
                skill: skill.clone(),
            },
        );
        Ok(Some(skill))
    }
}

#[derive(Clone, Debug)]
struct CachedSkill {
    signature: Vec<FileStamp>,
    skill: DiscoveredSkill,
}

struct WalkState<'a> {
    root: PathBuf,
    scope: &'a ScanScope,
    discovered: &'a mut Vec<DiscoveredSkill>,
    visited_paths: &'a mut Vec<String>,
    errors: &'a mut Vec<ScanIssue>,
    active: &'a mut BTreeSet<String>,
    reparsed: &'a mut u32,
    unchanged: &'a mut u32,
    entries: usize,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct FileStamp {
    relative_path: String,
    size: u64,
    modified_at: u64,
}

type TreeFacts = (Vec<FileStamp>, Vec<(String, PathBuf)>, u64, u64);

fn collect_tree(
    directory: &Path,
    _marker: &str,
    config: &SkillDetectorConfig,
    state: &mut WalkState<'_>,
) -> AppResult<TreeFacts> {
    let mut stamps = Vec::new();
    let mut files = Vec::new();
    let mut stack = vec![(directory.to_path_buf(), 0usize)];
    let mut size = 0u64;
    let mut latest = 0u64;
    while let Some((current, depth)) = stack.pop() {
        if depth > config.max_depth {
            continue;
        }
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error) => {
                state.errors.push(ScanIssue {
                    path: current.to_string_lossy().into_owned(),
                    code: io_code(error.kind()),
                });
                continue;
            }
        };
        for entry in entries {
            state.entries += 1;
            if state.entries > config.max_entries {
                state.errors.push(ScanIssue {
                    path: current.to_string_lossy().into_owned(),
                    code: "scan.entry_limit".into(),
                });
                break;
            }
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push((path, depth + 1));
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let relative = path
                .strip_prefix(directory)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let stamp = FileStamp {
                relative_path: relative.clone(),
                size: metadata.len(),
                modified_at: modified_at(&metadata),
            };
            latest = latest.max(stamp.modified_at);
            size = size.saturating_add(stamp.size);
            stamps.push(stamp);
            files.push((relative, path));
        }
    }
    stamps.sort();
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok((stamps, files, size, latest))
}

fn fingerprint(files: &[(String, PathBuf)]) -> AppResult<String> {
    let mut digest = Sha256::new();
    for (relative, path) in files {
        let content = fs::read(path).map_err(|error| io_error(path, error))?;
        digest.update((relative.len() as u64).to_le_bytes());
        digest.update(relative.as_bytes());
        digest.update((content.len() as u64).to_le_bytes());
        digest.update(&content);
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn metadata_fingerprint(stamps: &[FileStamp]) -> String {
    let mut digest = Sha256::new();
    for stamp in stamps {
        digest.update((stamp.relative_path.len() as u64).to_le_bytes());
        digest.update(stamp.relative_path.as_bytes());
        digest.update(stamp.size.to_le_bytes());
        digest.update(stamp.modified_at.to_le_bytes());
    }
    format!("sha256:{:x}", digest.finalize())
}

fn validate_scope(scope: &ScanScope) -> AppResult<PathBuf> {
    if scope.marker != "SKILL.md" {
        return Err(invalid_input("scan marker is not declared by the profile"));
    }
    let path = Path::new(&scope.root);
    if !path.is_absolute() {
        return Err(invalid_input("scan root must be an absolute path"));
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_input("scan root must be a real directory"));
    }
    let canonical = path.canonicalize().map_err(|error| io_error(path, error))?;
    if canonical.parent().is_none() || is_current_home(&canonical) {
        return Err(invalid_input("scan root is not bounded"));
    }
    Ok(canonical)
}

fn is_current_home(path: &Path) -> bool {
    ["USERPROFILE", "HOME"]
        .into_iter()
        .filter_map(std::env::var_os)
        .filter_map(|value| PathBuf::from(value).canonicalize().ok())
        .any(|home| home == path)
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

/// `Path::join` is case-insensitive on Windows. Looking up the marker through
/// directory entries preserves the profile's case-aware marker contract.
fn find_marker(directory: &Path, marker: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(directory).ok()?;
    entries.filter_map(Result::ok).find_map(|entry| {
        (entry.file_name().to_string_lossy() == marker && is_regular_file(&entry.path()))
            .then_some(entry.path())
    })
}

fn modified_at(metadata: &Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

fn now_secs() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(u32::MAX as u64) as u32
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

fn io_code(kind: std::io::ErrorKind) -> String {
    format!("scan.io_{kind:?}").to_ascii_lowercase()
}
