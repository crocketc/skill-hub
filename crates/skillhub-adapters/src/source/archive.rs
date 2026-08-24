use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
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
            Err(error) => Err(cleanup_error(&mut workspace, error)),
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
            Err(error) => match workspace.cleanup_root() {
                Ok(()) => Err(error),
                Err(cleanup) => Err(error.with_cleanup_failure(&cleanup)),
            },
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
        let expected_entries = validate_zip_entry_count(&file, self.limits.max_entries)?;
        let mut archive = ZipArchive::new(file).map_err(|error| {
            AcquisitionError::new(
                AcquisitionErrorCode::ArchiveFormatInvalid,
                error.to_string(),
            )
        })?;
        if archive.len() as u64 != expected_entries {
            return Err(format_error(
                "ZIP central directory does not match its validated EOCD entry count",
            ));
        }
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

    fn cleanup_root(&self) -> AcquisitionResult<()> {
        self.workspace.cleanup_root()
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
            value if value.ends_with([' ', '.']) => {
                return Err(path_escape(
                    "archive entry contains a trailing Windows space or dot",
                ))
            }
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
    let value = value.trim_end_matches([' ', '.']);
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

fn cleanup_error(
    workspace: &mut AcquisitionWorkspace,
    error: AcquisitionError,
) -> AcquisitionError {
    match workspace.cleanup() {
        Ok(()) => error,
        Err(cleanup) => error.with_cleanup_failure(&cleanup),
    }
}

fn validate_zip_entry_count(file: &File, max_entries: u64) -> AcquisitionResult<u64> {
    const EOCD_SIGNATURE: [u8; 4] = *b"PK\x05\x06";
    const EOCD_LEN: usize = 22;
    const MAX_COMMENT: usize = u16::MAX as usize;

    let length = file.metadata().map_err(io_error)?.len();
    if length < EOCD_LEN as u64 {
        return Err(format_error(
            "ZIP end-of-central-directory record is truncated",
        ));
    }
    let tail_len = usize::try_from(length.min((EOCD_LEN + MAX_COMMENT) as u64))
        .map_err(|_| format_error("ZIP tail length overflowed"))?;
    let start = length.saturating_sub(tail_len as u64);
    let mut tail = vec![0_u8; tail_len];
    let mut reader = file.try_clone().map_err(io_error)?;
    reader.seek(SeekFrom::Start(start)).map_err(io_error)?;
    reader.read_exact(&mut tail).map_err(io_error)?;
    let mut selected_layout = None;
    for offset in (0..=tail.len().saturating_sub(EOCD_LEN)).rev() {
        if !tail[offset..].starts_with(&EOCD_SIGNATURE)
            || offset
                .saturating_add(EOCD_LEN)
                .saturating_add(u16::from_le_bytes([tail[offset + 20], tail[offset + 21]]) as usize)
                != tail.len()
        {
            continue;
        }
        let absolute = start + offset as u64;
        let count = u16::from_le_bytes([tail[offset + 10], tail[offset + 11]]);
        let size = u32::from_le_bytes(tail[offset + 12..offset + 16].try_into().unwrap());
        let directory_offset =
            u32::from_le_bytes(tail[offset + 16..offset + 20].try_into().unwrap());
        let zip64_sentinel = count == u16::MAX || size == u32::MAX || directory_offset == u32::MAX;
        if !zip64_sentinel {
            check_zip_entry_count(count as u64, max_entries)?;
            if central_directory_is_valid(
                file,
                absolute,
                count as u64,
                u64::from(size),
                u64::from(directory_offset),
            )? {
                selected_layout = Some((
                    count as u64,
                    u64::from(size),
                    u64::from(directory_offset),
                    absolute,
                ));
                break;
            }
        } else if let Some(layout) = read_zip64_layout(file, absolute, length)? {
            check_zip_entry_count(layout.0, max_entries)?;
            if central_directory_is_valid(file, layout.3, layout.0, layout.1, layout.2)? {
                selected_layout = Some(layout);
                break;
            }
        }
    }
    let (count, _, _, _) = selected_layout.ok_or_else(|| {
        format_error("ZIP end-of-central-directory record is missing or truncated")
    })?;
    Ok(count)
}

fn central_directory_is_valid(
    file: &File,
    eocd_offset: u64,
    count: u64,
    directory_size: u64,
    directory_offset: u64,
) -> AcquisitionResult<bool> {
    if count == 0 {
        return Ok(directory_size == 0 && directory_offset == 0);
    }
    let directory_end = directory_offset.saturating_add(directory_size);
    if directory_size < 46 || directory_end != eocd_offset {
        return Ok(false);
    }
    let mut reader = file.try_clone().map_err(io_error)?;
    reader
        .seek(SeekFrom::Start(directory_offset))
        .map_err(io_error)?;
    let mut consumed = 0_u64;
    for _ in 0..count {
        let mut header = [0_u8; 46];
        reader.read_exact(&mut header).map_err(|error| {
            format_error(format!(
                "ZIP central directory header is truncated: {error}"
            ))
        })?;
        if header[..4] != *b"PK\x01\x02" {
            return Ok(false);
        }
        let name_len = u16::from_le_bytes(header[28..30].try_into().unwrap()) as u64;
        let extra_len = u16::from_le_bytes(header[30..32].try_into().unwrap()) as u64;
        let comment_len = u16::from_le_bytes(header[32..34].try_into().unwrap()) as u64;
        let record_len = 46_u64
            .saturating_add(name_len)
            .saturating_add(extra_len)
            .saturating_add(comment_len);
        consumed = consumed.saturating_add(record_len);
        if consumed > directory_size {
            return Ok(false);
        }
        reader
            .seek(SeekFrom::Current(
                (name_len + extra_len + comment_len) as i64,
            ))
            .map_err(io_error)?;
    }
    Ok(consumed == directory_size)
}

fn read_zip64_layout(
    file: &File,
    eocd_offset: u64,
    archive_length: u64,
) -> AcquisitionResult<Option<(u64, u64, u64, u64)>> {
    const ZIP64_LOCATOR_SIGNATURE: [u8; 4] = *b"PK\x06\x07";
    const ZIP64_EOCD_SIGNATURE: [u8; 4] = *b"PK\x06\x06";
    if eocd_offset < 20 {
        return Ok(None);
    }
    let locator_offset = eocd_offset - 20;
    let mut locator = [0_u8; 20];
    read_at(file, locator_offset, &mut locator)?;
    if locator[..4] != ZIP64_LOCATOR_SIGNATURE {
        return Ok(None);
    }
    let zip64_offset = u64::from_le_bytes(locator[8..16].try_into().unwrap());
    if zip64_offset > archive_length || archive_length - zip64_offset < 56 {
        return Ok(None);
    }
    let mut zip64 = [0_u8; 56];
    read_at(file, zip64_offset, &mut zip64)?;
    if zip64[..4] != ZIP64_EOCD_SIGNATURE {
        return Ok(None);
    }
    let zip64_size = u64::from_le_bytes(zip64[4..12].try_into().unwrap());
    if zip64_size < 44
        || zip64_offset.saturating_add(12).saturating_add(zip64_size) != locator_offset
    {
        return Ok(None);
    }
    Ok(Some((
        u64::from_le_bytes(zip64[32..40].try_into().unwrap()),
        u64::from_le_bytes(zip64[40..48].try_into().unwrap()),
        u64::from_le_bytes(zip64[48..56].try_into().unwrap()),
        zip64_offset,
    )))
}

fn read_at(file: &File, offset: u64, buffer: &mut [u8]) -> AcquisitionResult<()> {
    let mut reader = file.try_clone().map_err(io_error)?;
    reader.seek(SeekFrom::Start(offset)).map_err(io_error)?;
    reader
        .read_exact(buffer)
        .map_err(|error| format_error(format!("ZIP metadata is truncated: {error}")))
}

fn check_zip_entry_count(count: u64, max_entries: u64) -> AcquisitionResult<()> {
    if count > max_entries {
        return Err(AcquisitionError::new(
            AcquisitionErrorCode::ArchiveEntryLimit,
            "archive contains too many entries",
        ));
    }
    Ok(())
}

fn format_error(message: impl Into<String>) -> AcquisitionError {
    AcquisitionError::new(AcquisitionErrorCode::ArchiveFormatInvalid, message)
}
