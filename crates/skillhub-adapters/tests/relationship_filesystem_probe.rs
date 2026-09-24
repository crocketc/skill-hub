//! Task 5A 红灯：文件系统关系探测的原始分类（plan 5.8/5.9）。
//!
//! 只有"父容器在线且可枚举 + 目标明确 NotFound"才允许返回
//! MissingWithAccessibleParent；权限、离线卷、UNC、超时一律降级为
//! 非归档类别。reparse point（junction/符号链接）按链接自身持有身份。

use skillhub_adapters::relationship::{categorize_io_error, FilesystemRelationshipProbe};
use skillhub_core::physical_id_for_path;
use skillhub_core::relationship::{PlatformFsErrorCategory, RelationshipPathProbe};
use std::io::ErrorKind;

#[test]
fn accessible_directory_reports_stable_identity() {
    let workspace = tempfile::tempdir().expect("workspace");
    let dir = workspace.path().join("notes");
    std::fs::create_dir(&dir).expect("create dir");
    let probe = FilesystemRelationshipProbe.probe(&dir);
    match probe {
        RelationshipPathProbe::Accessible { physical_source_id } => {
            assert_eq!(physical_source_id, physical_id_for_path(&dir));
        }
        other => panic!("expected accessible directory, got {other:?}"),
    }
}

#[test]
fn missing_target_with_live_parent_is_the_only_missing_verdict() {
    let workspace = tempfile::tempdir().expect("workspace");
    let dir = workspace.path().join("notes");
    std::fs::create_dir(&dir).expect("create dir");
    std::fs::remove_dir(&dir).expect("remove target only");
    assert_eq!(
        FilesystemRelationshipProbe.probe(&dir),
        RelationshipPathProbe::MissingWithAccessibleParent
    );
}

#[test]
fn missing_parent_is_reported_separately_and_never_archives() {
    let workspace = tempfile::tempdir().expect("workspace");
    let parent = workspace.path().join("gone");
    let dir = parent.join("notes");
    assert_eq!(
        FilesystemRelationshipProbe.probe(&dir),
        RelationshipPathProbe::ParentMissing
    );
}

#[test]
fn file_at_path_reports_wrong_representation() {
    let workspace = tempfile::tempdir().expect("workspace");
    let file = workspace.path().join("notes");
    std::fs::write(&file, "not a directory\n").expect("write file");
    assert_eq!(
        FilesystemRelationshipProbe.probe(&file),
        RelationshipPathProbe::WrongRepresentation
    );
}

#[test]
fn permission_denied_never_collapses_into_missing() {
    assert_eq!(
        categorize_io_error(ErrorKind::PermissionDenied, None),
        PlatformFsErrorCategory::AccessDenied
    );
}

#[test]
fn timeout_kind_maps_to_its_own_category() {
    assert_eq!(
        categorize_io_error(ErrorKind::TimedOut, None),
        PlatformFsErrorCategory::TimedOut
    );
}

#[test]
fn unknown_errors_stay_unknown_and_never_archive() {
    assert_eq!(
        categorize_io_error(ErrorKind::Other, None),
        PlatformFsErrorCategory::Unknown
    );
}

#[cfg(windows)]
#[test]
fn windows_drive_not_ready_maps_to_volume_unavailable() {
    assert_eq!(
        categorize_io_error(ErrorKind::Other, Some(21)),
        PlatformFsErrorCategory::VolumeUnavailable
    );
    assert_eq!(
        categorize_io_error(ErrorKind::Other, Some(53)),
        PlatformFsErrorCategory::VolumeUnavailable
    );
    assert_eq!(
        categorize_io_error(ErrorKind::Other, Some(121)),
        PlatformFsErrorCategory::TimedOut
    );
}

#[cfg(unix)]
#[test]
fn unix_dead_device_maps_to_volume_unavailable() {
    assert_eq!(
        categorize_io_error(ErrorKind::Other, Some(19)),
        PlatformFsErrorCategory::VolumeUnavailable
    );
}
