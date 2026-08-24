use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use skillhub_core::source::{
    AcquiredSource, AcquisitionError, AcquisitionErrorCode, AcquisitionLimits, AcquisitionResult,
    AcquisitionWorkspace,
};
use tar::Archive;
use zip::ZipArchive;

pub struct ArchiveExtractor {
    limits: AcquisitionLimits,
}

impl ArchiveExtractor {
    pub fn new(limits: AcquisitionLimits) -> Self {
        Self { limits }
    }

    pub fn limits(&self) -> &AcquisitionLimits {
        &self.limits
    }

    pub fn extract(&self, archive: impl AsRef<Path>) -> AcquisitionResult<AcquiredSource> {
        let mut workspace = AcquisitionWorkspace::new()?;
        workspace.begin()?;
        match self.extract_into_workspace(archive.as_ref(), &mut workspace) {
            Ok((entries, bytes)) => Ok(AcquiredSource::new(workspace, entries, bytes)),
            Err(error) => {
                let _ = workspace.cleanup();
                Err(error)
            }
        }
    }

    pub fn extract_into(
        &self,
        archive: impl AsRef<Path>,
        workspace: &AcquisitionWorkspace,
    ) -> AcquisitionResult<()> {
        if !workspace.is_available() {
            return Err(AcquisitionError::new(
                AcquisitionErrorCode::WorkspaceUnavailable,
                "acquisition workspace has already been consumed",
            ));
        }
        workspace.begin()?;
        // This API is intentionally single-use. Extraction owns cleanup on error;
        // callers retain the workspace only to inspect the failed root.
        let mut workspace = WorkspaceRef::new(workspace);
        match self.extract_into_workspace(archive.as_ref(), &mut workspace) {
            Ok(_) => Ok(()),
            Err(error) => {
                let _ = fs::remove_dir_all(workspace.root());
                Err(error)
            }
        }
    }

    fn extract_into_workspace(
        &self,
        archive: &Path,
        workspace: &mut impl ExtractionRoot,
    ) -> AcquisitionResult<(u64, u64)> {
        let file = File::open(archive).map_err(io_error)?;
        let format = detect_format(archive);
        match format {
            ArchiveFormat::Zip => self.extract_zip(file, workspace),
            ArchiveFormat::Tar => self.extract_tar(file, workspace),
            ArchiveFormat::Unknown => Err(AcquisitionError::new(
                AcquisitionErrorCode::ArchiveFormatInvalid,
                "archive is neither a supported ZIP nor TAR file",
            )),
        }
    }

    fn extract_zip(
        &self,
        file: File,
        workspace: &mut impl ExtractionRoot,
    ) -> AcquisitionResult<(u64, u64)> {
        let mut archive = ZipArchive::new(file).map_err(|error| {
            AcquisitionError::new(
                AcquisitionErrorCode::ArchiveFormatInvalid,
                error.to_string(),
            )
        })?;
        let mut entries: u64 = 0;
        let mut expanded = 0;
        for index in 0..archive.len() {
            entries = entries.checked_add(1).ok_or_else(|| {
                AcquisitionError::new(
                    AcquisitionErrorCode::ArchiveEntryLimit,
                    "archive entry count overflowed",
                )
            })?;
            self.check_entry_limit(entries)?;
            let mut entry = archive.by_index(index).map_err(|error| {
                AcquisitionError::new(
                    AcquisitionErrorCode::ArchiveFormatInvalid,
                    error.to_string(),
                )
            })?;
            let relative = safe_archive_path(entry.name())?;
            if entry.is_symlink() || entry.unix_mode().is_some_and(is_symlink_mode) {
                return Err(path_escape(
                    "symbolic links are not accepted in source archives",
                ));
            }
            let target = workspace.root().join(relative);
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(io_error)?;
                continue;
            }
            let size = entry.size();
            if size > self.limits.max_file_bytes {
                return Err(AcquisitionError::new(
                    AcquisitionErrorCode::ArchiveFileSizeLimit,
                    "archive file exceeds the per-file limit",
                ));
            }
            let parent = target
                .parent()
                .ok_or_else(|| path_escape("archive entry has no parent"))?;
            fs::create_dir_all(parent).map_err(io_error)?;
            let mut output = create_new_file(&target)?;
            expanded = self.copy_bounded(&mut entry, &mut output, expanded)?;
        }
        Ok((entries, expanded))
    }

    fn extract_tar(
        &self,
        file: File,
        workspace: &mut impl ExtractionRoot,
    ) -> AcquisitionResult<(u64, u64)> {
        let mut archive = Archive::new(file);
        let mut entries: u64 = 0;
        let mut expanded = 0;
        let iter = archive.entries().map_err(io_error)?;
        for item in iter {
            entries = entries.checked_add(1).ok_or_else(|| {
                AcquisitionError::new(
                    AcquisitionErrorCode::ArchiveEntryLimit,
                    "archive entry count overflowed",
                )
            })?;
            self.check_entry_limit(entries)?;
            let mut entry = item.map_err(io_error)?;
            let entry_type = entry.header().entry_type();
            if entry_type.is_symlink() || entry_type.is_hard_link() {
                // Links are rejected before the archive library can materialize them.
                return Err(path_escape("links are not accepted in source archives"));
            }
            let raw_path = entry.path().map_err(io_error)?.to_path_buf();
            let relative = safe_archive_path(&raw_path.to_string_lossy())?;
            let target = workspace.root().join(relative);
            if entry_type.is_dir() {
                fs::create_dir_all(&target).map_err(io_error)?;
                continue;
            }
            let size = entry.header().size().map_err(io_error)?;
            if size > self.limits.max_file_bytes {
                return Err(AcquisitionError::new(
                    AcquisitionErrorCode::ArchiveFileSizeLimit,
                    "archive file exceeds the per-file limit",
                ));
            }
            let parent = target
                .parent()
                .ok_or_else(|| path_escape("archive entry has no parent"))?;
            fs::create_dir_all(parent).map_err(io_error)?;
            let mut output = create_new_file(&target)?;
            expanded = self.copy_bounded(&mut entry, &mut output, expanded)?;
        }
        Ok((entries, expanded))
    }

    fn copy_bounded(
        &self,
        input: &mut impl Read,
        output: &mut File,
        mut expanded: u64,
    ) -> AcquisitionResult<u64> {
        let mut buffer = [0_u8; 8192];
        loop {
            let read = input.read(&mut buffer).map_err(io_error)?;
            if read == 0 {
                return Ok(expanded);
            }
            let read_len = read;
            let read = u64::try_from(read_len).map_err(|_| {
                AcquisitionError::new(
                    AcquisitionErrorCode::ExpandedSizeLimit,
                    "expanded archive size overflowed",
                )
            })?;
            expanded = expanded.checked_add(read).ok_or_else(|| {
                AcquisitionError::new(
                    AcquisitionErrorCode::ExpandedSizeLimit,
                    "expanded archive size overflowed",
                )
            })?;
            if expanded > self.limits.max_expanded_bytes {
                return Err(AcquisitionError::new(
                    AcquisitionErrorCode::ExpandedSizeLimit,
                    "expanded archive content exceeds the configured limit",
                ));
            }
            std::io::Write::write_all(output, &buffer[..read_len]).map_err(io_error)?;
        }
    }

    fn check_entry_limit(&self, entries: u64) -> AcquisitionResult<()> {
        if entries > self.limits.max_entries {
            return Err(AcquisitionError::new(
                AcquisitionErrorCode::ArchiveEntryLimit,
                "archive contains too many entries",
            ));
        }
        Ok(())
    }
}

struct WorkspaceRef<'a> {
    workspace: &'a AcquisitionWorkspace,
}

impl<'a> WorkspaceRef<'a> {
    fn new(workspace: &'a AcquisitionWorkspace) -> Self {
        Self { workspace }
    }
}

trait ExtractionRoot {
    fn root(&self) -> &Path;
}

impl ExtractionRoot for AcquisitionWorkspace {
    fn root(&self) -> &Path {
        self.root()
    }
}

impl ExtractionRoot for WorkspaceRef<'_> {
    fn root(&self) -> &Path {
        self.workspace.root()
    }
}

#[derive(Clone, Copy)]
enum ArchiveFormat {
    Zip,
    Tar,
    Unknown,
}

fn detect_format(path: &Path) -> ArchiveFormat {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("zip") => ArchiveFormat::Zip,
        Some(extension) if extension.eq_ignore_ascii_case("tar") => ArchiveFormat::Tar,
        _ => ArchiveFormat::Unknown,
    }
}

fn safe_archive_path(raw: &str) -> AcquisitionResult<PathBuf> {
    if raw.is_empty() || raw.contains('\0') {
        return Err(path_escape("archive entry path is empty or contains a NUL"));
    }
    let normalized = raw.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.starts_with("//")
        || normalized.starts_with("\\\\")
        || normalized.starts_with("\\.\\")
        || normalized.starts_with("\\?\\")
        || has_windows_drive_prefix(&normalized)
    {
        return Err(path_escape(
            "archive entry path is absolute or device-qualified",
        ));
    }
    let mut path = PathBuf::new();
    for component in normalized.split('/') {
        match component {
            "" | "." => {}
            ".." => return Err(path_escape("archive entry escapes extraction root")),
            value if value.contains(':') || is_windows_device_component(value) => {
                return Err(path_escape(
                    "archive entry contains a drive or device prefix",
                ))
            }
            value => path.push(value),
        }
    }
    if path.as_os_str().is_empty()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(path_escape("archive entry escapes extraction root"));
    }
    Ok(path)
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn is_windows_device_component(value: &str) -> bool {
    let stem = value
        .split_once('.')
        .map_or(value, |(stem, _)| stem)
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

fn is_symlink_mode(mode: u32) -> bool {
    mode & 0o170000 == 0o120000
}

fn create_new_file(path: &Path) -> AcquisitionResult<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io_error)
}

fn path_escape(message: impl Into<String>) -> AcquisitionError {
    AcquisitionError::new(AcquisitionErrorCode::ArchivePathEscape, message)
}

fn io_error(error: impl std::fmt::Display) -> AcquisitionError {
    AcquisitionError::new(AcquisitionErrorCode::AcquisitionIo, error.to_string())
}
