//! Governable-relation filesystem probe (plan Task 5A).
//!
//! The probe only reports what the filesystem shows for a relation's source
//! path. Business verdicts (managed occupancy, fingerprint comparison,
//! archiving decisions) belong to the application-layer validation service;
//! this module never decides whether a relation survives.
//!
//! The MissingWithAccessibleParent verdict is deliberately hard to reach:
//! it requires the parent container to be online and enumerable while the
//! target itself is verifiably absent. Everything else — permission walls,
//! offline volumes, UNC paths, timers — degrades to a non-archiving
//! classification so a transient failure can never archive a relation.

use skillhub_core::relationship::{
    FileRepresentation, PlatformFsErrorCategory, RelationshipPathProbe,
};
use skillhub_core::{physical_id_for_path, reparse_physical_id_for_path};
use std::io::ErrorKind;
use std::path::Path;

/// Probes a relation's source path and returns the raw filesystem
/// classification with a reparse-aware physical identity.
pub struct FilesystemRelationshipProbe;

impl FilesystemRelationshipProbe {
    pub fn probe(&self, path: impl AsRef<Path>) -> RelationshipPathProbe {
        let path = path.as_ref();
        match std::fs::metadata(path) {
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return RelationshipPathProbe::WrongRepresentation;
                }
                RelationshipPathProbe::Accessible {
                    physical_source_id: directory_identity(path),
                }
            }
            Err(error) => classify_lookup_error(path, &error),
        }
    }

    /// 表示推导（#10 第 4 项，2026-10-07 定稿）：只报告文件系统事实，
    /// 不做业务裁决。目录条目返回 `Directory`；Windows reparse 目录按
    /// SkillHub 自建部署的 junction 形态记为 `DirectoryJunction`（保守：
    /// 表示不可校验即受阻），Unix 符号链接目录返回 `SymbolicLink`；
    /// 不可读、非目录一律 `Unknown`（不猜，等待下一次探测）。
    pub fn directory_representation(&self, path: impl AsRef<Path>) -> FileRepresentation {
        let path = path.as_ref();
        let Ok(metadata) = std::fs::symlink_metadata(path) else {
            return FileRepresentation::Unknown;
        };
        if is_reparse_metadata(&metadata) {
            // 链接型条目（symlink_metadata.is_dir() 为 false）：只有指向
            // 目录的链接才是链接表示，文件链接不猜。
            return match std::fs::metadata(path) {
                Ok(target) if target.is_dir() => {
                    if cfg!(windows) {
                        FileRepresentation::DirectoryJunction
                    } else {
                        FileRepresentation::SymbolicLink
                    }
                }
                _ => FileRepresentation::Unknown,
            };
        }
        if metadata.is_dir() {
            FileRepresentation::Directory
        } else {
            FileRepresentation::Unknown
        }
    }
}

/// Reparse-aware identity: a junction or symlink directory is owned as the
/// link itself (plan 5.9), so replacing its resolution target cannot be
/// mistaken for the relation's directory disappearing.
fn directory_identity(path: &Path) -> Option<String> {
    let is_reparse = std::fs::symlink_metadata(path)
        .map(|metadata| is_reparse_metadata(&metadata))
        .unwrap_or(false);
    if is_reparse {
        reparse_physical_id_for_path(path).or_else(|| physical_id_for_path(path))
    } else {
        physical_id_for_path(path)
    }
}

#[cfg(windows)]
fn is_reparse_metadata(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes()
        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0
}

#[cfg(not(windows))]
fn is_reparse_metadata(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// A target lookup failed. Only an enumerable parent with the target verifiably
/// absent counts as a true removal; every parent-level failure keeps the
/// relation's fate undecided.
fn classify_lookup_error(path: &Path, error: &std::io::Error) -> RelationshipPathProbe {
    if error.kind() == ErrorKind::NotFound {
        let Some(parent) = path.parent() else {
            return RelationshipPathProbe::TimeoutOrUnknown;
        };
        return match std::fs::read_dir(parent) {
            Ok(_) => RelationshipPathProbe::MissingWithAccessibleParent,
            Err(parent_error) => {
                if parent_error.kind() == ErrorKind::NotFound {
                    RelationshipPathProbe::ParentMissing
                } else {
                    error_probe(&parent_error)
                }
            }
        };
    }
    error_probe(error)
}

fn error_probe(error: &std::io::Error) -> RelationshipPathProbe {
    match categorize_io_error(error.kind(), error.raw_os_error()) {
        PlatformFsErrorCategory::AccessDenied => RelationshipPathProbe::PermissionDenied,
        PlatformFsErrorCategory::VolumeUnavailable => {
            RelationshipPathProbe::DriveOrVolumeUnavailable
        }
        PlatformFsErrorCategory::TimedOut | PlatformFsErrorCategory::Unknown => {
            RelationshipPathProbe::TimeoutOrUnknown
        }
    }
}

/// Pure OS-error classifier: permission walls and offline volumes must never
/// collapse into a missing verdict, so they get their own categories.
pub fn categorize_io_error(kind: ErrorKind, raw_os_error: Option<i32>) -> PlatformFsErrorCategory {
    if let Some(raw) = raw_os_error {
        #[cfg(windows)]
        {
            const ERROR_NOT_READY: i32 = 21;
            const ERROR_BAD_NETPATH: i32 = 53;
            const ERROR_NETNAME_DELETED: i32 = 64;
            const ERROR_SEM_TIMEOUT: i32 = 121;
            const ERROR_NETWORK_UNREACHABLE: i32 = 1231;
            const ERROR_NOT_CONNECTED: i32 = 2250;
            match raw {
                ERROR_NOT_READY
                | ERROR_BAD_NETPATH
                | ERROR_NETNAME_DELETED
                | ERROR_NETWORK_UNREACHABLE
                | ERROR_NOT_CONNECTED => return PlatformFsErrorCategory::VolumeUnavailable,
                ERROR_SEM_TIMEOUT => return PlatformFsErrorCategory::TimedOut,
                _ => {}
            }
        }
        #[cfg(unix)]
        {
            // EIO, ENXIO, ENODEV, ENOLINK: the backing device or link is gone
            // (unmounted removable volume, detached network location).
            const EIO: i32 = 5;
            const ENXIO: i32 = 6;
            const ENODEV: i32 = 19;
            const ENOLINK: i32 = 67;
            if matches!(raw, EIO | ENXIO | ENODEV | ENOLINK) {
                return PlatformFsErrorCategory::VolumeUnavailable;
            }
        }
        let _ = raw;
    }
    match kind {
        ErrorKind::PermissionDenied => PlatformFsErrorCategory::AccessDenied,
        ErrorKind::TimedOut => PlatformFsErrorCategory::TimedOut,
        _ => PlatformFsErrorCategory::Unknown,
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::{directory_identity, is_reparse_metadata};
    use crate::deployment::{create_junction, remove_junction};
    use crate::relationship::filesystem_probe::FilesystemRelationshipProbe;
    use skillhub_core::physical_id_for_path;
    use skillhub_core::relationship::{FileRepresentation, RelationshipPathProbe};

    #[test]
    fn junction_representation_is_directory_junction() {
        // #10 第 4 项：Windows reparse 目录像 SkillHub 自建部署一样按
        // DirectoryJunction 记；普通目录是 Directory；探测不到不猜。
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("source");
        let link = workspace.path().join("link");
        std::fs::create_dir(&source).expect("source");
        std::fs::write(source.join("SKILL.md"), "# notes\n").expect("skill file");
        create_junction(&source, &link).expect("create junction");
        let probe = FilesystemRelationshipProbe;
        assert_eq!(
            probe.directory_representation(&link),
            FileRepresentation::DirectoryJunction
        );
        assert_eq!(
            probe.directory_representation(&source),
            FileRepresentation::Directory
        );
        assert_eq!(
            probe.directory_representation(workspace.path().join("missing")),
            FileRepresentation::Unknown
        );
        assert_eq!(
            probe.directory_representation(workspace.path().join("source/SKILL.md")),
            FileRepresentation::Unknown,
            "非目录条目不是任何可部署表示"
        );
        remove_junction(&link).expect("remove junction");
    }

    #[test]
    fn junction_identity_is_the_link_itself_not_the_target() {
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("source");
        let link = workspace.path().join("link");
        std::fs::create_dir(&source).expect("source");
        create_junction(&source, &link).expect("create junction");
        assert!(is_reparse_metadata(
            &std::fs::symlink_metadata(&link).expect("link metadata")
        ));

        let probe = FilesystemRelationshipProbe.probe(&link);
        let RelationshipPathProbe::Accessible { physical_source_id } = probe else {
            panic!("junction must stay accessible");
        };
        let identity = physical_source_id.expect("junction identity");
        assert_ne!(Some(identity.clone()), physical_id_for_path(&source));
        assert!(identity.starts_with("reparse-"), "got {identity}");
        assert_eq!(directory_identity(&source), physical_id_for_path(&source));
        remove_junction(&link).expect("remove junction");
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::{directory_identity, FilesystemRelationshipProbe};
    use skillhub_core::physical_id_for_path;
    use skillhub_core::relationship::{FileRepresentation, RelationshipPathProbe};

    #[test]
    fn symlink_representation_is_symbolic_link() {
        // #10 第 4 项：Unix 符号链接目录按 SymbolicLink 记；普通目录是
        // Directory；探测不到不猜。
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("source");
        let link = workspace.path().join("link");
        std::fs::create_dir(&source).expect("source");
        std::fs::write(source.join("SKILL.md"), "# notes\n").expect("skill file");
        std::os::unix::fs::symlink(&source, &link).expect("symlink");
        let probe = FilesystemRelationshipProbe;
        assert_eq!(
            probe.directory_representation(&link),
            FileRepresentation::SymbolicLink
        );
        assert_eq!(
            probe.directory_representation(&source),
            FileRepresentation::Directory
        );
        assert_eq!(
            probe.directory_representation(workspace.path().join("missing")),
            FileRepresentation::Unknown
        );
        assert_eq!(
            probe.directory_representation(source.join("SKILL.md")),
            FileRepresentation::Unknown,
            "非目录条目不是任何可部署表示"
        );
    }

    #[test]
    fn symlinked_directory_identity_does_not_follow_the_link() {
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("source");
        let link = workspace.path().join("link");
        std::fs::create_dir(&source).expect("source");
        std::os::unix::fs::symlink(&source, &link).expect("symlink");

        let probe = FilesystemRelationshipProbe.probe(&link);
        let RelationshipPathProbe::Accessible { physical_source_id } = probe else {
            panic!("symlinked directory must stay accessible");
        };
        let identity = physical_source_id.expect("link identity");
        assert_ne!(Some(identity), physical_id_for_path(&source));
        assert_eq!(directory_identity(&source), physical_id_for_path(&source));
    }
}
