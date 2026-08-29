mod manifest;
mod object_store;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::to_vec_pretty;
use skillhub_core::application::{CapturedVersion, VersionCapture};
use skillhub_core::{
    AppError, AppResult, ErrorCode, FileEntry, LibraryPaths, RecoveryAction, Severity, SkillId,
    VersionDiff, VersionId, VersionManifest, VersionRecord,
};

use crate::library::CentralLibrary;

#[async_trait::async_trait]
impl skillhub_core::VersionRepository for VersionStore {
    async fn current(&self, skill_id: SkillId) -> AppResult<Option<VersionId>> {
        VersionStore::current(self, skill_id)
    }

    async fn set_current(&self, skill_id: SkillId, version_id: &VersionId) -> AppResult<()> {
        VersionStore::set_current(self, skill_id, version_id)
    }
    async fn clear_current(&self, skill_id: SkillId) -> AppResult<()> {
        VersionStore::clear_current(self, skill_id)
    }

    async fn diff(&self, left: &VersionId, right: &VersionId) -> AppResult<VersionDiff> {
        VersionStore::diff(self, left, right)
    }

    async fn list(&self, skill_id: SkillId) -> AppResult<Vec<VersionRecord>> {
        VersionStore::list(self, skill_id)
    }
}

#[async_trait::async_trait]
impl VersionCapture for VersionStore {
    async fn capture(&self, skill_id: SkillId, source: &Path) -> AppResult<VersionRecord> {
        VersionStore::capture(self, skill_id, source)
    }

    async fn capture_with_status(
        &self,
        skill_id: SkillId,
        source: &Path,
    ) -> AppResult<CapturedVersion> {
        VersionStore::capture_with_status(self, skill_id, source)
    }

    async fn discard(&self, record: &VersionRecord) -> AppResult<()> {
        let manifest_path = self.find_manifest(&record.id)?;
        if manifest_path.exists() {
            fs::remove_file(&manifest_path).map_err(io_error)?;
        }
        for entry in &record.manifest.entries {
            let object = self.paths.objects_dir.join(
                entry
                    .object_id
                    .strip_prefix("sha256:")
                    .unwrap_or(&entry.object_id),
            );
            if !object.exists() {
                continue;
            }
            let still_referenced = self.any_manifest_references(&entry.object_id, &record.id)?;
            if !still_referenced {
                let _ = fs::remove_file(object);
            }
        }
        Ok(())
    }
}

impl skillhub_core::application::VersionMaterializer for VersionStore {
    fn materialize_version(&self, version_id: &VersionId, output: &Path) -> AppResult<()> {
        self.materialize(version_id, output)
    }
}

pub struct VersionStore {
    paths: LibraryPaths,
}

impl VersionStore {
    fn any_manifest_references(&self, object_id: &str, ignored: &VersionId) -> AppResult<bool> {
        for skill in fs::read_dir(&self.paths.versions_dir).map_err(io_error)? {
            let dir = skill.map_err(io_error)?.path();
            for item in fs::read_dir(dir).map_err(io_error)? {
                let path = item.map_err(io_error)?.path();
                if path.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                let text = fs::read_to_string(&path).map_err(io_error)?;
                if text.contains(&format!("\"{}\"", ignored.as_str())) {
                    continue;
                }
                if text.contains(object_id) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    pub fn new(paths: LibraryPaths) -> Self {
        Self { paths }
    }

    pub fn from_library(library: &CentralLibrary) -> Self {
        Self::new(library.paths().clone())
    }

    pub fn capture(&self, skill_id: SkillId, source: impl AsRef<Path>) -> AppResult<VersionRecord> {
        Ok(self.capture_with_status(skill_id, source)?.record)
    }

    pub fn capture_with_status(
        &self,
        skill_id: SkillId,
        source: impl AsRef<Path>,
    ) -> AppResult<CapturedVersion> {
        let source = source.as_ref();
        if fs::symlink_metadata(source)
            .map_err(io_error)?
            .file_type()
            .is_symlink()
        {
            return Err(invalid("source symlink"));
        }
        let mut entries = Vec::new();
        self.collect(source, source, &mut entries)?;
        entries.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
        let manifest = VersionManifest {
            format_version: 1,
            skill_id,
            tree_hash: manifest::tree_hash(&entries),
            entries,
        };
        let id = manifest::version_id(&manifest);
        let dir = self.paths.versions_dir.join(skill_id.to_string());
        fs::create_dir_all(&dir).map_err(io_error)?;
        let path = dir.join(format!("{}.json", digest_name(&id)));
        if path.exists() {
            let existing = self.load_manifest(&id)?;
            return Ok(CapturedVersion {
                created: false,
                record: VersionRecord {
                    id,
                    manifest: existing,
                },
            });
        }
        let tmp = object_store::unique_temp(&dir, ".manifest")?;
        fs::write(&tmp, to_vec_pretty(&manifest).map_err(json_error)?).map_err(io_error)?;
        let created = if let Err(error) = fs::hard_link(&tmp, &path) {
            let _ = fs::remove_file(&tmp);
            if !path.exists() {
                return Err(io_error(error));
            }
            false
        } else {
            true
        };
        let _ = fs::remove_file(&tmp);
        Ok(CapturedVersion {
            created,
            record: VersionRecord { id, manifest },
        })
    }

    pub fn materialize(&self, id: &VersionId, output: impl AsRef<Path>) -> AppResult<()> {
        let manifest = self.load_manifest(id)?;
        let output = output.as_ref();
        if output.exists()
            && fs::symlink_metadata(output)
                .map_err(io_error)?
                .file_type()
                .is_symlink()
        {
            return Err(invalid("output symlink"));
        }
        fs::create_dir_all(output).map_err(io_error)?;
        for entry in &manifest.entries {
            let relative = safe_relative(&entry.path)?;
            let target = output.join(relative);
            let mut parent = output.to_path_buf();
            let component_count = Path::new(&entry.path).components().count();
            for (index, component) in Path::new(&entry.path).components().enumerate() {
                if index + 1 == component_count {
                    break;
                }
                if let Component::Normal(name) = component {
                    parent.push(name);
                    if parent.exists() {
                        let metadata = fs::symlink_metadata(&parent).map_err(io_error)?;
                        if metadata.file_type().is_symlink() || !metadata.is_dir() {
                            return Err(invalid("output path escape"));
                        }
                    } else {
                        fs::create_dir(&parent).map_err(io_error)?;
                    }
                }
            }
            if target.exists() {
                return Err(invalid("output file exists"));
            }
            let bytes = object_store::get(&self.paths.objects_dir, &entry.object_id, entry.size)?;
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(io_error)?;
            file.write_all(&bytes).map_err(io_error)?;
        }
        Ok(())
    }

    /// Reads one immutable version object after validating the manifest and
    /// enforcing a caller-provided size limit. The path is always relative to
    /// the version tree; no filesystem path supplied by a caller is opened.
    pub fn read_file(
        &self,
        id: &VersionId,
        path: &str,
        max_bytes: u64,
    ) -> AppResult<(String, Vec<u8>)> {
        let relative = safe_relative(path)?;
        let manifest = self.load_manifest(id)?;
        let entry = manifest
            .entries
            .iter()
            .find(|entry| entry.path == relative.to_string_lossy())
            .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
        if entry.size > max_bytes {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "markdown_size")
                .with_param("reason", "size_limit")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        let bytes = object_store::get(&self.paths.objects_dir, &entry.object_id, entry.size)?;
        Ok((entry.object_id.clone(), bytes))
    }

    /// Lists Markdown files recorded in an immutable version manifest.
    pub fn list_markdown_files(&self, id: &VersionId) -> AppResult<Vec<String>> {
        let manifest = self.load_manifest(id)?;
        Ok(manifest
            .entries
            .into_iter()
            .filter(|entry| {
                Path::new(&entry.path)
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
            })
            .map(|entry| entry.path)
            .collect())
    }

    pub fn diff(&self, left: &VersionId, right: &VersionId) -> AppResult<VersionDiff> {
        let a = self.load_manifest(left)?;
        let b = self.load_manifest(right)?;
        if a.skill_id != b.skill_id {
            return Err(invalid("versions belong to different skills"));
        }
        let ma: BTreeMap<_, _> = a.entries.into_iter().map(|e| (e.path.clone(), e)).collect();
        let mb: BTreeMap<_, _> = b.entries.into_iter().map(|e| (e.path.clone(), e)).collect();
        let mut result = VersionDiff::default();
        for key in ma.keys().chain(mb.keys()).collect::<BTreeSet<_>>() {
            match (ma.get(key), mb.get(key)) {
                (None, Some(_)) => result.added.push((*key).clone()),
                (Some(_), None) => result.removed.push((*key).clone()),
                (Some(x), Some(y)) if x.object_id != y.object_id => {
                    result.changed.push((*key).clone())
                }
                _ => {}
            }
        }
        Ok(result)
    }

    pub fn set_current(&self, skill_id: SkillId, id: &VersionId) -> AppResult<()> {
        let manifest = self.load_manifest(id)?;
        if manifest.skill_id != skill_id {
            return Err(invalid("version does not belong to skill"));
        }
        let dir = self.paths.metadata_dir.join(skill_id.to_string());
        fs::create_dir_all(&dir).map_err(io_error)?;
        let tmp = object_store::unique_temp(&dir, ".current")?;
        fs::write(&tmp, id.as_str()).map_err(io_error)?;
        let target = dir.join("current");
        replace_current_file(&tmp, &target)?;
        Ok(())
    }

    pub fn clear_current(&self, skill_id: SkillId) -> AppResult<()> {
        let path = self
            .paths
            .metadata_dir
            .join(skill_id.to_string())
            .join("current");
        if path.exists() {
            fs::remove_file(path).map_err(io_error)?;
        }
        Ok(())
    }

    pub fn current(&self, skill_id: SkillId) -> AppResult<Option<VersionId>> {
        let path = self
            .paths
            .metadata_dir
            .join(skill_id.to_string())
            .join("current");
        if !path.exists() {
            return Ok(None);
        }
        let text = fs::read_to_string(path).map_err(io_error)?;
        let id = VersionId::parse(text.trim()).map_err(|_| invalid("current version"))?;
        let manifest = self.load_manifest(&id)?;
        if manifest.skill_id != skill_id {
            return Err(invalid("current version skill"));
        }
        Ok(Some(id))
    }

    pub fn load_manifest(&self, id: &VersionId) -> AppResult<VersionManifest> {
        let text = fs::read_to_string(self.find_manifest(id)?).map_err(io_error)?;
        let manifest: VersionManifest = serde_json::from_str(&text).map_err(json_error)?;
        let mut sorted = manifest.entries.clone();
        for entry in &manifest.entries {
            if entry.path.contains('\\')
                || normalize_relative(Path::new(&entry.path))? != entry.path
            {
                return Err(invalid("manifest path canonicality"));
            }
            if skillhub_core::VersionId::parse(&entry.object_id).is_err() {
                return Err(invalid("manifest object id"));
            }
        }
        sorted.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
        if sorted != manifest.entries
            || sorted.windows(2).any(|pair| pair[0].path == pair[1].path)
            || manifest::tree_hash(&manifest.entries) != manifest.tree_hash
            || manifest::version_id(&manifest) != *id
        {
            return Err(invalid("manifest integrity"));
        }
        Ok(manifest)
    }

    pub fn save_manifest(&self, id: &VersionId, _manifest: &VersionManifest) -> AppResult<()> {
        if self.find_manifest(id).is_ok() {
            return Err(invalid("immutable manifest"));
        }
        Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error))
    }

    pub fn object_count_for_bytes(&self, bytes: &[u8]) -> AppResult<usize> {
        let id = manifest::digest_bytes(bytes);
        Ok(usize::from(
            self.paths
                .objects_dir
                .join(id.strip_prefix("sha256:").unwrap())
                .exists(),
        ))
    }

    #[doc(hidden)]
    pub fn objects_path_for_test(&self) -> &Path {
        &self.paths.objects_dir
    }

    #[doc(hidden)]
    pub fn manifest_path_for_test(&self, skill_id: SkillId, id: &VersionId) -> PathBuf {
        self.paths
            .versions_dir
            .join(skill_id.to_string())
            .join(format!("{}.json", digest_name(id)))
    }

    pub fn hash_tree(&self, root: impl AsRef<Path>) -> AppResult<String> {
        let mut entries = Vec::new();
        self.collect(root.as_ref(), root.as_ref(), &mut entries)?;
        entries.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
        Ok(manifest::tree_hash(&entries))
    }

    fn find_manifest(&self, id: &VersionId) -> AppResult<PathBuf> {
        for skill in fs::read_dir(&self.paths.versions_dir).map_err(io_error)? {
            let dir = skill.map_err(io_error)?.path();
            let candidate = dir.join(format!("{}.json", digest_name(id)));
            if candidate.exists() {
                return Ok(candidate);
            }
        }
        Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error))
    }

    pub fn list(&self, skill_id: SkillId) -> AppResult<Vec<VersionRecord>> {
        let dir = self.paths.versions_dir.join(skill_id.to_string());
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut versions = Vec::new();
        for item in fs::read_dir(dir).map_err(io_error)? {
            let path = item.map_err(io_error)?.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|x| x.to_str())
                .ok_or_else(|| invalid("version filename"))?;
            let id = VersionId::parse(&format!("sha256:{stem}"))
                .map_err(|_| invalid("version filename"))?;
            let manifest = self.load_manifest(&id)?;
            if manifest.skill_id != skill_id {
                return Err(invalid("version does not belong to skill"));
            }
            versions.push(VersionRecord { id, manifest });
        }
        versions.sort_by(|a, b| a.id.as_str().cmp(b.id.as_str()));
        Ok(versions)
    }

    fn collect(&self, root: &Path, current: &Path, entries: &mut Vec<FileEntry>) -> AppResult<()> {
        for item in fs::read_dir(current).map_err(io_error)? {
            let item = item.map_err(io_error)?;
            let path = item.path();
            let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
            if metadata.file_type().is_symlink() {
                return Err(invalid("symlink"));
            }
            if metadata.is_dir() {
                self.collect(root, &path, entries)?;
                continue;
            }
            if !metadata.is_file() {
                return Err(invalid("unsupported file"));
            }
            let relative = path.strip_prefix(root).map_err(|_| invalid("path"))?;
            let normalized = normalize_relative(relative)?;
            let bytes = fs::read(&path).map_err(io_error)?;
            let object_id = object_store::put(&self.paths.objects_dir, &bytes)?;
            entries.push(FileEntry {
                path: normalized,
                object_id,
                size: bytes.len() as u64,
                executable: false,
            });
        }
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_current_file(source: &Path, target: &Path) -> AppResult<()> {
    fs::rename(source, target).map_err(io_error)
}

#[cfg(windows)]
fn replace_current_file(source: &Path, target: &Path) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let target: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(AppError::new(ErrorCode::InternalError, Severity::Error)
            .with_action(RecoveryAction::Retry));
    }
    Ok(())
}

fn normalize_relative(path: &Path) -> AppResult<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().replace('\\', "/")),
            _ => return Err(invalid("relative path")),
        }
    }
    if parts.is_empty() {
        return Err(invalid("relative path"));
    }
    Ok(parts.join("/"))
}
fn safe_relative(path: &str) -> AppResult<PathBuf> {
    let p = Path::new(path);
    let normalized = normalize_relative(p)?;
    if normalized != path.replace('\\', "/") {
        return Err(invalid("canonical path"));
    }
    Ok(PathBuf::from(normalized))
}
fn invalid(field: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error)
        .with_param("field", field)
        .with_action(RecoveryAction::ChooseAnotherName)
}
fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
fn json_error(error: serde_json::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
fn digest_name(id: &VersionId) -> &str {
    id.as_str().strip_prefix("sha256:").unwrap_or(id.as_str())
}
